// The honest tier -> strike bridge (LUCKY.md §5). The slot deals a nominal multiplier tier;
// this finds the real grid strike whose live Predict multiple is closest to that tier and
// sizes the quantity so the mint cost lands at the bet. The multiple is read straight from
// the chain preview (1 / ask), so the number the UI shows is always one we can actually mint.
//
// Latency: over the remote node a devInspect is ~1-2s regardless of how many probes it bundles,
// and a single batch stays flat to ~160 probes (the cost is the round trip, not the per-strike
// compute). So we price the WHOLE grid densely in ONE devInspect (no separate coarse+refine
// passes), then size in ONE more. That is a 2-round-trip solve. The dense scan curve is also
// returned so the caller can cache it per (oracle, side): a warm curve drops the solve to a single
// sizing round trip, which is what keeps a play snappy under concurrent load.
//
// solveStrike is pure: it takes a batch-preview function, never a chain handle, so it unit-tests
// in isolation. The caller (games.ts) supplies a closure bound to the live oracle + side and a
// grid from that oracle, then mints with the strike + quantity this returns.

import { DUSDC_DECIMALS, multiplier as multiplierOf } from './math.ts';
import type { TradeAmounts } from './predict.ts';

// The nominal multiplier tiers the reel can deal (LUCKY.md §4). Capped at 10x so the top tier stays
// reachable on the live grid and pays a sane amount. The solver snaps a solved multiple back to the
// nearest nominal for logging + the achieved-tier report; the live UI shows that clean nominal tier
// (the cents of solver drift read as noise). Starts at 2x: the strike is always OTM (in the bet
// direction) and at least `minOffset1e9` clear of entry, so the floor tier is a small but real
// directional move (~2.0-2.2x), never an at-the-money strike sitting on the entry line.
export const LUCKY_TIERS = [2, 3, 5, 10] as const;

const nearestTier = (m: number): number =>
  LUCKY_TIERS.reduce((best, t) => (Math.abs(t - m) < Math.abs(best - m) ? t : best), LUCKY_TIERS[0] as number);

export type Grid = { tick: bigint; min: bigint; max: bigint };

// One batched preview: each probe is a (strike, quantity) pair, results align to input order.
// A null result means that strike is unmintable (price rounded to zero / outside ask bounds).
export type Probe = { strike1e9: bigint; quantity: bigint };
export type BatchPreviewFn = (probes: Probe[]) => Promise<Array<TradeAmounts | null>>;

// The per-unit price curve for one (oracle, side): the cost to mint `probe` contracts at each
// sampled grid strike (null = unmintable). Cacheable, since it only drifts as spot moves; the
// caller keys it by (oracleId, side) under a short TTL so back-to-back plays skip the scan.
export type ScanCurve = { probe: bigint; strikes: bigint[]; cost: Array<bigint | null> };

export type StrikeSolution = {
  strike1e9: bigint;
  quantity: bigint; // 6dp contracts; a settled win pays `quantity`
  entryCost: bigint; // 6dp, the real preview cost, always <= bet
  multiplier: number; // the REAL solved multiple = quantity / entryCost (what the UI shows)
  requestedTier: number;
  achievedTier: number; // nearest nominal tier to the solved multiple
  clamped: boolean; // true when the requested tier was not reachable within ask bounds
  curve: ScanCurve; // the scan this solve used; cache it to skip the next play's scan round trip
};

// How far the solved multiple may sit from the requested tier before we call it a clamp.
const CLAMP_TOLERANCE = 0.2; // 20%

const DENSE_SAMPLES = 128; // one devInspect prices the whole grid this densely at flat cost (<160 knee)
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

// Candidate strikes one tick inside each grid edge, indexed so the per-unit multiple is monotonic
// INCREASING in the index for either side (up: ascending strike, more OTM = bigger multiple; down:
// descending strike). Monotonicity is what lets the dense scan bracket the tier cleanly.
const strikeIndexer = (grid: Grid, side: 'up' | 'down') => {
  const count = Number((grid.max - grid.min) / grid.tick) - 1;
  if (count <= 0) throw new Error('solveStrike: grid too small');
  const lastIdx = count - 1;
  const strikeAt = (i: number): bigint =>
    side === 'up' ? grid.min + grid.tick * BigInt(i + 1) : grid.max - grid.tick * BigInt(i + 1);
  return { lastIdx, strikeAt };
};

