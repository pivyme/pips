// Per-game parameter resolution. Turns a stake (and, for Lucky, a fair server RNG) into a
// concrete Predict position: a live market, a grid-aligned strike or band, and a quantity
// sized so the real mint cost lands at the stake. Everything is quoted against the live
// oracle via the Predict preview, so the reported multiplier is honest, never invented.

import {
  EXPIRY_SAFETY_MS,
  LUCKY_ROUND_MS,
  LUCKY_MIN_ORACLE_LIFE_MS,
  MIN_STAKE,
  MAX_STAKE,
} from '../config/main-config.ts';
import {
  DUSDC_DECIMALS,
  FLOAT_SCALING,
  ORACLE_STRIKE_GRID_TICKS,
  toDusdcRaw,
  usd1e9,
  multiplier as multiplierOf,
} from '../lib/sui/config.ts';
import { gameSpot } from '../lib/game-price.ts';
import { liveByAsset, tradeableMarkets, type Market } from '../lib/sui/markets.ts';
import {
  previewBinaryBatch,
  previewRange,
  readOracle,
  type BinaryParams,
  type RangeParams,
  type Side,
  type TradeAmounts,
} from '../lib/sui/predict.ts';
import { solveStrike, type BatchPreviewFn, type ScanCurve } from '../lib/sui/solver.ts';
import { newSeed, seedFloat, pickTier } from './rng.ts';

// Cache the dense strike-price curve per (oracle, side) for a short TTL. The curve only drifts as
// spot moves (price-pusher every ~2s), so within the TTL a play reuses it and skips the scan round
// trip, leaving just the sizing probe. The sizing preview re-prices fresh, so a warm curve never
// makes the reported cost/multiplier stale. Bounded so a long-lived process never grows it without
// limit; entries fall out as oracles roll.
const SOLVE_CURVE_TTL_MS = 3000;

// The coinflip tier. The slot's most common deal (LUCKY_TIER_WEIGHTS): its strike sits one tick
// inside the live spot, so ANY move in the bet direction wins (~2x, at the money). This is the
// intuitive common case ("I bet down, it dipped, I win"); the bigger tiers stay OTM reach-a-target.
const COINFLIP_TIER = 2;
const curveCache = new Map<string, { curve: ScanCurve; at: number }>();
function getFreshCurve(key: string, now: number): ScanCurve | undefined {
  const hit = curveCache.get(key);
  return hit && now - hit.at < SOLVE_CURVE_TTL_MS ? hit.curve : undefined;
}
function putCurve(key: string, curve: ScanCurve, now: number): void {
  if (curveCache.size > 64) for (const [k, v] of curveCache) if (now - v.at >= SOLVE_CURVE_TTL_MS) curveCache.delete(k);
  curveCache.set(key, { curve, at: now });
}

// === Errors ===

export type PlayErrorCode =
  | 'MARKET_UNAVAILABLE'
  | 'ORACLE_STALE'
  | 'INSUFFICIENT_DUSDC'
  | 'MINT_FAILED'
  | 'REDEEM_FAILED'
  | 'PLAY_NOT_OPEN'
  | 'INVALID_PARAMS'
  | 'MANAGER_NOT_READY'
  | 'PREDICT_VAULT_CAPACITY';

// Carries a friendly, client-facing code. Routes map this straight onto the error envelope.
export class PlayError extends Error {
  code: PlayErrorCode;
  constructor(code: PlayErrorCode, message: string) {
    super(message);
    this.name = 'PlayError';
    this.code = code;
  }
}

// HTTP status for each play error so routes return a sensible code, never a raw 500.
export const httpStatusForPlayError = (code: PlayErrorCode): number => {
  switch (code) {
    case 'INVALID_PARAMS':
    case 'INSUFFICIENT_DUSDC':
      return 400;
    case 'MARKET_UNAVAILABLE':
    case 'ORACLE_STALE':
    case 'PREDICT_VAULT_CAPACITY':
    case 'PLAY_NOT_OPEN':
    case 'MANAGER_NOT_READY':
      return 409;
    case 'MINT_FAILED':
    case 'REDEEM_FAILED':
      return 502;
    default:
      return 500;
  }
};

