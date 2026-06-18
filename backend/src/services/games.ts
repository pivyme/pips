// Per-game parameter resolution. Turns a stake (and, for Lucky, a fair server RNG) into a
// concrete Predict position: a live market, a grid-aligned strike or band, and a quantity
// sized so the real mint cost lands at the stake. Everything is quoted against the live
// oracle via the Predict preview, so the reported multiplier is honest, never invented.

import {
  EXPIRY_SAFETY_MS,
  MIN_STAKE,
  MAX_STAKE,
  GAME_DURATIONS,
  DEMO_LUCKY_LEVERAGE,
  DEMO_LUCKY_DURATION,
} from '../config/main-config.ts';
import {
  DUSDC_DECIMALS,
  FLOAT_SCALING,
  ORACLE_STRIKE_GRID_TICKS,
  toDusdcRaw,
  usd1e9,
  multiplier as multiplierOf,
} from '../lib/sui/config.ts';
import { liveByAsset, tradeableMarkets, type Market } from '../lib/sui/markets.ts';
import {
  previewMint,
  previewRange,
  readOracle,
  type BinaryParams,
  type RangeParams,
  type Side,
  type TradeAmounts,
} from '../lib/sui/predict.ts';
import { newSeed, seedFloat, pickWeighted, BUCKET_WEIGHTS, LEVERAGE_BUCKETS as RNG_BUCKETS } from './rng.ts';

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

// === Leverage buckets (Lucky) ===

export const LEVERAGE_BUCKETS = RNG_BUCKETS;

// Risk tier (Lucky's Action 2). Constrains which leverage buckets the spin can land on, so the
// player sets the flavor while asset/side stay random. Chill hugs ATM (small, frequent wins);
// Lotto only draws the far, big-multiple strikes. The fair RNG still picks within the tier.
export type RiskTier = 'chill' | 'wild' | 'lotto';
const RISK_BUCKETS: Record<RiskTier, readonly number[]> = {
  chill: [2, 5],
  wild: [5, 10, 25],
  lotto: [25, 100],
};
const isRiskTier = (v: unknown): v is RiskTier => v === 'chill' || v === 'wild' || v === 'lotto';
const riskWeights = (allowed: readonly number[]): Record<number, number> =>
  Object.fromEntries(allowed.map((b) => [b, BUCKET_WEIGHTS[b] ?? 1]));
export { isRiskTier };

// Strike distance from spot per bucket (fraction). Further out = cheaper = bigger multiple.
const BUCKET_DISTANCE_PCT: Record<number, number> = { 2: 0.0008, 5: 0.002, 10: 0.004, 25: 0.009, 100: 0.025 };
// Floor on tick-distance so coarse-tick assets keep the buckets monotonic, not collapsed.
const BUCKET_MIN_TICKS: Record<number, bigint> = { 2: 0n, 5: 1n, 10: 2n, 25: 4n, 100: 8n };

// === Market + grid helpers ===

const now = (): number => Date.now();