// Where the dense scan starts, as a fraction of the half-grid each side of ATM. The on-chain strike
// grid is far wider than the band that actually prices: a 30s round only quotes within a few percent
// of spot, while the grid spans ~±20%. The deep-ITM/-OTM extremes saturate the fair price to exactly
// $1/$0, which aborts the per-strike quote (quote_spread_from_fair_price), and a devInspect aborts
// the WHOLE batch, so a single saturating strike kills the scan. 12% covers every tier (the 25x edge
// sits well inside) while usually clearing the saturation in one pass.
const SCAN_HALF_FRAC = 0.12;
const SCAN_SHRINK = 0.6; // on a saturation abort, pull the window this much toward ATM and retry

// The grid index whose strike is nearest the live spot (ATM), per side. Centering the scan here, not
// at the grid midpoint, is what makes it robust: the grid is built centered on spot at CREATION, but
// spot drifts, so a midpoint-centered window can land entirely in the saturated (unquotable) deep
// region and never recover. At ATM the fair price is ~0.5, always quotable.
const atmIndex = (grid: Grid, side: 'up' | 'down', lastIdx: number, atm1e9: bigint): number => {
  const raw = side === 'up' ? (atm1e9 - grid.min) / grid.tick - 1n : (grid.max - atm1e9) / grid.tick - 1n;
  return Math.max(0, Math.min(lastIdx, Number(raw)));
};

// Price the grid densely in ONE devInspect. The result is cacheable per (oracle, side).
//
// Tries the WHOLE grid first: when every sampled strike quotes (a sanely sized grid, and every unit
// test), that is one round trip and the original behavior. If a strike saturates and aborts the batch
// (a grid far wider than the live quotable band, the production case), fall back to an ATM-centered
// window that shrinks toward spot until it prices, keeping the unmintable extremes out of the curve.
// atm1e9 is the live oracle spot; without it the window falls back to the grid midpoint.
export async function scanGrid(grid: Grid, side: 'up' | 'down', preview: BatchPreviewFn, probeArg?: bigint, atm1e9?: bigint): Promise<ScanCurve> {
  const probe = probeArg ?? DUSDC_DECIMALS;
  const { lastIdx, strikeAt } = strikeIndexer(grid, side);

  const scanWindow = async (lo: number, hi: number): Promise<ScanCurve> => {
    const strikes = spread(DENSE_SAMPLES, lo, hi).map(strikeAt);
    const amts = await preview(strikes.map((strike1e9) => ({ strike1e9, quantity: probe })));
    return { probe, strikes, cost: amts.map((a) => (a && a.cost > 0n ? a.cost : null)) };
  };

  // With a live spot (the production path always supplies one) the grid is known to be far wider than
  // the quotable band, so its extremes always saturate: go straight to the ATM window and skip the
  // doomed full scan. Without a spot (a caller that hasn't measured one, and every unit test) scan the
  // whole grid first and fall back to the window only if a strike actually saturates.
  const hasSpot = atm1e9 != null && atm1e9 > 0n;
  let lastErr: unknown;
  if (!hasSpot) {
    try {
      return await scanWindow(0, lastIdx);
    } catch (e) {
      lastErr = e;
    }
  }
  const center = hasSpot ? atmIndex(grid, side, lastIdx, atm1e9 as bigint) : Math.floor(lastIdx / 2);
  let half = Math.max(2, Math.floor(lastIdx * SCAN_HALF_FRAC));
  for (let attempt = 0; attempt < 5 && half >= 2; attempt++) {
    try {
      return await scanWindow(Math.max(0, center - half), Math.min(lastIdx, center + half));
    } catch (e) {
      lastErr = e; // still hitting a saturating strike; pull the window in toward ATM and retry
      half = Math.floor(half * SCAN_SHRINK);
    }
  }
  throw lastErr ?? new Error('scanGrid: empty grid');
}