// === Market + grid helpers ===

const now = (): number => Date.now();

function pickMarket(asset: string): Market {
  const live = liveByAsset(asset, now(), EXPIRY_SAFETY_MS).sort((a, b) => b.expiryMs - a.expiryMs);
  const m = live[0];
  if (!m) throw new PlayError('MARKET_UNAVAILABLE', `No live ${asset} market right now`);
  return m;
}

// The live oracle a LUCKY play routes to. Two-stage pick so a play never lands on an oracle that
// expires mid-mint (the EOracleExpired → retry → 10-20s stall): first keep only oracles with enough
// life that the build+sign+submit can't outrun expiry (LUCKY_MIN_ORACLE_LIFE_MS), then take the one
// expiring nearest the round target so rounds stay ~30s. If the ladder is thin and nothing clears
// the life floor, fall back to the longest-lived live oracle rather than failing the play.
function roundOracle(asset: string): Market | undefined {
  const t = now();
  const live = liveByAsset(asset, t, EXPIRY_SAFETY_MS);
  if (live.length === 0) return undefined;
  const roomy = live.filter((m) => m.expiryMs - t >= LUCKY_MIN_ORACLE_LIFE_MS);
  if (roomy.length === 0) return live.reduce((best, m) => (m.expiryMs > best.expiryMs ? m : best));
  const target = t + LUCKY_ROUND_MS;
  return roomy.reduce((best, m) => (Math.abs(m.expiryMs - target) < Math.abs(best.expiryMs - target) ? m : best));
}

export function liveAssets(): string[] {
  return [...new Set(tradeableMarkets(now(), EXPIRY_SAFETY_MS).map((m) => m.underlying))];
}

// Fresh on-chain spot, pre-empting the 30s freshness gate with a friendly stale error.
async function freshSpot(m: Market): Promise<bigint> {
  const st = await readOracle(m.oracleId);
  if (!st) throw new PlayError('MARKET_UNAVAILABLE', 'Market oracle not found');
  if (st.settled || !st.active) throw new PlayError('MARKET_UNAVAILABLE', 'Market is not active');
  if (st.spot1e9 <= 0n) throw new PlayError('ORACLE_STALE', 'Market has no price yet');
  if (now() - st.timestampMs > 30_000) throw new PlayError('ORACLE_STALE', 'Market price is stale');
  return st.spot1e9;
}

type Grid = { tick: bigint; min: bigint; max: bigint };
const gridOf = (m: Market): Grid => {
  const tick = BigInt(m.tickSize);
  const min = BigInt(m.minStrike);
  return { tick, min, max: min + tick * (ORACLE_STRIKE_GRID_TICKS - 1n) };
};

const floorTick = (v: bigint, tick: bigint): bigint => (v / tick) * tick;
const ceilTick = (v: bigint, tick: bigint): bigint => {
  const floor = (v / tick) * tick;
  return floor === v ? floor : floor + tick;
};
// Keep strikes one tick inside the grid edges so a key is always valid.
const clampStrike = (v: bigint, g: Grid): bigint => {
  if (v < g.min + g.tick) return g.min + g.tick;
  if (v > g.max - g.tick) return g.max - g.tick;
  return v;
};

// Range band [lower, upper] around spot for a width percentage, snapped out to the grid so
// the band is at least one tick wide.
function rangeBand(spot1e9: bigint, widthPct: number, g: Grid): { lower: bigint; higher: bigint } {
  const halfFrac = widthPct / 100 / 2;
  const half = (spot1e9 * BigInt(Math.round(halfFrac * 1e9))) / FLOAT_SCALING;
  let lower = clampStrike(floorTick(spot1e9 - half, g.tick), g);
  let higher = clampStrike(ceilTick(spot1e9 + half, g.tick), g);
  if (higher <= lower) higher = clampStrike(lower + g.tick, g);
  return { lower, higher };
}

