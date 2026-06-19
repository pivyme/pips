// The honest tier -> strike bridge (LUCKY.md §5). The slot deals a nominal multiplier tier;
// this finds the real grid strike whose live Predict multiple is closest to that tier and
// sizes the quantity so the mint cost lands at the bet. The multiple is read straight from
// the chain preview (1 / ask), so the number the UI shows is always one we can actually mint.
//
// Every chain read is a BATCH: one devInspect carries many strike/quantity probes at once. Over
// the remote node a devInspect is ~1s regardless of how many probes it bundles (the cost is the
// round trip, not the per-strike compute), so the whole solve is ~2-3 round trips instead of the
// ~12 serial probes a bisection would cost. That is what keeps a solve well inside the oracle's
// ~30s life, so the play does not expire mid-solve.
//
// solveStrike is pure: it takes a batch-preview function, never a chain handle, so it unit-tests
// in isolation. The caller (games.ts) supplies a closure bound to the live oracle + side and a
// grid from that oracle, then mints with the strike + quantity this returns.

import { DUSDC_DECIMALS, multiplier as multiplierOf } from './math.ts';
import type { TradeAmounts } from './predict.ts';

// The nominal multiplier tiers the reel can deal (LUCKY.md §4). The solver snaps a solved
// multiple back to the nearest nominal for logging + the achieved-tier report; the UI always
// shows the real solved multiple, not the nominal.
export const LUCKY_TIERS = [1.5, 2, 3, 5, 10, 25] as const;

const nearestTier = (m: number): number =>
  LUCKY_TIERS.reduce((best, t) => (Math.abs(t - m) < Math.abs(best - m) ? t : best), LUCKY_TIERS[0] as number);

export type Grid = { tick: bigint; min: bigint; max: bigint };

// One batched preview: each probe is a (strike, quantity) pair, results align to input order.
// A null result means that strike is unmintable (price rounded to zero / outside ask bounds).
export type Probe = { strike1e9: bigint; quantity: bigint };
export type BatchPreviewFn = (probes: Probe[]) => Promise<Array<TradeAmounts | null>>;

export type StrikeSolution = {
  strike1e9: bigint;
  quantity: bigint; // 6dp contracts; a settled win pays `quantity`
  entryCost: bigint; // 6dp, the real preview cost, always <= bet
  multiplier: number; // the REAL solved multiple = quantity / entryCost (what the UI shows)
  requestedTier: number;
  achievedTier: number; // nearest nominal tier to the solved multiple
  clamped: boolean; // true when the requested tier was not reachable within ask bounds
};

// How far the solved multiple may sit from the requested tier before we call it a clamp.
const CLAMP_TOLERANCE = 0.2; // 20%

const COARSE_SAMPLES = 48; // batch cost is flat to ~48 probes, so scan the whole grid in one shot
const SIZE_SAMPLES = 6; // quantity candidates bracketing the analytic estimate, sized in one shot

// n evenly spaced unique indices across [lo, hi], inclusive of both ends.
function spread(n: number, lo: number, hi: number): number[] {
  if (hi <= lo) return [lo];
  if (n >= hi - lo + 1) return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  const out: number[] = [];
  let last = -1;
  for (let j = 0; j < n; j++) {
    const i = Math.round(lo + ((hi - lo) * j) / (n - 1));
    if (i !== last) out.push(i);
    last = i;
  }
  return out;
}

