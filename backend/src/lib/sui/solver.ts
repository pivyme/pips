// The honest tier -> strike bridge (LUCKY.md §5). The slot deals a nominal multiplier tier;
// this finds the real grid strike whose live Predict multiple is closest to that tier and
// sizes the quantity so the mint cost lands at the bet. The multiple is read straight from
// the chain preview (1 / ask), so the number the UI shows is always one we can actually mint.
//
// solveStrike is pure: it takes a preview function, never a chain handle, so it unit-tests in
// isolation. The caller (games.ts) supplies a preview closure bound to the live oracle and a
// grid from that oracle, then mints with the strike + quantity this returns.

import { DUSDC_DECIMALS, multiplier as multiplierOf } from './math.ts';
import type { Side, TradeAmounts } from './predict.ts';

// The nominal multiplier tiers the reel can deal (LUCKY.md §4). The solver snaps a solved
// multiple back to the nearest nominal for logging + the achieved-tier report; the UI always
// shows the real solved multiple, not the nominal.
export const LUCKY_TIERS = [1.5, 2, 3, 5, 10, 25] as const;

const nearestTier = (m: number): number =>
  LUCKY_TIERS.reduce((best, t) => (Math.abs(t - m) < Math.abs(best - m) ? t : best), LUCKY_TIERS[0] as number);

export type Grid = { tick: bigint; min: bigint; max: bigint };

export type PreviewFn = (strike1e9: bigint, quantity: bigint) => Promise<TradeAmounts>;

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

export async function solveStrike(args: {
  grid: Grid;
  side: Side;
  tierMultiplier: number;
  betRaw: bigint;
  preview: PreviewFn;
  probe?: bigint;
}): Promise<StrikeSolution> {
  const { grid, side, tierMultiplier, betRaw, preview } = args;
  const probe = args.probe ?? DUSDC_DECIMALS; // 1.0 contract, the per-unit price probe
  if (tierMultiplier <= 1) throw new Error('solveStrike: tier must be > 1');
  if (betRaw <= 0n) throw new Error('solveStrike: bet must be positive');

  // Candidate strikes one tick inside each grid edge, indexed so the per-unit multiple is
  // monotonic INCREASING in the index for either side (up: ascending strike, more OTM = bigger
  // multiple; down: descending strike). Monotonicity is what lets us bisect instead of scan.
  const count = Number((grid.max - grid.min) / grid.tick) - 1;
  if (count <= 0) throw new Error('solveStrike: grid too small');
  const strikeAt = (i: number): bigint =>
    side === 'up' ? grid.min + grid.tick * BigInt(i + 1) : grid.max - grid.tick * BigInt(i + 1);

  // Probe preview cached per index; null = unmintable (cost rounds to zero / outside ask bounds).
  const cache = new Map<number, TradeAmounts | null>();
  const amountsAt = async (i: number): Promise<TradeAmounts | null> => {
    if (!cache.has(i)) {
      try {
        const a = await preview(strikeAt(i), probe);
        cache.set(i, a.cost > 0n ? a : null);
      } catch {
        cache.set(i, null);
      }
    }
    return cache.get(i) ?? null;
  };
  const multAt = async (i: number): Promise<number> => {
    const a = await amountsAt(i);
    return a ? multiplierOf(a.cost, probe) : Infinity; // probe / cost; Infinity = unmintable
  };

  // Bisect the crossover: the largest index whose multiple is still <= the tier; its neighbor
  // overshoots. Then keep whichever of the two sits closer to the tier (and is mintable).
  const lastIdx = count - 1;
  let chosen: number;
  let clamped: boolean;
  const mFirst = await multAt(0);
  if (mFirst >= tierMultiplier) {
    // The tier is below even the lowest achievable multiple (deepest ITM strike); snap to it.
    chosen = 0;
    clamped = mFirst - tierMultiplier > tierMultiplier * CLAMP_TOLERANCE;
  } else {
    let lo = 0;
    let hi = lastIdx;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if ((await multAt(mid)) <= tierMultiplier) lo = mid;
      else hi = mid - 1;
    }
    const below = lo; // largest index with multiple <= tier (always mintable, since mFirst < tier)
    const above = lo + 1 <= lastIdx ? lo + 1 : -1; // overshoots the tier, may be unmintable
    const mBelow = await multAt(below);
    const mAbove = above >= 0 ? await multAt(above) : Infinity;
    chosen =
      above >= 0 && Number.isFinite(mAbove) && Math.abs(mAbove - tierMultiplier) < Math.abs(mBelow - tierMultiplier)
        ? above
        : below;
    const mChosen = await multAt(chosen);
    // Clamped when we ran out of mintable strikes before reaching the tier (above is unmintable),
    // or the best we could land is more than the tolerance off the requested tier.
    clamped =
      (above >= 0 && !Number.isFinite(mAbove)) || Math.abs(mChosen - tierMultiplier) > tierMultiplier * CLAMP_TOLERANCE;
  }

  // Size the quantity at the chosen strike so the real cost lands just under the bet. Cost is
  // near-linear in quantity, so a proportional step from the probe converges in a couple of
  // refinements (mirrors the games.ts quantity solver), then a hard guard keeps cost <= bet.
  const strike = strikeAt(chosen);
  const probeAmt = await amountsAt(chosen);
  if (!probeAmt) throw new Error('solveStrike: chosen strike is not mintable');
  const target = (betRaw * 98n) / 100n; // 2% headroom against drift between preview and mint
  let q = (probe * target) / probeAmt.cost;
  if (q <= 0n) q = 1n;
  let a = await preview(strike, q);
  for (let i = 0; i < 2; i++) {
    if (a.cost <= betRaw && a.cost * 100n >= target * 96n) break;
    q = (q * target) / a.cost;
    if (q <= 0n) q = 1n;
    a = await preview(strike, q);
  }
  let guard = 0;
  while (a.cost > betRaw && guard < 3) {
    q = (q * betRaw) / a.cost;
    q = q > 1n ? q - 1n : 1n;
    a = await preview(strike, q);
    guard++;
  }
  if (a.cost > betRaw || a.cost <= 0n) throw new Error('solveStrike: could not size the play within the bet');

  const multiplier = multiplierOf(a.cost, q); // quantity / entryCost: honest and mintable
  return {
    strike1e9: strike,
    quantity: q,
    entryCost: a.cost,
    multiplier,
    requestedTier: tierMultiplier,
    achievedTier: nearestTier(multiplier),
    clamped,
  };
}
