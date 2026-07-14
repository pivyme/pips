import {
  EXPIRY_SAFETY_MS,
  LUCKY_ROUND_MS,
  RANGE_MAX_ORACLE_LIFE_MS,
  RANGE_MIN_ORACLE_LIFE_MS,
  REAL_BTC_ANNUAL_VOL,
  REAL_RANGE_MAX_PROB,
  REAL_STRIKE_MAX_OFFSET_FRAC,
  REAL_STRIKE_MIN_PROB,
} from '../config/main-config.ts';
import { FLOAT_SCALING } from '../lib/sui/config.ts';
import { liveByAsset, type Market } from '../lib/sui/markets.ts';
import { LEVERAGE_ONE, POSITION_LOT_SIZE, ticksForBinary, ticksForRange } from '../lib/sui/predict-real.ts';
import type { Side } from '../lib/sui/predict.ts';
import type { Game, RangeQuoteDTO as RangeQuote } from '../types/api.ts';
import { PlayError } from './games-base.ts';
import { newSeed, pickTier, seedFloat } from './rng.ts';

const REAL_BTC_GAME_ASSET = 'BTC';
const REAL_FEE_HEADROOM_PCT = 12n;
const SECONDS_PER_YEAR = 365.25 * 24 * 3600;
const REAL_RANGE_QUOTE_HAIRCUT = 0.04;
const now = (): number => Date.now();

export type ResolvedReal = {
  game: Game;
  kind: 'binary' | 'range';
  marketId: string;
  asset: string;
  lowerTick: bigint;
  higherTick: bigint;
  leverage1e9: bigint;
  amountRaw: bigint;
  depositCeilRaw: bigint;
  minQuantityRaw: bigint;
  expiryMs: number;
  duration: number;
  entrySpot: string;
  tierMultiplier: number;
  side?: Side;
  strikeDisplay?: string;
  lowerDisplay?: string;
  upperDisplay?: string;
  widthPct?: number;
  seed?: string;
};

export type CreatePlayInputShape =
  | { game: 'lucky'; stake: string | number }
  | { game: 'range'; stake: string | number; asset: string; widthPct: number }
  | { game: 'moonshot'; stake: string | number; asset: string; side: Side; reach: number };

function realMarket(roundMs: number): Market {
  const at = now();
  const live = liveByAsset(REAL_BTC_GAME_ASSET, at, EXPIRY_SAFETY_MS);
  if (live.length === 0) throw new PlayError('MARKET_UNAVAILABLE', 'No live market right now');
  const target = at + roundMs;
  return live.reduce((best, market) => (Math.abs(market.expiryMs - target) < Math.abs(best.expiryMs - target) ? market : best));
}

function realEcon(market: Market): { spot1e9: bigint; tickSize: bigint; admissionTickSize: bigint; maxLeverage1e9: bigint } {
  if (!market.spot1e9 || !market.admissionTickSizeRaw) throw new PlayError('ORACLE_STALE', 'Market has no price yet');
  return {
    spot1e9: BigInt(market.spot1e9),
    tickSize: BigInt(market.tickSize),
    admissionTickSize: BigInt(market.admissionTickSizeRaw),
    maxLeverage1e9: market.maxLeverage1e9 ? BigInt(market.maxLeverage1e9) : LEVERAGE_ONE,
  };
}