export async function solveStrike(args: {
  grid: Grid;
  side: 'up' | 'down';
  tierMultiplier: number;
  betRaw: bigint;
  preview: BatchPreviewFn;
  curve?: ScanCurve; // a cached scan for this (oracle, side); skips the scan round trip when fresh
  probe?: bigint;
  atm1e9?: bigint; // live oracle spot, so the scan window centers on ATM (not the stale grid midpoint)
  minOffset1e9?: bigint; // smallest |strike - atm| allowed, so even the floor tier is a visible move
  analyticSize?: boolean; // size the quantity from the scan curve, skipping the sizing devInspect
}): Promise<StrikeSolution> {
  const { grid, side, tierMultiplier, betRaw, preview } = args;
  const probe = args.curve?.probe ?? args.probe ?? DUSDC_DECIMALS; // 1.0 contract, the per-unit price probe
  if (tierMultiplier <= 1) throw new Error('solveStrike: tier must be > 1');
  if (betRaw <= 0n) throw new Error('solveStrike: bet must be positive');

  // ---- Round 1: the dense scan (reuse a cached curve when the caller has a fresh one). ----
  const curve = args.curve ?? (await scanGrid(grid, side, preview, probe, args.atm1e9));
  const multAt = (c: bigint | null): number => (c && c > 0n ? multiplierOf(c, probe) : Infinity);

  // ---- Strike select (pure): the sampled strike whose multiple is closest to the tier among the
  // mintable ones. The multiple is monotonic in the index, so when the tier sits past the ask
  // bounds this naturally lands on the mintable ceiling, which is where a too-high tier clamps.
  //
  // Direction honesty: only consider strikes on the OTM side of spot (at or beyond it) so an UP
  // play's target sits at/above entry and a DOWN play's at/below. That is what makes "DOWN means
  // the price must fall" always true; the lowest reachable multiple is then ~2x (ATM), which is
  // why the tier ladder starts at 2x. Skipped when no spot is supplied (the pure unit tests). ----
  const atm = args.atm1e9;
  const minOff = args.minOffset1e9 ?? 0n;
  // Directional gate: a strike must sit on the bet's OTM side of spot AND at least `off` clear of it,
  // so an UP target is a real move above entry and a DOWN target a real move below. off=0 is the bare
  // OTM filter (and the pure unit tests). Skipped entirely when no spot is supplied.
  const isDirectional = (strike: bigint, off: bigint): boolean =>
    atm == null ? true : side === 'up' ? strike >= atm + off : strike <= atm - off;
  const selectBest = (off: bigint, directional: boolean): number => {
    let b = -1;
    let bErr = Infinity;
    for (let k = 0; k < curve.cost.length; k++) {
      const m = multAt(curve.cost[k]);
      if (!Number.isFinite(m)) continue;
      if (directional && !isDirectional(curve.strikes[k], off)) continue;
      const err = Math.abs(m - tierMultiplier);
      if (err < bErr) {
        bErr = err;
        b = k;
      }
    }
    return b;
  };
  // Prefer a strike a real move OTM (min offset), then relax to the bare OTM side, then to any
  // mintable strike, so a thin scan window or a coarse grid never makes a play unmintable.
  let best = selectBest(minOff, true);
  if (minOff > 0n && best < 0) best = selectBest(0n, true);
  if (best < 0) best = selectBest(0n, false);
  if (best < 0) throw new Error('solveStrike: no mintable strike on this grid');

  const strike = curve.strikes[best];
  const bestPerUnit = curve.cost[best] as bigint;
  const bestMul = multAt(bestPerUnit);
  const clamped = Math.abs(bestMul - tierMultiplier) > tierMultiplier * CLAMP_TOLERANCE;

  // ---- Round 2 (analytic): size from the chosen strike's per-unit cost, no sizing devInspect. Cost
  // is near-linear in quantity for small size, so q = bet/perUnit lands the entry at the bet, and
  // entryCost/multiple come straight off the (fresh or <=3s cached) curve. The real mint prices
  // post-trade (a touch higher); the manager is funded above the bet (FUND_BUFFER_PCT) to absorb it,
  // and a rare overshoot aborts the mint and the caller re-resolves. This deletes a ~1.2s node round
  // trip; the reported multiple omits the position's own slippage (<0.1% at small stakes). ----
  if (args.analyticSize) {
    const targetA = betRaw; // deploy the full stake; the manager's funding buffer absorbs post-trade drift
    let q = (probe * targetA) / bestPerUnit;
    if (q <= 0n) q = 1n;
    const entryCost = (bestPerUnit * q) / probe;
    const mult = multiplierOf(entryCost, q);
    return { strike1e9: strike, quantity: q, entryCost, multiplier: mult, requestedTier: tierMultiplier, achievedTier: nearestTier(mult), clamped, curve };
  }

  // ---- Round 2: size the quantity. Cost is near-linear in quantity, so estimate from the chosen
  // strike's per-unit cost, then batch a spread of candidates around it and take the largest whose
  // real cost stays under the cap. The cap sits a hair below the bet because the preview prices
  // pre-trade: the real mint, sized against the post-trade vault, costs a touch more, and the
  // manager is funded above the bet to absorb exactly that. The per-unit estimate may come from a
  // cached (slightly older) curve, but the sizing preview re-prices fresh, so entryCost is current. ----
  const cap = (betRaw * 995n) / 1000n; // selected pre-trade cost ceiling (99.5%)
  const target = (betRaw * 99n) / 100n; // aim just under so the largest candidate lands near the bet
  const q0 = (probe * target) / bestPerUnit;
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

  // Fallback: every candidate overshot the cap (steep slippage / a stale-curve estimate). Scale
  // down from the smallest priced candidate in one more probe.
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
    curve,
  };
}
