import {
  EXPIRY_SAFETY_MS,
  IS_REAL_PREDICT,
  LUCKY_MIN_ORACLE_LIFE_MS,
  LUCKY_MIN_TARGET_FRAC,
  LUCKY_ROUND_MS,
  RANGE_MAX_ORACLE_LIFE_MS,
  RANGE_MIN_ORACLE_LIFE_MS,
} from '../config/main-config.ts';
import {
  DUSDC_DECIMALS,
  FLOAT_SCALING,
  ORACLE_STRIKE_GRID_TICKS,
  multiplier as multiplierOf,
} from '../lib/sui/config.ts';
import { liveByAsset, tradeableMarkets, type Market } from '../lib/sui/markets.ts';
import {
  previewBinaryBatch,
  previewRange,
  previewRangeBatch,
  readOracle,
  type Side,
  type TradeAmounts,
} from '../lib/sui/predict.ts';
import { solveStrike, type BatchPreviewFn, type ScanCurve } from '../lib/sui/solver.ts';
import type { RangeQuoteDTO as RangeQuote } from '../types/api.ts';
import { sleep } from '../utils/miscUtils.ts';
import { PlayError, type ResolvedBinary, type ResolvedRange } from './games-base.ts';
import { quoteRangeBatchReal } from './games-real.ts';
import { newSeed, pickTier, seedFloat } from './rng.ts';

const SOLVE_CURVE_TTL_MS = 3000;
const curveCache = new Map<string, { curve: ScanCurve; at: number }>();
const now = (): number => Date.now();

function getFreshCurve(key: string, at: number): ScanCurve | undefined {
  const hit = curveCache.get(key);
  return hit && at - hit.at < SOLVE_CURVE_TTL_MS ? hit.curve : undefined;
}

function putCurve(key: string, curve: ScanCurve, at: number): void {
  if (curveCache.size > 64) {
    for (const [cacheKey, value] of curveCache) {
      if (at - value.at >= SOLVE_CURVE_TTL_MS) curveCache.delete(cacheKey);
    }
  }
  curveCache.set(key, { curve, at });
}

async function rangeOracle(asset: string): Promise<Market> {
  const inWindow = (market: Market, at: number): boolean => {
    const life = market.expiryMs - at;
    return life >= RANGE_MIN_ORACLE_LIFE_MS && life <= RANGE_MAX_ORACLE_LIFE_MS;
  };

  for (let attempt = 0; attempt < 8; attempt++) {
    const at = now();
    const live = liveByAsset(asset, at, EXPIRY_SAFETY_MS);
    if (live.length === 0) throw new PlayError('MARKET_UNAVAILABLE', `No live ${asset} market right now`);
    const inBand = live.filter((market) => inWindow(market, at));
    if (inBand.length) return inBand.reduce((best, market) => (market.expiryMs > best.expiryMs ? market : best));
    if (attempt < 7) await sleep(500);
  }

  const fallbackMinLifeMs = 13_000;
  const at = now();
  const live = liveByAsset(asset, at, fallbackMinLifeMs);
  if (live.length === 0) throw new PlayError('MARKET_UNAVAILABLE', `No live ${asset} market right now`);
  const target = at + RANGE_MAX_ORACLE_LIFE_MS;
  return live.reduce((best, market) => (Math.abs(market.expiryMs - target) < Math.abs(best.expiryMs - target) ? market : best));
}

function roundOracle(asset: string): Market | undefined {
  const at = now();
  const live = liveByAsset(asset, at, EXPIRY_SAFETY_MS);
  if (live.length === 0) return undefined;
  const roomy = live.filter((market) => market.expiryMs - at >= LUCKY_MIN_ORACLE_LIFE_MS);
  if (roomy.length === 0) return live.reduce((best, market) => (market.expiryMs > best.expiryMs ? market : best));
  const target = at + LUCKY_ROUND_MS;
  return roomy.reduce((best, market) => (Math.abs(market.expiryMs - target) < Math.abs(best.expiryMs - target) ? market : best));
}

export function liveAssets(): string[] {
  return [...new Set(tradeableMarkets(now(), EXPIRY_SAFETY_MS).map((market) => market.underlying))];
}

async function freshSpot(market: Market): Promise<bigint> {
  const state = await readOracle(market.oracleId);
  if (!state) throw new PlayError('MARKET_UNAVAILABLE', 'Market oracle not found');
  if (state.settled || !state.active) throw new PlayError('MARKET_UNAVAILABLE', 'Market is not active');
  if (state.spot1e9 <= 0n) throw new PlayError('ORACLE_STALE', 'Market has no price yet');
  if (now() - state.timestampMs > 30_000) throw new PlayError('ORACLE_STALE', 'Market price is stale');
  return state.spot1e9;
}

type Grid = { tick: bigint; min: bigint; max: bigint };

const gridOf = (market: Market): Grid => {
  const tick = BigInt(market.tickSize);
  const min = BigInt(market.minStrike);
  return { tick, min, max: min + tick * (ORACLE_STRIKE_GRID_TICKS - 1n) };
};