export function probit(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - lo) {
    const q = p - 0.5, r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function roundSigmaFrac(seconds: number): number {
  return REAL_BTC_ANNUAL_VOL * Math.sqrt(Math.max(1, seconds) / SECONDS_PER_YEAR);
}

function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

function rangeWinProb(halfFrac: number, sigma: number): number {
  const p = 2 * normCdf(halfFrac / Math.max(sigma, 1e-9)) - 1;
  return Math.min(REAL_RANGE_MAX_PROB, Math.max(0.02, p));
}

export function binaryOffsetFrac(strikeTier: number, seconds: number): number {
  const p = Math.min(1 - REAL_STRIKE_MIN_PROB, Math.max(REAL_STRIKE_MIN_PROB, 1 / strikeTier));
  const off = probit(1 - p) * roundSigmaFrac(seconds);
  return Math.max(-REAL_STRIKE_MAX_OFFSET_FRAC, Math.min(REAL_STRIKE_MAX_OFFSET_FRAC, off));
}

function luckyLeverage(tier: number, maxLeverage1e9: bigint): bigint {
  const want1e9 = BigInt(Math.round((tier / 2) * 1e9));
  const capped = want1e9 < maxLeverage1e9 ? want1e9 : maxLeverage1e9;
  return capped > LEVERAGE_ONE ? capped : LEVERAGE_ONE;
}

const premiumBudget = (stakeRaw: bigint): bigint => (stakeRaw * (100n - REAL_FEE_HEADROOM_PCT)) / 100n;
const realFmt = (value: bigint): string => String(Number(value) / 1e9);

function resolveRealBinary(game: 'lucky' | 'moonshot', stakeRaw: bigint, side: Side, tier: number, seed?: string): ResolvedReal {
  const market = realMarket(LUCKY_ROUND_MS);
  const { spot1e9, tickSize, admissionTickSize, maxLeverage1e9 } = realEcon(market);
  const seconds = Math.max(1, (market.expiryMs - now()) / 1000);
  const leverage1e9 = game === 'lucky' ? luckyLeverage(tier, maxLeverage1e9) : LEVERAGE_ONE;
  const strikeTier = tier / (Number(leverage1e9) / 1e9);
  const offset = BigInt(Math.round(binaryOffsetFrac(strikeTier, seconds) * 1e9));
  const strike1e9 = side === 'up' ? (spot1e9 * (FLOAT_SCALING + offset)) / FLOAT_SCALING : (spot1e9 * (FLOAT_SCALING - offset)) / FLOAT_SCALING;
  const { lowerTick, higherTick } = ticksForBinary(side, strike1e9, tickSize, admissionTickSize);
  return {
    game,
    kind: 'binary',
    marketId: market.oracleId,
    asset: REAL_BTC_GAME_ASSET,
    lowerTick,
    higherTick,
    leverage1e9,
    amountRaw: premiumBudget(stakeRaw),
    depositCeilRaw: stakeRaw,
    minQuantityRaw: POSITION_LOT_SIZE,
    expiryMs: market.expiryMs,
    duration: Math.max(1, Math.round(seconds)),
    entrySpot: realFmt(spot1e9),
    tierMultiplier: tier,
    side,
    strikeDisplay: realFmt(strike1e9),
    seed,
  };
}

function resolveRealRange(stakeRaw: bigint, widthPct: number): ResolvedReal {
  if (!(widthPct > 0) || widthPct > 10) throw new PlayError('INVALID_PARAMS', 'Band width out of range');
  const market = realMarket(Math.round((RANGE_MIN_ORACLE_LIFE_MS + RANGE_MAX_ORACLE_LIFE_MS) / 2));
  const { spot1e9, tickSize, admissionTickSize } = realEcon(market);
  const seconds = Math.max(1, (market.expiryMs - now()) / 1000);
  const maxHalfFrac = probit((1 + REAL_RANGE_MAX_PROB) / 2) * roundSigmaFrac(seconds);
  const halfFrac = Math.min(widthPct / 100 / 2, maxHalfFrac);
  const half = (spot1e9 * BigInt(Math.round(halfFrac * 1e9))) / FLOAT_SCALING;
  const { lowerTick, higherTick } = ticksForRange(spot1e9 - half, spot1e9 + half, tickSize, admissionTickSize);
  return {
    game: 'range',
    kind: 'range',
    marketId: market.oracleId,
    asset: REAL_BTC_GAME_ASSET,
    lowerTick,
    higherTick,
    leverage1e9: LEVERAGE_ONE,
    amountRaw: premiumBudget(stakeRaw),
    depositCeilRaw: stakeRaw,
    minQuantityRaw: POSITION_LOT_SIZE,
    expiryMs: market.expiryMs,
    duration: Math.max(1, Math.round(seconds)),
    entrySpot: realFmt(spot1e9),
    tierMultiplier: 0,
    lowerDisplay: realFmt(spot1e9 - half),
    upperDisplay: realFmt(spot1e9 + half),
    widthPct,
  };
}

export function quoteRangeBatchReal(widthPcts: number[]): RangeQuote[] {
  const widths = widthPcts.filter((width) => width > 0 && width <= 10);
  if (widths.length === 0) return [];
  try {
    const market = realMarket(Math.round((RANGE_MIN_ORACLE_LIFE_MS + RANGE_MAX_ORACLE_LIFE_MS) / 2));
    const { spot1e9 } = realEcon(market);
    const spot = Number(spot1e9) / 1e9;
    const seconds = Math.max(1, (market.expiryMs - now()) / 1000);
    const sigma = roundSigmaFrac(seconds);
    const maxHalfFrac = probit((1 + REAL_RANGE_MAX_PROB) / 2) * sigma;
    const duration = Math.max(1, Math.round(seconds));
    return widths.map((widthPct) => {
      const halfFrac = Math.min(widthPct / 100 / 2, maxHalfFrac);
      const p = rangeWinProb(halfFrac, sigma);
      const mult = Math.max(1.01, (1 / p) * (1 - REAL_RANGE_QUOTE_HAIRCUT));
      const half = spot * halfFrac;
      return { multiplier: mult, lower: String(spot - half), upper: String(spot + half), entrySpot: String(spot), duration, widthPct };
    });
  } catch {
    return [];
  }
}

export function resolveReal(input: CreatePlayInputShape, stakeRaw: bigint, seed?: string): ResolvedReal {
  if (input.game === 'lucky') {
    const actualSeed = seed ?? newSeed();
    const side: Side = seedFloat(actualSeed, 1) < 0.5 ? 'up' : 'down';
    const tier = pickTier(seedFloat(actualSeed, 2));
    return resolveRealBinary('lucky', stakeRaw, side, tier, actualSeed);
  }
  if (input.game === 'moonshot') {
    if (input.side !== 'up' && input.side !== 'down') throw new PlayError('INVALID_PARAMS', 'Pick a direction');
    if (!Number.isFinite(input.reach)) throw new PlayError('INVALID_PARAMS', 'Pick a reach');
    return resolveRealBinary('moonshot', stakeRaw, input.side, Math.max(2, Math.min(25, input.reach)));
  }
  return resolveRealRange(stakeRaw, input.widthPct);
}
