// Per-game parameter resolution. Turns a stake (and, for Lucky, a fair server RNG) into a
// concrete Predict position: a live market, a grid-aligned strike or band, and a quantity
// sized so the real mint cost lands at the stake. Everything is quoted against the live
// oracle via the Predict preview, so the reported multiplier is honest, never invented.

import {
  EXPIRY_SAFETY_MS,
  IS_REAL_PREDICT,
  LUCKY_ROUND_MS,
  LUCKY_MIN_ORACLE_LIFE_MS,
  LUCKY_MIN_TARGET_FRAC,
  RANGE_MIN_ORACLE_LIFE_MS,
  RANGE_MAX_ORACLE_LIFE_MS,
  MIN_STAKE,
  MAX_STAKE,
  REAL_BTC_ANNUAL_VOL,
  REAL_STRIKE_MIN_PROB,
  REAL_STRIKE_MAX_OFFSET_FRAC,
  REAL_RANGE_MAX_PROB,
} from '../config/main-config.ts';
import {
  DUSDC_DECIMALS,
  FLOAT_SCALING,
  ORACLE_STRIKE_GRID_TICKS,
  toDusdcRaw,
  multiplier as multiplierOf,
} from '../lib/sui/config.ts';
import { liveByAsset, tradeableMarkets, type Market } from '../lib/sui/markets.ts';
import { sleep } from '../utils/miscUtils.ts';
import {
  previewBinaryBatch,
  previewRange,
  previewRangeBatch,
  readOracle,
  type BinaryParams,
  type RangeParams,
  type Side,
  type TradeAmounts,
} from '../lib/sui/predict.ts';
import { solveStrike, type BatchPreviewFn, type ScanCurve } from '../lib/sui/solver.ts';
import {
  ticksForBinary,
  ticksForRange,
  POSITION_LOT_SIZE,
  LEVERAGE_ONE,
} from '../lib/sui/predict-real.ts';
import { newSeed, seedFloat, pickTier } from './rng.ts';
import type { Game, RangeQuoteDTO as RangeQuote } from '../types/api.ts';

// Cache the dense strike-price curve per (oracle, side) for a short TTL. The curve only drifts as
// spot moves (price-pusher every ~2s), so within the TTL a play reuses it and skips the scan round
// trip, leaving just the sizing probe. The sizing preview re-prices fresh, so a warm curve never
// makes the reported cost/multiplier stale. Bounded so a long-lived process never grows it without
// limit; entries fall out as oracles roll.
const SOLVE_CURVE_TTL_MS = 3000;
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
  | 'PREDICT_VAULT_CAPACITY'
  | 'PLAYS_PAUSED'
  | 'RATE_LIMITED';

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
    case 'RATE_LIMITED':
      return 429;
    case 'PLAYS_PAUSED':
      return 503;
    case 'MINT_FAILED':
    case 'REDEEM_FAILED':
      return 502;
    default:
      return 500;
  }
};

// === Market + grid helpers ===

const now = (): number => Date.now();