const floorTick = (value: bigint, tick: bigint): bigint => (value / tick) * tick;
const ceilTick = (value: bigint, tick: bigint): bigint => {
  const floored = (value / tick) * tick;
  return floored === value ? floored : floored + tick;
};
const clampStrike = (value: bigint, grid: Grid): bigint => {
  if (value < grid.min + grid.tick) return grid.min + grid.tick;
  if (value > grid.max - grid.tick) return grid.max - grid.tick;
  return value;
};

function rangeBand(spot1e9: bigint, widthPct: number, grid: Grid): { lower: bigint; higher: bigint } {
  const halfFrac = widthPct / 100 / 2;
  const half = (spot1e9 * BigInt(Math.round(halfFrac * 1e9))) / FLOAT_SCALING;
  const lower = clampStrike(floorTick(spot1e9 - half, grid.tick), grid);
  let higher = clampStrike(ceilTick(spot1e9 + half, grid.tick), grid);
  if (higher <= lower) higher = clampStrike(lower + grid.tick, grid);
  return { lower, higher };
}

const fmt1e9 = (value: bigint): string => String(Number(value) / 1e9);

async function solveQuantity(
  preview: (quantity: bigint) => Promise<TradeAmounts>,
  stakeRaw: bigint,
): Promise<{ quantity: bigint; amounts: TradeAmounts }> {
  const probe = DUSDC_DECIMALS;
  let amounts: TradeAmounts;
  try {
    amounts = await preview(probe);
  } catch (error) {
    throw new PlayError('MINT_FAILED', `Could not price this play: ${error instanceof Error ? error.message : error}`);
  }
  if (amounts.cost <= 0n) throw new PlayError('MINT_FAILED', 'Market returned a zero price');

  const target = stakeRaw;
  let quantity = (probe * target) / amounts.cost;
  if (quantity <= 0n) quantity = 1n;

  for (let i = 0; i < 2; i++) {
    amounts = await preview(quantity);
    if (amounts.cost <= 0n) throw new PlayError('MINT_FAILED', 'Market returned a zero price');
    if (amounts.cost <= stakeRaw && amounts.cost * 100n >= target * 96n) break;
    quantity = (quantity * target) / amounts.cost;
    if (quantity <= 0n) quantity = 1n;
  }

  let guard = 0;
  while (amounts.cost > stakeRaw && guard < 3) {
    quantity = (quantity * stakeRaw) / amounts.cost;
    quantity = quantity > 1n ? quantity - 1n : 1n;
    amounts = await preview(quantity);
    guard++;
  }

  if (amounts.cost > stakeRaw) throw new PlayError('MINT_FAILED', 'Could not size this play within your stake');
  return { quantity, amounts };
}