export async function solveStrike(args: {
  grid: Grid;
  side: 'up' | 'down';
  tierMultiplier: number;
  betRaw: bigint;
  preview: BatchPreviewFn;
  probe?: bigint;
}): Promise<StrikeSolution> {
  const { grid, side, tierMultiplier, betRaw, preview } = args;
  const probe = args.probe ?? DUSDC_DECIMALS; // 1.0 contract, the per-unit price probe
  if (tierMultiplier <= 1) throw new Error('solveStrike: tier must be > 1');
  if (betRaw <= 0n) throw new Error('solveStrike: bet must be positive');

  // Candidate strikes one tick inside each grid edge, indexed so the per-unit multiple is
  // monotonic INCREASING in the index for either side (up: ascending strike, more OTM = bigger
  // multiple; down: descending strike). Monotonicity lets a coarse scan bracket the tier.
  const count = Number((grid.max - grid.min) / grid.tick) - 1;
  if (count <= 0) throw new Error('solveStrike: grid too small');
  const lastIdx = count - 1;
  const strikeAt = (i: number): bigint =>
    side === 'up' ? grid.min + grid.tick * BigInt(i + 1) : grid.max - grid.tick * BigInt(i + 1);
  const multOf = (a: TradeAmounts | null): number => (a && a.cost > 0n ? multiplierOf(a.cost, probe) : Infinity);

  // ---- Round 1: coarse scan across the whole grid at the probe quantity. ----
  const coarseIdx = spread(COARSE_SAMPLES, 0, lastIdx);
  const coarseAmts = await preview(coarseIdx.map((i) => ({ strike1e9: strikeAt(i), quantity: probe })));
  const coarseMul = coarseAmts.map(multOf);

  // Closest coarse sample to the tier among mintable ones, plus the mintable ceiling (the last
  // finite sample, since the multiple is monotonic in the index).
  let kBest = -1;
  let kBestErr = Infinity;
  let kMaxMintable = -1;
  for (let k = 0; k < coarseIdx.length; k++) {
    if (!Number.isFinite(coarseMul[k])) continue;
    kMaxMintable = k;
    const err = Math.abs(coarseMul[k] - tierMultiplier);
    if (err < kBestErr) {
      kBestErr = err;
      kBest = k;
    }
  }
  if (kBest < 0) throw new Error('solveStrike: no mintable strike on this grid');

  // ---- Round 2: refine within the bracket around the best coarse sample (down to one tick). ----
  // The true best global index lies between the coarse neighbours of kBest; scanning toward the
  // unmintable region too lets us land the exact mintable ceiling when the tier is unreachable.
  const loK = Math.max(kBest - 1, 0);
  const hiK = Math.min(kBest + 1, coarseIdx.length - 1);
  const loIdx = coarseIdx[loK];
  const hiIdx = coarseIdx[hiK];

  let bestIdx = coarseIdx[kBest];
  let bestProbeAmt = coarseAmts[kBest]; // probe amounts at the best coarse strike
  let bestMul = coarseMul[kBest];

  if (hiIdx - loIdx > 1) {
    const refineIdx = spread(Math.min(hiIdx - loIdx + 1, COARSE_SAMPLES), loIdx, hiIdx);
    const refineAmts = await preview(refineIdx.map((i) => ({ strike1e9: strikeAt(i), quantity: probe })));
    let rErr = Infinity;
    for (let r = 0; r < refineIdx.length; r++) {
      const m = multOf(refineAmts[r]);
      if (!Number.isFinite(m)) continue;
      const err = Math.abs(m - tierMultiplier);
      if (err < rErr) {
        rErr = err;
        bestIdx = refineIdx[r];
        bestProbeAmt = refineAmts[r];
        bestMul = m;
      }
    }
  }
  if (!bestProbeAmt || bestProbeAmt.cost <= 0n) throw new Error('solveStrike: chosen strike is not mintable');

  const clamped = Math.abs(bestMul - tierMultiplier) > tierMultiplier * CLAMP_TOLERANCE;
  const strike = strikeAt(bestIdx);

  // ---- Round 3: size the quantity. Cost is near-linear in quantity, so estimate from the
  // probe's per-unit cost, then batch a spread of candidates around it and take the largest whose
  // real cost stays under the cap. The cap sits a hair below the bet because the preview prices
  // pre-trade: the real mint, sized against the post-trade vault, costs a touch more, and the
  // manager is funded above the bet to absorb exactly that. ----
  const cap = (betRaw * 99n) / 100n; // selected pre-trade cost ceiling
  const target = (betRaw * 95n) / 100n; // aim a little under so the largest candidate lands near the bet
  const q0 = (probe * target) / bestProbeAmt.cost;
  const factors = [0.9, 0.94, 0.97, 1.0, 1.03, 1.06].slice(0, SIZE_SAMPLES);
  const qs = factors.map((f) => {
    const q = (q0 * BigInt(Math.round(f * 1000))) / 1000n;
    return q > 0n ? q : 1n;
  });
  const sizeAmts = await preview(qs.map((q) => ({ strike1e9: strike, quantity: q })));

  let chosenQ = 0n;
  let chosenCost = 0n;
  for (let i = 0; i < qs.length; i++) {
    const a = sizeAmts[i];
    if (!a || a.cost <= 0n || a.cost > cap) continue;
    if (qs[i] > chosenQ) {
      chosenQ = qs[i];
      chosenCost = a.cost;
    }
  }

  // Fallback: every candidate overshot the cap (steep slippage). Scale down from the smallest
  // priced candidate in one more probe.
  if (chosenQ === 0n) {
    const smallest = sizeAmts.find((a) => a && a.cost > 0n) ?? null;
    if (!smallest) throw new Error('solveStrike: could not price the chosen strike');
    let q = (qs[0] * cap) / smallest.cost;
    q = q > 1n ? q - 1n : 1n;
    const [a] = await preview([{ strike1e9: strike, quantity: q }]);
    if (!a || a.cost <= 0n || a.cost > cap) throw new Error('solveStrike: could not size the play within the bet');
    chosenQ = q;
    chosenCost = a.cost;
  }

  const multiplier = multiplierOf(chosenCost, chosenQ); // quantity / entryCost: honest and mintable
  return {
    strike1e9: strike,
    quantity: chosenQ,
    entryCost: chosenCost,
    multiplier,
    requestedTier: tierMultiplier,
    achievedTier: nearestTier(multiplier),
    clamped,
  };
}