const fmt1e9 = (v: bigint): string => String(Number(v) / 1e9);

// === Quantity solver ===

// Invert the curve-priced mint cost: find the quantity whose real preview cost lands just
// under the stake (a little headroom against price drift between preview and mint). A short
// proportional search converges fast because cost is near-linear in quantity for small size.
async function solveQuantity(
  preview: (q: bigint) => Promise<TradeAmounts>,
  stakeRaw: bigint,
): Promise<{ quantity: bigint; amounts: TradeAmounts }> {
  const probe = DUSDC_DECIMALS; // 1.0 contract
  let a: TradeAmounts;
  try {
    a = await preview(probe);
  } catch (e) {
    throw new PlayError('MINT_FAILED', `Could not price this play: ${e instanceof Error ? e.message : e}`);
  }
  if (a.cost <= 0n) throw new PlayError('MINT_FAILED', 'Market returned a zero price');

  const target = (stakeRaw * 98n) / 100n; // 2% headroom
  let q = (probe * target) / a.cost;
  if (q <= 0n) q = 1n;

  for (let i = 0; i < 2; i++) {
    a = await preview(q);
    if (a.cost <= 0n) throw new PlayError('MINT_FAILED', 'Market returned a zero price');
    if (a.cost <= stakeRaw && a.cost * 100n >= target * 96n) break;
    q = (q * target) / a.cost;
    if (q <= 0n) q = 1n;
  }

  // Hard guarantee: cost must not exceed the stake the manager is funded to.
  let guard = 0;
  while (a.cost > stakeRaw && guard < 3) {
    q = (q * stakeRaw) / a.cost;
    q = q > 1n ? q - 1n : 1n;
    a = await preview(q);
    guard++;
  }
  if (a.cost > stakeRaw) throw new PlayError('MINT_FAILED', 'Could not size this play within your stake');
  return { quantity: q, amounts: a };
}

// === Stake parsing ===

export function parseStake(stake: string | number): bigint {
  const n = typeof stake === 'number' ? stake : Number(stake);
  if (!Number.isFinite(n) || n <= 0) throw new PlayError('INVALID_PARAMS', 'Enter a valid bet amount');
  if (n < MIN_STAKE) throw new PlayError('INVALID_PARAMS', `Minimum bet is $${MIN_STAKE}`);
  if (n > MAX_STAKE) throw new PlayError('INVALID_PARAMS', `Maximum bet is $${MAX_STAKE}`);
  return toDusdcRaw(n);
}

// === Resolutions ===

export type ResolvedBinary = {
  kind: 'binary';
  game: 'lucky';
  market: Market;
  params: BinaryParams;
  asset: string;
  side: Side;
  tier: number; // the nominal tier the reel dealt (legacy Play.leverage column)
  duration: number;
  strikeDisplay: string;
  entrySpot: string; // spot at entry (display), for debug/audit
  entryCost: bigint;
  maxPayout: bigint; // settled ITM payout = quantity ($1 per contract)
  multiplier: number; // payout / entry cost = 1/ask, the live on-chain odds the position pays (what the UI shows)
  seed: string;
};

export type ResolvedRange = {
  kind: 'range';
  game: 'range';
  market: Market;
  params: RangeParams;
  asset: string;
  lowerDisplay: string;
  upperDisplay: string;
  widthPct?: number;
  duration: number;
  entrySpot: string; // spot at entry (display), for debug/audit
  entryCost: bigint;
  maxPayout: bigint;
  multiplier: number; // payout / entry cost = 1/ask, the live on-chain odds the band pays
};

export type Resolved = ResolvedBinary | ResolvedRange;