// The live oracle a RANGE play routes to. Range wants a bounded hold (the old longest-lived pick gave
// inconsistent ~90s rounds), so it routes to a rung expiring inside [MIN, MAX] and takes the longest
// such, landing the round as close to the 30s cap as the ladder offers (~22-30s). That window is
// narrower than the rung spacing, so it can be momentarily empty; rather than restructure the ladder
// we wait a beat. Rungs age down into the window continuously (a 31s rung is 29s two seconds later),
// so within ~3s one always drops in. If a degraded ladder exhausts the wait, fall back to the rung
// nearest the cap so a play still lands close to the band rather than failing outright.
async function rangeOracle(asset: string): Promise<Market> {
  const inWindow = (m: Market, t: number): boolean => {
    const life = m.expiryMs - t;
    return life >= RANGE_MIN_ORACLE_LIFE_MS && life <= RANGE_MAX_ORACLE_LIFE_MS;
  };
  for (let attempt = 0; attempt < 8; attempt++) {
    const t = now();
    const live = liveByAsset(asset, t, EXPIRY_SAFETY_MS);
    if (live.length === 0) throw new PlayError('MARKET_UNAVAILABLE', `No live ${asset} market right now`);
    const inBand = live.filter((m) => inWindow(m, t));
    if (inBand.length) return inBand.reduce((best, m) => (m.expiryMs > best.expiryMs ? m : best));
    if (attempt < 7) await sleep(500); // a rung ages into the window within ~3s
  }
  // Wait exhausted (degraded ladder): route to the rung nearest the cap, but still require enough life
  // that the round OPENS with a real cash-out window after the background mint. EXPIRY_SAFETY_MS (the
  // settlement freeze) + the client's lock-in window (~5s) + mint latency means a sub-~13s rung would
  // land the player straight in the sealed/settling window with CASH OUT never offered for a position
  // they paid for. Below that floor, fail cleanly (the client re-racks with a toast) rather than open a
  // cash-out-less round. Mirrors LUCKY_MIN_ORACLE_LIFE_MS, which exists for the same reason.
  const FALLBACK_MIN_LIFE_MS = 13_000;
  const t = now();
  const live = liveByAsset(asset, t, FALLBACK_MIN_LIFE_MS);
  if (live.length === 0) throw new PlayError('MARKET_UNAVAILABLE', `No live ${asset} market right now`);
  const target = t + RANGE_MAX_ORACLE_LIFE_MS;
  return live.reduce((best, m) => (Math.abs(m.expiryMs - target) < Math.abs(best.expiryMs - target) ? m : best));
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

// Invert the curve-priced mint cost: find the quantity whose real preview cost lands at the
// stake, capped just under it by the hard guard below so the mint never overdraws. A short
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

  const target = stakeRaw; // aim at the full stake; the hard guard below caps cost so it never exceeds it
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
  game: 'lucky' | 'moonshot';
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

  // Route to the oracle expiring nearest the round target and solve in a few batched round trips.
  // The asset/side/tier are fixed by the seed (fairness); only the oracle is re-picked if the first
  // one expires mid-solve, which the batched preview surfaces as a thrown error.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const market = roundOracle(asset);
    if (!market) throw new PlayError('MARKET_UNAVAILABLE', `No live ${asset} market right now`);
    const g = gridOf(market);

    // One batched devInspect per solver round. cost == 0 means that strike is unmintable.
    const preview: BatchPreviewFn = async (probes) => {
      const amts = await previewBinaryBatch(market.oracleId, market.expiryMs, side, probes);
      return amts.map((a) => (a.cost > 0n ? a : null));
    };

    try {
      // Reuse a fresh cached scan for this oracle/side when one exists, so a warm play skips the
      // scan round trip and only pays for sizing. Cache whatever scan the solve ended up using.
      const cacheKey = `${market.oracleId}:${side}`;
      const t0 = now();
      const curve = getFreshCurve(cacheKey, t0);
      // The live spot centers the scan window on ATM (the cached spot1e9 is pusher-fresh, ~1s old).
      const atm1e9 = market.spot1e9 ? BigInt(market.spot1e9) : undefined;
      // Floor the strike a minimum fraction off spot (LUCKY_MIN_TARGET_FRAC) so even the 2x tier is a
      // real, visible move and the TARGET line never lands on top of ENTRY. Without it the directional
      // gate allowed a strike one tick off spot (the "entry and target basically equal" report).
      const minOffset1e9 = atm1e9 ? (atm1e9 * BigInt(Math.round(LUCKY_MIN_TARGET_FRAC * 1e9))) / FLOAT_SCALING : undefined;
      const solution = await solveStrike({ grid: g, side, tierMultiplier: tier, betRaw: stakeRaw, preview, curve, atm1e9, minOffset1e9, analyticSize: true });
      if (!curve) putCurve(cacheKey, solution.curve, t0);
      if (solution.clamped) {
        // Dealt tier was past the live ask bounds; we minted the closest achievable one and report it.
        console.log(
          `[Lucky] ${asset} ${side} ${tier}x unreachable, solved ${solution.multiplier.toFixed(2)}x (tier ${solution.achievedTier}x)`,
        );
      }
      // The round runs to the routed oracle's expiry, so the UI countdown matches the real settle.
      const duration = Math.max(1, Math.round((market.expiryMs - now()) / 1000));
      // TEMP (debug): the dealt position. Win rule for DOWN is settlement <= strike, for UP settlement > strike.
      console.log(
        `[LuckyDebug] DEAL ${asset} ${side} ${solution.multiplier.toFixed(2)}x | entrySpot=${market.spot1e9 ? fmt1e9(BigInt(market.spot1e9)) : '?'} strike=${fmt1e9(solution.strike1e9)} qty=${solution.quantity} oracle=${market.oracleId.slice(0, 10)} expiry=${new Date(market.expiryMs).toISOString()}`,
      );
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

// MOONSHOT: the player picks what the machine picks in Lucky. They call the direction (LONG = up,
// SHORT = down) and dial a reach (the target multiple = how far OTM the strike sits = conviction);
// the bet sizes it. Same honest binary path as Lucky: the §5 solver finds the grid strike whose real
// live multiple matches the requested reach and sizes the quantity so cost ~= bet, so the multiple we
// surface is one we can actually mint, clamped to the live ask bounds (a too-far reach lands on the
// mintable ceiling). Settles at the routed oracle's expiry (~30s); early cash-out exits at the live mark.
export async function resolveMoonshot(stakeRaw: bigint, asset: string, side: Side, reach: number): Promise<ResolvedBinary> {
  if (side !== 'up' && side !== 'down') throw new PlayError('INVALID_PARAMS', 'Pick a direction');
  if (!Number.isFinite(reach)) throw new PlayError('INVALID_PARAMS', 'Pick a reach');
  // Clamp the dialed reach into the reel's reachable band (2x floor, 25x lotto). The solver clamps to
  // the live ask on top of this, so a wild request still mints at the honest mintable ceiling.
  const tier = Math.max(2, Math.min(25, reach));
  if (!liveAssets().includes(asset)) throw new PlayError('MARKET_UNAVAILABLE', `No live ${asset} market right now`);

  // Route to the oracle expiring nearest the round target and solve in a few batched round trips. Mirrors
  // resolveLucky's loop: the first failure re-routes to a fresh oracle (the old one likely expired
  // mid-solve), a second is a real price error.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const market = roundOracle(asset);
    if (!market) throw new PlayError('MARKET_UNAVAILABLE', `No live ${asset} market right now`);
    const g = gridOf(market);
    const preview: BatchPreviewFn = async (probes) => {
      const amts = await previewBinaryBatch(market.oracleId, market.expiryMs, side, probes);
      return amts.map((a) => (a.cost > 0n ? a : null));
    };
    try {
      const cacheKey = `${market.oracleId}:${side}`;
      const t0 = now();
      const curve = getFreshCurve(cacheKey, t0);
      const atm1e9 = market.spot1e9 ? BigInt(market.spot1e9) : undefined;
      // Floor the strike a minimum fraction off spot so even a 2x reach is a real, visible move and the
      // TARGET line never lands on top of ENTRY (same gate Lucky uses).
      const minOffset1e9 = atm1e9 ? (atm1e9 * BigInt(Math.round(LUCKY_MIN_TARGET_FRAC * 1e9))) / FLOAT_SCALING : undefined;
      const solution = await solveStrike({ grid: g, side, tierMultiplier: tier, betRaw: stakeRaw, preview, curve, atm1e9, minOffset1e9, analyticSize: true });
      if (!curve) putCurve(cacheKey, solution.curve, t0);
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
        seed: '', // moonshot is player-directed, no RNG seed to record
      };
    } catch (e) {
      lastErr = e;
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

  const market = await rangeOracle(asset);
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

// Cheap, mint-faithful multiplier previews for the whole Range band ladder in ONE shot. Same routing
// + grid snap as resolveRange, but a single batched devInspect at a nominal 1.0-contract probe per
// band instead of the stake-sizing solve: the multiple is payout/cost = 1/ask, ~quantity-independent,
// so a fixed probe reads the real number the player would mint at any stake. Pricing every band off
// ONE oracle snapshot keeps the ladder consistent (tighter always pays more) and costs ~1 devInspect
// total. The UI fetches this once on select and caches it, so the pre-PLAY "Pays" is the real locked
// multiple for every band size, never a blind estimate. No solver loop, no DB, no mint.
export async function quoteRangeBatch(asset: string, widthPcts: number[]): Promise<RangeQuote[]> {
  // Real mode (testnet, Mysten Predict): the real protocol has no read-only band pricer we can reach
  // from a PTB (pricing::range_price is public(package), only current_nav is public), and a mint
  // simulate needs a funded wrapper. So we serve no server quote here (never call the fork's predict.ts
  // preview against the real market set). The Range screen falls back to its labelled client estimate
  // for the idle preview and snaps the REAL multiplier in from the mint's OrderMinted event, which is
  // the source of truth. Returning an empty ladder keeps that fallback clean (no fabricated number).
  if (IS_REAL_PREDICT) return [];

  const widths = widthPcts.filter((w) => w > 0 && w <= 10);
  if (widths.length === 0) throw new PlayError('INVALID_PARAMS', 'No valid band widths');

  const market = await rangeOracle(asset);
  const spot = await freshSpot(market);
  const g = gridOf(market);
  const duration = Math.max(1, Math.round((market.expiryMs - now()) / 1000));
  const probe = DUSDC_DECIMALS; // 1.0 contract; payout at settle ITM = $1 * qty = probe (6dp)

  const bands = widths.map((w) => ({ widthPct: w, ...rangeBand(spot, w, g) }));
  let amounts: TradeAmounts[];
  try {
    amounts = await previewRangeBatch(
      market.oracleId,
      market.expiryMs,
      bands.map((b) => ({ lower1e9: b.lower, higher1e9: b.higher, quantity: probe })),
    );
  } catch (e) {
    throw new PlayError('MARKET_UNAVAILABLE', `Could not price these bands: ${e instanceof Error ? e.message : e}`);
  }

  return bands.map((b, i) => ({
    multiplier: multiplierOf(amounts[i].cost, probe), // payout / cost = 1 / ask (0 if unmintable)
    lower: fmt1e9(b.lower),
    upper: fmt1e9(b.higher),
    entrySpot: fmt1e9(spot),
    duration,
    widthPct: b.widthPct,
  }));
}

// === Real-mode resolution (IS_REAL_PREDICT, Mysten's testnet Predict) ===
//
// The real protocol sizes the position itself: mint_exact_amount takes a net-premium BUDGET and a
// leverage, and returns the largest lot-aligned position that fits (chain-side), so the fork's
// iterative quantity solver + preview scan are unnecessary here. Every game resolves to a
// (marketId, lower_tick, higher_tick, leverage, premium-budget) tuple against the ONE live BTC market
// (only BTC_USD is live on testnet; the asset picker still shows ETH/SUI and we silently route to BTC).
// The reel shows the dealt tier optimistically; the REAL minted multiplier is read from the OrderMinted
// event and snapped in after the mint (never a fabricated number, mirrors the fork's actualMultiplier).
//
// LUCKY/MOONSHOT run at leverage 1 in this wave (Phase 10): the tier/reach sets the strike distance
// off spot and the chain prices the resulting multiplier honestly. LUCKY's precise tier -> multiplier
// via real continuous leverage is the Phase 11-12 redesign; this leverage-1 strike map is the interim.

// Game asset for the only live real underlying. The picker keys markets on this; games route here.
const REAL_BTC_GAME_ASSET = 'BTC';
// Fraction of the stake reserved as fee headroom: the deposited chips must cover net premium PLUS the
// trading/builder/penalty fees charged on top (expiry_market.mint_exact_amount), so the premium budget
// is a touch under the stake. The real protocol also hard-floors net premium at $1 (L-011), so the
// stake band (MIN_STAKE) is sized so budget = stake*(1-headroom) clears $1.
const REAL_FEE_HEADROOM_PCT = 12n;

export type ResolvedReal = {
  game: Game;
  kind: 'binary' | 'range';
  marketId: string;
  asset: string; // the asset the player picked (shown); the market underneath is always BTC
  lowerTick: bigint;
  higherTick: bigint;
  leverage1e9: bigint;
  amountRaw: bigint; // net-premium budget passed to mint_exact_amount (stake minus fee headroom)
  depositCeilRaw: bigint; // top the wrapper's internal balance up to this from the wallet before minting
  minQuantityRaw: bigint;
  expiryMs: number;
  duration: number;
  entrySpot: string; // display
  tierMultiplier: number; // the reel's dealt tier / requested reach (snapped to the real mint after)
  side?: Side; // binary
  strikeDisplay?: string; // binary
  lowerDisplay?: string; // range
  upperDisplay?: string; // range
  widthPct?: number; // range
  seed?: string; // lucky (fairness / re-route)
};

// Pick the live BTC market whose expiry sits nearest `roundMs` out. Real 1m markets are spaced ~60s,
// so this lands a round of ~roundMs..60s. Throws a friendly error when none is live (Mysten controls
// the roll; the games then show the existing "no live market" empty state).
function realMarket(roundMs: number): Market {
  const t = now();
  const live = liveByAsset(REAL_BTC_GAME_ASSET, t, EXPIRY_SAFETY_MS);
  if (live.length === 0) throw new PlayError('MARKET_UNAVAILABLE', 'No live market right now');
  const target = t + roundMs;
  return live.reduce((best, m) => (Math.abs(m.expiryMs - target) < Math.abs(best.expiryMs - target) ? m : best));
}

// A market's raw economics (1e9- / raw-scaled) pulled off the record market-sync stamped (never
// hardcoded). Throws if a fork-shaped record slipped through (real economics absent).
function realEcon(m: Market): { spot1e9: bigint; tickSize: bigint; admissionTickSize: bigint; maxLeverage1e9: bigint } {
  if (!m.spot1e9 || !m.admissionTickSizeRaw) throw new PlayError('ORACLE_STALE', 'Market has no price yet');
  return {
    spot1e9: BigInt(m.spot1e9),
    tickSize: BigInt(m.tickSize),
    admissionTickSize: BigInt(m.admissionTickSizeRaw),
    maxLeverage1e9: m.maxLeverage1e9 ? BigInt(m.maxLeverage1e9) : LEVERAGE_ONE,
  };
}

const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

// Inverse standard-normal CDF (Acklam's rational approximation, abs error < 1.2e-9 over 0<p<1). Used
// to size a strike off spot by a target win probability: z = probit(1-p) is how many sigmas OTM the
// strike sits for a p-probability finish. Pure math, no deps. Exported for the strike-sizing test.
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

// Per-round BTC 1-sigma move as a fraction of spot: annual vol scaled by sqrt(time to expiry). On a
// 20-60s market this is tiny (~0.04-0.08% of spot at 55% annual vol), which is exactly why a fixed
// percentage strike (the fork's 0.15%+) lands several sigma OTM and every real mint aborts.
function roundSigmaFrac(seconds: number): number {
  return REAL_BTC_ANNUAL_VOL * Math.sqrt(Math.max(1, seconds) / SECONDS_PER_YEAR);
}

// The strike distance off spot (fraction, signed: <0 = in-the-money) for a binary whose STRIKE must
// carry a `strikeTier` multiple (= tier/L, LUCKY.md §5b). We target win probability p = 1/strikeTier and
// place the strike at z(p)*sigma off spot, so the strike's entry probability lands inside the chain's
// (unreadable) [min,max] admission band instead of the fixed-percentage strike that always aborts on a
// short market. p is floored at REAL_STRIKE_MIN_PROB (never far enough OTM to fall below the band's min)
// and mirrored under 1-that (never so deep ITM it trips the max); the absolute offset is guard-capped.
export function binaryOffsetFrac(strikeTier: number, seconds: number): number {
  const p = Math.min(1 - REAL_STRIKE_MIN_PROB, Math.max(REAL_STRIKE_MIN_PROB, 1 / strikeTier));
  const off = probit(1 - p) * roundSigmaFrac(seconds);
  return Math.max(-REAL_STRIKE_MAX_OFFSET_FRAC, Math.min(REAL_STRIKE_MAX_OFFSET_FRAC, off));
}

// Per-tier target leverage for LUCKY (1e9-scaled), clamped to the market's admission cap. Leverage is
// probability-gated on chain (admitted_leverage_cap, LUCKY.md §5b), so far-OTM high tiers can't take
// much and the mint-abort fallback (mintPendingReal) trims this to 1x when the real probability admits
// less than requested. A modest boost pulls the winnable tiers toward ATM without inviting easy
// mid-round liquidation. MOONSHOT stays at leverage 1 (player-directed reach). Tunable at QA (Phase 16).
const LUCKY_LEVERAGE_1E9: Record<number, bigint> = {
  2: 1_500_000_000n, // 1.5x
  3: 1_800_000_000n, // 1.8x
  5: 2_000_000_000n, // 2.0x
  10: 2_000_000_000n, // 2.0x (low real probability caps it on chain; fallback trims to 1x if needed)
};
function luckyLeverage(tier: number, maxLeverage1e9: bigint): bigint {
  const want = LUCKY_LEVERAGE_1E9[tier] ?? LEVERAGE_ONE;
  const capped = want < maxLeverage1e9 ? want : maxLeverage1e9;
  return capped > LEVERAGE_ONE ? capped : LEVERAGE_ONE;
}

const premiumBudget = (stakeRaw: bigint): bigint => (stakeRaw * (100n - REAL_FEE_HEADROOM_PCT)) / 100n;
const realFmt = (v: bigint): string => String(Number(v) / 1e9);

// Resolve a binary play on the real BTC market. LUCKY decomposes the dealt tier into strike distance x
// leverage (LUCKY.md §5b): leverage carries part of the multiple so the strike sits closer to ATM
// (higher win odds) for the same payout, then the mint snaps the reel to the real multiplier. MOONSHOT
// is player-directed and stays at leverage 1 (the reach IS the strike tier). The mint-abort fallback
// trims leverage if the tier's real (unreadable pre-mint) probability admits less than requested.
function resolveRealBinary(game: 'lucky' | 'moonshot', stakeRaw: bigint, side: Side, tier: number, seed?: string): ResolvedReal {
  const market = realMarket(LUCKY_ROUND_MS);
  const { spot1e9, tickSize, admissionTickSize, maxLeverage1e9 } = realEcon(market);
  const secs = Math.max(1, (market.expiryMs - now()) / 1000);
  const leverage1e9 = game === 'lucky' ? luckyLeverage(tier, maxLeverage1e9) : LEVERAGE_ONE;
  const strikeTier = tier / (Number(leverage1e9) / 1e9); // the multiple the STRIKE must carry (M/L)
  // Signed offset (may be ITM for a low leveraged tier); a negative bigint moves the strike below spot.
  const off = BigInt(Math.round(binaryOffsetFrac(strikeTier, secs) * 1e9));
  const strike1e9 = side === 'up' ? (spot1e9 * (FLOAT_SCALING + off)) / FLOAT_SCALING : (spot1e9 * (FLOAT_SCALING - off)) / FLOAT_SCALING;
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
    duration: Math.max(1, Math.round(secs)),
    entrySpot: realFmt(spot1e9),
    tierMultiplier: tier,
    side,
    strikeDisplay: realFmt(strike1e9),
    seed,
  };
}

// Resolve a RANGE play on the real BTC market at leverage 1: a band [spot*(1-h), spot*(1+h)]. On a
// 20-33s market a wide centered band is near-certain to contain settlement (probability ~1), which trips
// max_entry_probability, so the half-width is capped to keep the band's win probability under
// REAL_RANGE_MAX_PROB (h_max = probit((1+maxProb)/2)*sigma). A tighter user band only lowers probability
// and is left as-is; the reel's real multiplier snaps off the OrderMinted event after the mint (L-012).
function resolveRealRange(stakeRaw: bigint, widthPct: number): ResolvedReal {
  if (!(widthPct > 0) || widthPct > 10) throw new PlayError('INVALID_PARAMS', 'Band width out of range');
  const market = realMarket(Math.round((RANGE_MIN_ORACLE_LIFE_MS + RANGE_MAX_ORACLE_LIFE_MS) / 2));
  const { spot1e9, tickSize, admissionTickSize } = realEcon(market);
  const secs = Math.max(1, (market.expiryMs - now()) / 1000);
  const maxHalfFrac = probit((1 + REAL_RANGE_MAX_PROB) / 2) * roundSigmaFrac(secs);
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
    duration: Math.max(1, Math.round(secs)),
    entrySpot: realFmt(spot1e9),
    tierMultiplier: 0,
    lowerDisplay: realFmt(spot1e9 - half),
    upperDisplay: realFmt(spot1e9 + half),
    widthPct,
  };
}

// The real-mode counterpart to resolveByGame: LUCKY deals via the same fair RNG, MOONSHOT/RANGE are
// player-directed. All route to the live BTC market. `seed` lets a re-route keep LUCKY's dealt draw.
export function resolveReal(input: CreatePlayInputShape, stakeRaw: bigint, seed?: string): ResolvedReal {
  if (input.game === 'lucky') {
    const s = seed ?? newSeed();
    const side: Side = seedFloat(s, 1) < 0.5 ? 'up' : 'down';
    const tier = pickTier(seedFloat(s, 2));
    return resolveRealBinary('lucky', stakeRaw, side, tier, s);
  }
  if (input.game === 'moonshot') {
    if (input.side !== 'up' && input.side !== 'down') throw new PlayError('INVALID_PARAMS', 'Pick a direction');
    if (!Number.isFinite(input.reach)) throw new PlayError('INVALID_PARAMS', 'Pick a reach');
    return resolveRealBinary('moonshot', stakeRaw, input.side, Math.max(2, Math.min(25, input.reach)));
  }
  return resolveRealRange(stakeRaw, input.widthPct);
}

// The shape resolveReal reads (mirrors plays.CreatePlayInput without importing it, to avoid a cycle).
export type CreatePlayInputShape =
  | { game: 'lucky'; stake: string | number }
  | { game: 'range'; stake: string | number; asset: string; widthPct: number }
  | { game: 'moonshot'; stake: string | number; asset: string; side: Side; reach: number };