export async function resolveLucky(stakeRaw: bigint, existingSeed?: string): Promise<ResolvedBinary> {
  const assets = liveAssets();
  if (assets.length === 0) throw new PlayError('MARKET_UNAVAILABLE', 'No markets are live right now');

  const seed = existingSeed ?? newSeed();
  const asset = assets[Math.floor(seedFloat(seed, 0) * assets.length)];
  const side: Side = seedFloat(seed, 1) < 0.5 ? 'up' : 'down';
  const tier = pickTier(seedFloat(seed, 2));

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const market = roundOracle(asset);
    if (!market) throw new PlayError('MARKET_UNAVAILABLE', `No live ${asset} market right now`);
    const grid = gridOf(market);
    const preview: BatchPreviewFn = async (probes) => {
      const amounts = await previewBinaryBatch(market.oracleId, market.expiryMs, side, probes);
      return amounts.map((amount) => (amount.cost > 0n ? amount : null));
    };

    try {
      const cacheKey = `${market.oracleId}:${side}`;
      const at = now();
      const curve = getFreshCurve(cacheKey, at);
      const atm1e9 = market.spot1e9 ? BigInt(market.spot1e9) : undefined;
      const minOffset1e9 = atm1e9 ? (atm1e9 * BigInt(Math.round(LUCKY_MIN_TARGET_FRAC * 1e9))) / FLOAT_SCALING : undefined;
      const solution = await solveStrike({ grid, side, tierMultiplier: tier, betRaw: stakeRaw, preview, curve, atm1e9, minOffset1e9, analyticSize: true });
      if (!curve) putCurve(cacheKey, solution.curve, at);
      const duration = Math.max(1, Math.round((market.expiryMs - now()) / 1000));
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
        entrySpot: market.spot1e9 ? fmt1e9(BigInt(market.spot1e9)) : '',
        entryCost: solution.entryCost,
        maxPayout: solution.quantity,
        multiplier: solution.multiplier,
        seed,
      };
    } catch (error) {
      lastErr = error;
      if (attempt === 0) continue;
      throw new PlayError('MINT_FAILED', `Could not price this play: ${error instanceof Error ? error.message : error}`);
    }
  }

  throw new PlayError('MINT_FAILED', `Could not price this play: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
}

export async function resolveMoonshot(stakeRaw: bigint, asset: string, side: Side, reach: number): Promise<ResolvedBinary> {
  if (side !== 'up' && side !== 'down') throw new PlayError('INVALID_PARAMS', 'Pick a direction');
  if (!Number.isFinite(reach)) throw new PlayError('INVALID_PARAMS', 'Pick a reach');
  const tier = Math.max(2, Math.min(25, reach));
  if (!liveAssets().includes(asset)) throw new PlayError('MARKET_UNAVAILABLE', `No live ${asset} market right now`);

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const market = roundOracle(asset);
    if (!market) throw new PlayError('MARKET_UNAVAILABLE', `No live ${asset} market right now`);
    const grid = gridOf(market);
    const preview: BatchPreviewFn = async (probes) => {
      const amounts = await previewBinaryBatch(market.oracleId, market.expiryMs, side, probes);
      return amounts.map((amount) => (amount.cost > 0n ? amount : null));
    };

    try {
      const cacheKey = `${market.oracleId}:${side}`;
      const at = now();
      const curve = getFreshCurve(cacheKey, at);
      const atm1e9 = market.spot1e9 ? BigInt(market.spot1e9) : undefined;
      const minOffset1e9 = atm1e9 ? (atm1e9 * BigInt(Math.round(LUCKY_MIN_TARGET_FRAC * 1e9))) / FLOAT_SCALING : undefined;
      const solution = await solveStrike({ grid, side, tierMultiplier: tier, betRaw: stakeRaw, preview, curve, atm1e9, minOffset1e9, analyticSize: true });
      if (!curve) putCurve(cacheKey, solution.curve, at);
      const duration = Math.max(1, Math.round((market.expiryMs - now()) / 1000));
      return {
        kind: 'binary',
        game: 'moonshot',
        market,
        params: { oracleId: market.oracleId, expiryMs: market.expiryMs, strike1e9: solution.strike1e9, side, quantity: solution.quantity },
        asset,
        side,
        tier: solution.achievedTier,
        duration,
        strikeDisplay: fmt1e9(solution.strike1e9),
        entrySpot: market.spot1e9 ? fmt1e9(BigInt(market.spot1e9)) : '',
        entryCost: solution.entryCost,
        maxPayout: solution.quantity,
        multiplier: solution.multiplier,
        seed: '',
      };
    } catch (error) {
      lastErr = error;
      if (attempt === 0) continue;
      throw new PlayError('MINT_FAILED', `Could not price this play: ${error instanceof Error ? error.message : error}`);
    }
  }

  throw new PlayError('MINT_FAILED', `Could not price this play: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
}

export async function resolveRange(stakeRaw: bigint, asset: string, widthPct: number): Promise<ResolvedRange> {
  if (!(widthPct > 0) || widthPct > 10) throw new PlayError('INVALID_PARAMS', 'Band width out of range');

  const market = await rangeOracle(asset);
  const spot = await freshSpot(market);
  const grid = gridOf(market);
  const { lower, higher } = rangeBand(spot, widthPct, grid);
  const duration = Math.max(1, Math.round((market.expiryMs - now()) / 1000));
  const makeParams = (quantity: bigint) => ({
    oracleId: market.oracleId,
    expiryMs: market.expiryMs,
    lower1e9: lower,
    higher1e9: higher,
    quantity,
  });
  const { quantity, amounts } = await solveQuantity((q) => previewRange(makeParams(q)), stakeRaw);

  return {
    kind: 'range',
    game: 'range',
    market,
    params: makeParams(quantity),
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

export async function quoteRangeBatch(asset: string, widthPcts: number[]): Promise<RangeQuote[]> {
  if (IS_REAL_PREDICT) return quoteRangeBatchReal(widthPcts);

  const widths = widthPcts.filter((width) => width > 0 && width <= 10);
  if (widths.length === 0) throw new PlayError('INVALID_PARAMS', 'No valid band widths');

  const market = await rangeOracle(asset);
  const spot = await freshSpot(market);
  const grid = gridOf(market);
  const duration = Math.max(1, Math.round((market.expiryMs - now()) / 1000));
  const probe = DUSDC_DECIMALS;
  const bands = widths.map((widthPct) => ({ widthPct, ...rangeBand(spot, widthPct, grid) }));

  let amounts: TradeAmounts[];
  try {
    amounts = await previewRangeBatch(
      market.oracleId,
      market.expiryMs,
      bands.map((band) => ({ lower1e9: band.lower, higher1e9: band.higher, quantity: probe })),
    );
  } catch (error) {
    throw new PlayError('MARKET_UNAVAILABLE', `Could not price these bands: ${error instanceof Error ? error.message : error}`);
  }

  return bands.map((band, index) => ({
    multiplier: multiplierOf(amounts[index].cost, probe),
    lower: fmt1e9(band.lower),
    upper: fmt1e9(band.higher),
    entrySpot: fmt1e9(spot),
    duration,
    widthPct: band.widthPct,
  }));
}