// LUCKY: a fair server RNG deals the whole spin (asset, direction, multiplier tier); the player
// only sets the bet. The dealt tier is then priced HONESTLY off the live oracle, the §5 solver
// finds the grid strike whose real multiple matches it and sizes the quantity so cost ~= bet, so
// the multiplier we surface is always one we can actually mint. The round settles at the routed
// oracle's expiry (~30s), never one oracle per play.
export async function resolveLucky(stakeRaw: bigint, existingSeed?: string): Promise<ResolvedBinary> {
  const assets = liveAssets();
  if (assets.length === 0) throw new PlayError('MARKET_UNAVAILABLE', 'No markets are live right now');

  // Reuse the original seed on a re-route so the dealt asset/side/tier stay identical (fairness, and
  // the reels already snapped to them); only the oracle is re-picked + re-priced. Fresh seed otherwise.
  const seed = existingSeed ?? newSeed();
  const asset = assets[Math.floor(seedFloat(seed, 0) * assets.length)];
  const side: Side = seedFloat(seed, 1) < 0.5 ? 'up' : 'down';
  const tier = pickTier(seedFloat(seed, 2)); // slot-weighted reel deal (LUCKY.md §4)

  // The price the chart shows and the round settles against (gameSpot): solve the strike off THIS,
  // not the oracle's cached spot, so the ENTRY and TARGET the player sees sit exactly on the live
  // chart line. The old stale-cache spot floated them 2-4% off (worse in follower mode, two walks).
  const liveSpot = await gameSpot(asset);
  const fresh1e9 = liveSpot && liveSpot.price > 0 ? usd1e9(liveSpot.price) : undefined;
  // Rare (cold boot / a Pyth blip): no live game price, so we fall back to the oracle's cached spot
  // below, which can re-float the entry off the chart. Warn so it is diagnosable, never silent.
  if (fresh1e9 == null) console.warn(`[Lucky] no live game price for ${asset}, solving off the cached oracle spot`);

  // Route to the oracle expiring nearest the round target and solve in a few batched round trips.
  // The asset/side/tier are fixed by the seed (fairness); only the oracle is re-picked if the first
  // one expires mid-solve, which the batched preview surfaces as a thrown error.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const market = roundOracle(asset);
    if (!market) throw new PlayError('MARKET_UNAVAILABLE', `No live ${asset} market right now`);
    const g = gridOf(market);
    // Center the solve + the entry mark on the live chart price; fall back to the oracle's cached
    // spot only if the game feed has no price yet (cold boot, before the first push/sync).
    const atm1e9 = fresh1e9 ?? (market.spot1e9 ? BigInt(market.spot1e9) : undefined);
    const entrySpot = atm1e9 != null ? fmt1e9(atm1e9) : '';
    // The round runs to the routed oracle's expiry, so the UI countdown matches the real settle.
    const duration = Math.max(1, Math.round((market.expiryMs - now()) / 1000));

    // One batched devInspect per solver round. cost == 0 means that strike is unmintable.
    const preview: BatchPreviewFn = async (probes) => {
      const amts = await previewBinaryBatch(market.oracleId, market.expiryMs, side, probes);
      return amts.map((a) => (a.cost > 0n ? a : null));
    };

    try {
      // Coinflip: the strike sits one tick inside the live spot, so ANY move in the bet direction
      // wins (~2x, at the money). One probe sizes the quantity to the bet (analytic, like the OTM
      // path below); the funding buffer absorbs the small pre/post-trade slippage.
      if (tier <= COINFLIP_TIER && atm1e9 != null) {
        const atmTick = side === 'up' ? floorTick(atm1e9, g.tick) : ceilTick(atm1e9, g.tick);
        const strike = clampStrike(atmTick, g);
        // Only a real coinflip when the ATM tick is genuinely inside the grid. If the spot has drifted
        // to a grid edge so the clamp moved the strike, fall through to the OTM solver, which reports an
        // honest tier/multiple instead of mislabeling a deep ITM/OTM edge strike as ~2x any-move-wins.
        if (strike === atmTick) {
          const [probe] = await previewBinaryBatch(market.oracleId, market.expiryMs, side, [{ strike1e9: strike, quantity: DUSDC_DECIMALS }]);
          if (!probe || probe.cost <= 0n) throw new Error('coinflip strike unmintable');
          const targetA = (stakeRaw * 98n) / 100n; // aim just under the bet; the funding buffer covers the rest
          let q = (DUSDC_DECIMALS * targetA) / probe.cost;
          if (q <= 0n) q = 1n;
          const entryCost = (probe.cost * q) / DUSDC_DECIMALS;
          return {
            kind: 'binary',
            game: 'lucky',
            market,
            params: { oracleId: market.oracleId, expiryMs: market.expiryMs, strike1e9: strike, side, quantity: q },
            asset,
            side,
            tier: COINFLIP_TIER,
            duration,
            strikeDisplay: fmt1e9(strike),
            entrySpot,
            entryCost,
            maxPayout: q,
            multiplier: multiplierOf(entryCost, q),
            seed,
          };
        }
      }

      // Reuse a fresh cached scan for this oracle/side when one exists, so a warm play skips the
      // scan round trip and only pays for sizing. Cache whatever scan the solve ended up using.
      const cacheKey = `${market.oracleId}:${side}`;
      const t0 = now();
      const curve = getFreshCurve(cacheKey, t0);
      const solution = await solveStrike({ grid: g, side, tierMultiplier: tier, betRaw: stakeRaw, preview, curve, atm1e9, analyticSize: true });
      if (!curve) putCurve(cacheKey, solution.curve, t0);
      if (solution.clamped) {
        // Dealt tier was past the live ask bounds; we minted the closest achievable one and report it.
        console.log(
          `[Lucky] ${asset} ${side} ${tier}x unreachable, solved ${solution.multiplier.toFixed(2)}x (tier ${solution.achievedTier}x)`,
        );
      }
      return {
        kind: 'binary',
        game: 'lucky',
        market,
        params: { oracleId: market.oracleId, expiryMs: market.expiryMs, strike1e9: solution.strike1e9, side, quantity: solution.quantity },
        asset,
        side,
        tier: solution.achievedTier,
        duration,
        strikeDisplay: fmt1e9(solution.strike1e9),
        entrySpot,
        entryCost: solution.entryCost,
        maxPayout: solution.quantity,
        multiplier: solution.multiplier,
        seed,
      };
    } catch (e) {
      lastErr = e;
      // First failure re-routes to a fresh oracle (the old one likely expired mid-solve); a
      // second failure is real, surface it as a friendly price error.
      if (attempt === 0) continue;
      throw new PlayError('MINT_FAILED', `Could not price this play: ${e instanceof Error ? e.message : e}`);
    }
  }
  throw new PlayError('MINT_FAILED', `Could not price this play: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
}

// Range: the knob's band width sets [lower, upper] around spot; tighter pays more. The round
// holds to the routed oracle's real expiry and settles to a true win/lose (inside the band pays
// $1*qty spread-free, else 0), so the duration is the oracle's time-to-expiry, never a client
// choice. An early cash-out still exits at the live mark whenever the player wants.
export async function resolveRange(stakeRaw: bigint, asset: string, widthPct: number): Promise<ResolvedRange> {
  if (!(widthPct > 0) || widthPct > 10) throw new PlayError('INVALID_PARAMS', 'Band width out of range');

  const market = pickMarket(asset);
  const spot = await freshSpot(market);
  const g = gridOf(market);
  const { lower, higher } = rangeBand(spot, widthPct, g);
  const duration = Math.max(1, Math.round((market.expiryMs - now()) / 1000));

  const mk = (q: bigint): RangeParams => ({ oracleId: market.oracleId, expiryMs: market.expiryMs, lower1e9: lower, higher1e9: higher, quantity: q });
  const { quantity, amounts } = await solveQuantity((q) => previewRange(mk(q)), stakeRaw);

  return {
    kind: 'range',
    game: 'range',
    market,
    params: mk(quantity),
    asset,
    lowerDisplay: fmt1e9(lower),
    upperDisplay: fmt1e9(higher),
    widthPct,
    duration,
    entrySpot: fmt1e9(spot),
    entryCost: amounts.cost,
    maxPayout: quantity,
    multiplier: multiplierOf(amounts.cost, quantity),
  };
}