function pickMarket(asset: string): Market {
  const live = liveByAsset(asset, now(), EXPIRY_SAFETY_MS).sort((a, b) => b.expiryMs - a.expiryMs);
  const m = live[0];
  if (!m) throw new PlayError('MARKET_UNAVAILABLE', `No live ${asset} market right now`);
  return m;
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

const nearestTick = (v: bigint, tick: bigint): bigint => {
  const floor = (v / tick) * tick;
  return v - floor >= tick / 2n ? floor + tick : floor;
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

// Binary strike for a leverage bucket: spot offset by the bucket distance, in the side's
// direction (call above spot, put below), snapped to the oracle grid.
function binaryStrike(spot1e9: bigint, side: Side, leverage: number, g: Grid): bigint {
  const pct = BUCKET_DISTANCE_PCT[leverage] ?? 0.004;
  const rawDist = (spot1e9 * BigInt(Math.round(pct * 1e6))) / 1_000_000n;
  let distTicks = rawDist / g.tick;
  if (rawDist % g.tick >= g.tick / 2n) distTicks += 1n;
  const minTicks = BUCKET_MIN_TICKS[leverage] ?? 0n;
  if (distTicks < minTicks) distTicks = minTicks;
  const base = nearestTick(spot1e9, g.tick);
  const raw = side === 'up' ? base + distTicks * g.tick : base - distTicks * g.tick;
  return clampStrike(raw, g);
}

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
  leverage: number;
  duration: number;
  strikeDisplay: string;
  entryCost: bigint;
  maxPayout: bigint; // settled ITM payout = quantity ($1 per contract)
  multiplier: number;
  seed: string;
};

export type ResolvedRange = {
  kind: 'range';
  game: 'range' | 'tap';
  market: Market;
  params: RangeParams;
  asset: string;
  lowerDisplay: string;
  upperDisplay: string;
  widthPct?: number;
  duration: number;
  entryCost: bigint;
  maxPayout: bigint;
  multiplier: number;
};

export type Resolved = ResolvedBinary | ResolvedRange;

// I Feel Lucky: fair server RNG picks asset/side, the player sets the bet (knob), round length
// (Action 1) and risk tier (Action 2); we draw the leverage within the tier and size the binary.
export async function resolveLucky(stakeRaw: bigint, opts: { duration?: number; risk?: RiskTier } = {}): Promise<ResolvedBinary> {
  const assets = liveAssets();
  if (assets.length === 0) throw new PlayError('MARKET_UNAVAILABLE', 'No markets are live right now');

  const seed = newSeed();
  const asset = assets[Math.floor(seedFloat(seed, 0) * assets.length)];
  const side: Side = seedFloat(seed, 1) < 0.5 ? 'up' : 'down';
  // Leverage: a rehearsed demo can pin it via env; otherwise fair RNG within the chosen risk tier.
  const allowed = RISK_BUCKETS[opts.risk ?? 'wild'] ?? LEVERAGE_BUCKETS;
  const leverage = LEVERAGE_BUCKETS.includes(DEMO_LUCKY_LEVERAGE as (typeof LEVERAGE_BUCKETS)[number])
    ? DEMO_LUCKY_LEVERAGE
    : pickWeighted(seedFloat(seed, 2), riskWeights(allowed));
  // Round length: env pin (demo) > the player's pick > fair RNG.
  const duration = GAME_DURATIONS.includes(DEMO_LUCKY_DURATION)
    ? DEMO_LUCKY_DURATION
    : opts.duration != null && GAME_DURATIONS.includes(opts.duration)
      ? opts.duration
      : GAME_DURATIONS[Math.floor(seedFloat(seed, 3) * GAME_DURATIONS.length)] ?? GAME_DURATIONS[0];

  const market = pickMarket(asset);
  const spot = await freshSpot(market);
  const g = gridOf(market);
  const strike = binaryStrike(spot, side, leverage, g);

  const mk = (q: bigint): BinaryParams => ({ oracleId: market.oracleId, expiryMs: market.expiryMs, strike1e9: strike, side, quantity: q });
  const { quantity, amounts } = await solveQuantity((q) => previewMint(mk(q)), stakeRaw);

  return {
    kind: 'binary',
    game: 'lucky',
    market,
    params: mk(quantity),
    asset,
    side,
    leverage,
    duration,
    strikeDisplay: fmt1e9(strike),
    entryCost: amounts.cost,
    maxPayout: quantity,
    multiplier: multiplierOf(amounts.cost, quantity),
    seed,
  };
}

// Range: the knob's band width sets [lower, upper] around spot; tighter pays more.
export async function resolveRange(stakeRaw: bigint, asset: string, widthPct: number, duration: number): Promise<ResolvedRange> {
  if (!GAME_DURATIONS.includes(duration)) throw new PlayError('INVALID_PARAMS', 'Unsupported round duration');
  if (!(widthPct > 0) || widthPct > 10) throw new PlayError('INVALID_PARAMS', 'Band width out of range');

  const market = pickMarket(asset);
  const spot = await freshSpot(market);
  const g = gridOf(market);
  const { lower, higher } = rangeBand(spot, widthPct, g);

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
    entryCost: amounts.cost,
    maxPayout: quantity,
    multiplier: multiplierOf(amounts.cost, quantity),
  };
}

// Tap: one tapped box is a range position at the box's band (display USD bounds).
export async function resolveTap(stakeRaw: bigint, asset: string, band: { lower: number; upper: number }, duration: number): Promise<ResolvedRange> {
  if (!GAME_DURATIONS.includes(duration)) throw new PlayError('INVALID_PARAMS', 'Unsupported round duration');
  if (!(band.lower < band.upper)) throw new PlayError('INVALID_PARAMS', 'Invalid tap band');

  const market = pickMarket(asset);
  await freshSpot(market);
  const g = gridOf(market);
  let lower = clampStrike(floorTick(usd1e9(band.lower), g.tick), g);
  let higher = clampStrike(ceilTick(usd1e9(band.upper), g.tick), g);
  if (higher <= lower) higher = clampStrike(lower + g.tick, g);
  if (higher <= lower) throw new PlayError('INVALID_PARAMS', 'Invalid tap band');

  const mk = (q: bigint): RangeParams => ({ oracleId: market.oracleId, expiryMs: market.expiryMs, lower1e9: lower, higher1e9: higher, quantity: q });
  const { quantity, amounts } = await solveQuantity((q) => previewRange(mk(q)), stakeRaw);

  return {
    kind: 'range',
    game: 'tap',
    market,
    params: mk(quantity),
    asset,
    lowerDisplay: fmt1e9(lower),
    upperDisplay: fmt1e9(higher),
    duration,
    entryCost: amounts.cost,
    maxPayout: quantity,
    multiplier: multiplierOf(amounts.cost, quantity),
  };
}
