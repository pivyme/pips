import {
  EXPIRY_SAFETY_MS,
  LEVERAGE_TARGET_WIN_PROB,
  LUCKY_ROUND_MS,
  RANGE_MAX_ORACLE_LIFE_MS,
  RANGE_MIN_ORACLE_LIFE_MS,
  RANGE_TIER_PROBS,
  REAL_BINARY_MIN_OFFSET_SIGMA,
  REAL_BTC_ANNUAL_VOL,
  REAL_RANGE_MAX_PROB,
  REAL_STRIKE_MAX_OFFSET_FRAC,
  REAL_STRIKE_MIN_PROB,
} from '../config/main-config.ts';
import { FLOAT_SCALING, multiplier as multiplierOf } from '../lib/sui/config.ts';
import { liveByAsset, type Market } from '../lib/sui/markets.ts';
import { LEVERAGE_ONE, POSITION_LOT_SIZE, readBtcSpot, resolveWrapper, simulateMint, ticksForBinary, ticksForRange } from '../lib/sui/predict-real.ts';
import { treasuryAddress } from '../lib/sui/signer.ts';
import type { Game, MoonshotAimLevelDTO, RangeQuoteDTO as RangeQuote, RangeQuoteModelDTO, RangeTierQuoteDTO, Side } from '../types/api.ts';
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
  spot1e9: bigint;
  tickSize: bigint;
  admissionTickSize: bigint;
  lowerTick: bigint;
  higherTick: bigint;
  leverage1e9: bigint;
  amountRaw: bigint;
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
  | { game: 'range'; stake: string | number; asset: string; widthPct?: number; tier?: number }
  | { game: 'moonshot'; stake: string | number; asset: string; side: Side; reach: number };

function realMarket(roundMs: number, minRemainingMs: number = EXPIRY_SAFETY_MS): Market {
  const at = now();
  const live = liveByAsset(REAL_BTC_GAME_ASSET, at, Math.max(minRemainingMs, EXPIRY_SAFETY_MS));
  if (live.length === 0) throw new PlayError('MARKET_UNAVAILABLE', 'No live market right now');
  const target = at + roundMs;
  return live.reduce((best, market) => (Math.abs(market.expiryMs - target) < Math.abs(best.expiryMs - target) ? market : best));
}

// RANGE routing: target the usual round length, but never enter a round with under RANGE_MIN_ORACLE_LIFE_MS
// left. A tap that late used to buy a near-certain 10s dud (~1.1x on a much bigger promise); now it rolls
// into the next minute market, and quotes share this routing so the preview prices the round a tap would get.
const RANGE_TARGET_MS = Math.round((RANGE_MIN_ORACLE_LIFE_MS + RANGE_MAX_ORACLE_LIFE_MS) / 2);
const rangeMarket = (): Market => realMarket(RANGE_TARGET_MS, RANGE_MIN_ORACLE_LIFE_MS);

function realEcon(market: Market): { spot1e9: bigint; tickSize: bigint; admissionTickSize: bigint; maxLeverage1e9: bigint } {
  if (!market.spot1e9 || !market.admissionTickSizeRaw) throw new PlayError('ORACLE_STALE', 'Market has no price yet');
  return {
    spot1e9: BigInt(market.spot1e9),
    tickSize: BigInt(market.tickSize),
    admissionTickSize: BigInt(market.admissionTickSizeRaw),
    maxLeverage1e9: market.maxLeverage1e9 ? BigInt(market.maxLeverage1e9) : LEVERAGE_ONE,
  };
}

// Reads the on-chain spot live at tap time, not the ~2s-stale synced market spot, so the recorded entry
// matches what load_live_pricer marks and settles against. Falls back to the last synced spot on failure.
async function freshRealSpot(fallback: bigint): Promise<bigint> {
  try {
    const live = await readBtcSpot();
    if (live && live.spot1e9 > 0n) return live.spot1e9;
  } catch {
    // fall through to the last synced market spot
  }
  return fallback;
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

// The offset a binary strike actually mints at: the tier's raw offset, floored to REAL_BINARY_MIN_OFFSET_SIGMA
// so the 2x tier (raw offset ~0, an ATM coinflip) becomes a visible directional move instead of sitting on the
// entry line. The floor is sigma-scaled to stay admissible on a short round (L-013); 3x+ already clear it.
export function binaryOffsetFloored(strikeTier: number, seconds: number): number {
  return Math.max(binaryOffsetFrac(strikeTier, seconds), REAL_BINARY_MIN_OFFSET_SIGMA * roundSigmaFrac(seconds));
}

// Shared by LUCKY and MOONSHOT (both binary): sizes leverage off the nominal multiplier so the strike
// lands near LEVERAGE_TARGET_WIN_PROB instead of getting clipped by the probability/offset floors.
function binaryLeverage(nominalMult: number, maxLeverage1e9: bigint): bigint {
  const want1e9 = BigInt(Math.round(nominalMult * LEVERAGE_TARGET_WIN_PROB * 1e9));
  const capped = want1e9 < maxLeverage1e9 ? want1e9 : maxLeverage1e9;
  return capped > LEVERAGE_ONE ? capped : LEVERAGE_ONE;
}

// RANGE stacks leverage ON TOP of the band width (unlike the binary split above): the admission cap grants
// more leverage the more ATM-like a position is (L-012), so wide bands request near the cap, tight bands fall back to 1x on retry.
function rangeLeverage(winProb: number, maxLeverage1e9: bigint): bigint {
  const p1e9 = BigInt(Math.round(Math.max(0, Math.min(1, winProb)) * 1e9));
  const lev1e9 = LEVERAGE_ONE + ((maxLeverage1e9 - LEVERAGE_ONE) * p1e9) / FLOAT_SCALING;
  return lev1e9 > LEVERAGE_ONE ? lev1e9 : LEVERAGE_ONE;
}

const premiumBudget = (stakeRaw: bigint): bigint => (stakeRaw * (100n - REAL_FEE_HEADROOM_PCT)) / 100n;
const realFmt = (value: bigint): string => String(Number(value) / 1e9);

// Half a cent (1e9-scaled). The screen rounds spot to 2dp, so a strike inside this of spot renders equal to
// the entry even though it's a real move; when that happens we push it one more admission step out.
const STRIKE_DISPLAY_EPS = 5_000_000n;

// Snaps a binary strike to the nearest admission boundary on the OTM side, at least one admission step clear
// of spot: the 2x floor prices at p=0.5 (raw offset ~0), which would otherwise land the strike on the entry line.
export function otmStrike1e9(side: Side, raw1e9: bigint, spot1e9: bigint, admissionTickSize: bigint): bigint {
  const belowSpot = (spot1e9 / admissionTickSize) * admissionTickSize; // boundary at or below spot
  if (side === 'up') {
    let floor = belowSpot + admissionTickSize; // first boundary strictly above spot
    if (floor - spot1e9 <= STRIKE_DISPLAY_EPS) floor += admissionTickSize; // would round onto the entry line
    const ceilRaw = ((raw1e9 + admissionTickSize - 1n) / admissionTickSize) * admissionTickSize;
    return ceilRaw > floor ? ceilRaw : floor;
  }
  const onBoundary = spot1e9 % admissionTickSize === 0n;
  let cap = onBoundary ? belowSpot - admissionTickSize : belowSpot; // first boundary strictly below spot
  if (spot1e9 - cap <= STRIKE_DISPLAY_EPS) cap -= admissionTickSize; // would round onto the entry line
  const floorRaw = (raw1e9 / admissionTickSize) * admissionTickSize;
  return floorRaw < cap ? floorRaw : cap;
}

// The strike a binary tier/leverage split prices to (LUCKY.md §5b): strikeTier = tier/leverage, p = 1/strikeTier.
// Shared by the initial resolve and the admission-abort restrike below, so a leverage fallback always re-prices.
function strikeFor(
  side: Side,
  tier: number,
  leverage1e9: bigint,
  spot1e9: bigint,
  tickSize: bigint,
  admissionTickSize: bigint,
  seconds: number,
): { strike1e9: bigint; lowerTick: bigint; higherTick: bigint } {
  const strikeTier = tier / (Number(leverage1e9) / 1e9);
  const offset = BigInt(Math.round(binaryOffsetFloored(strikeTier, seconds) * 1e9));
  const raw1e9 = side === 'up' ? (spot1e9 * (FLOAT_SCALING + offset)) / FLOAT_SCALING : (spot1e9 * (FLOAT_SCALING - offset)) / FLOAT_SCALING;
  const strike1e9 = otmStrike1e9(side, raw1e9, spot1e9, admissionTickSize);
  const { lowerTick, higherTick } = ticksForBinary(side, strike1e9, tickSize, admissionTickSize);
  return { strike1e9, lowerTick, higherTick };
}

// Called when the requested leverage is rejected by the admission check (ELeverageAboveAdmission, L-012);
// re-prices the strike for the leverage that actually lands, so the fallback lands close to the nominal tier.
export function restrikeBinary(r: ResolvedReal, leverage1e9: bigint): ResolvedReal {
  if (r.kind !== 'binary' || !r.side) return r;
  const seconds = Math.max(1, (r.expiryMs - now()) / 1000);
  const { strike1e9, lowerTick, higherTick } = strikeFor(r.side, r.tierMultiplier, leverage1e9, r.spot1e9, r.tickSize, r.admissionTickSize, seconds);
  return { ...r, leverage1e9, lowerTick, higherTick, strikeDisplay: realFmt(strike1e9) };
}

async function resolveRealBinary(game: 'lucky' | 'moonshot', netRaw: bigint, stakeRaw: bigint, side: Side, tier: number, seed?: string): Promise<ResolvedReal> {
  const market = realMarket(LUCKY_ROUND_MS);
  const { spot1e9: cachedSpot, tickSize, admissionTickSize, maxLeverage1e9 } = realEcon(market);
  const spot1e9 = await freshRealSpot(cachedSpot);
  const seconds = Math.max(1, (market.expiryMs - now()) / 1000);
  const leverage1e9 = binaryLeverage(tier, maxLeverage1e9);
  const { strike1e9, lowerTick, higherTick } = strikeFor(side, tier, leverage1e9, spot1e9, tickSize, admissionTickSize, seconds);
  return {
    game,
    kind: 'binary',
    marketId: market.oracleId,
    asset: REAL_BTC_GAME_ASSET,
    spot1e9,
    tickSize,
    admissionTickSize,
    lowerTick,
    higherTick,
    leverage1e9,
    // Mint sizes off NET (stake - rake); wrapper is funded to full STAKE so the rake peels out after mint (lib/sui/house.ts).
    amountRaw: premiumBudget(netRaw),
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

// The reach ladder MOONSHOT dials (abs of the client's aim ladder). Kept here so the aim quote and the play
// clamp share one source of truth.
const MOONSHOT_REACHES = [2, 3, 5, 10, 25];

// MOONSHOT aim preview: the strike offset each reach actually mints at, computed by the exact same strikeFor
// math as a real mint (leverage split + admission snap), so the client's TARGET line lands where the strike
// lands instead of a blind vol guess. Mirrors quoteRangeTiersReal. Pure analytic off the cached live market,
// no sim/chain round-trip. Returns null with no live market; the client falls back to a calibrated table.
export function quoteMoonshotAimReal(): { levels: MoonshotAimLevelDTO[] } | null {
  try {
    const market = realMarket(LUCKY_ROUND_MS);
    const { spot1e9, tickSize, admissionTickSize, maxLeverage1e9 } = realEcon(market);
    const seconds = Math.max(1, (market.expiryMs - now()) / 1000);
    const levels = MOONSHOT_REACHES.map((reach) => {
      const leverage1e9 = binaryLeverage(reach, maxLeverage1e9);
      const { strike1e9 } = strikeFor('up', reach, leverage1e9, spot1e9, tickSize, admissionTickSize, seconds);
      const offsetFrac = Math.abs(Number(strike1e9 - spot1e9)) / Number(spot1e9);
      return { reach, offsetFrac };
    });
    return { levels };
  } catch {
    return null;
  }
}

// A tier's analytic payout fallback at 1x leverage, until the sim calibration below supplies chain truth.
const tierMultOf = (p: number): number => Math.max(1.01, (1 / p) * (1 - REAL_RANGE_QUOTE_HAIRCUT));

// === Sim-calibrated RANGE pricing ===
// The chain's pricer (Block Scholes vol surface) disagrees hard with any fixed REAL_BTC_ANNUAL_VOL
// (observed ~0.2 implied vs the 0.55 seed, so a "45%" band minted at ~1.08x). Each refresh probes the
// tier ladder with SIMULATED mints (treasury as actor, nothing lands), fits the implied annual vol from
// the emitted entry_probability, and keeps the simulated multiple per tier as the quote truth.
type RangeCalib = { sigmaAnnual: number; mults: Array<number | null>; at: number };
const rangeCalib: RangeCalib = { sigmaAnnual: REAL_BTC_ANNUAL_VOL, mults: RANGE_TIER_PROBS.map(() => null), at: 0 };
let calibInflight: Promise<void> | null = null;
const CALIB_TTL_MS = 4000;
const PROBE_AMOUNT_RAW = 1_500_000n; // $1.50 draw per probe, above the $1 min net premium
const PROBE_DEPOSIT_RAW = 2_000_000n; // probe deposit: the mint draws fees on top of the amount budget
const SIGMA_ANNUAL_MIN = 0.02;
const SIGMA_ANNUAL_MAX = 3;

const rangeSigmaFrac = (seconds: number): number => rangeCalib.sigmaAnnual * Math.sqrt(Math.max(1, seconds) / SECONDS_PER_YEAR);

async function refreshRangeCalib(): Promise<void> {
  if (!treasuryAddress) return; // no treasury key: analytic fallback stays
  const market = rangeMarket();
  const { spot1e9, tickSize, admissionTickSize } = realEcon(market);
  const seconds = Math.max(1, (market.expiryMs - now()) / 1000);
  const sqrtT = Math.sqrt(seconds / SECONDS_PER_YEAR);
  const w = await resolveWrapper(treasuryAddress);
  const probes = RANGE_TIER_PROBS.map((p) => {
    const halfFrac = probit((1 + p) / 2) * rangeCalib.sigmaAnnual * sqrtT;
    const half = (spot1e9 * BigInt(Math.round(halfFrac * 1e9))) / FLOAT_SCALING;
    return { halfFrac, ...ticksForRange(spot1e9 - half, spot1e9 + half, tickSize, admissionTickSize) };
  });
  const results = await Promise.all(
    probes.map((b) =>
      simulateMint({
        marketId: market.oracleId,
        lowerTick: b.lowerTick,
        higherTick: b.higherTick,
        amountRaw: PROBE_AMOUNT_RAW,
        depositRaw: PROBE_DEPOSIT_RAW,
        leverage1e9: LEVERAGE_ONE,
        sender: treasuryAddress,
        wrapperId: w.wrapperId,
        wrapperExists: w.exists,
      }),
    ),
  );
  const implied: number[] = [];
  const mults = results.map((r, i) => {
    if (!r) return null;
    const p = Number(r.entryProbability1e9) / 1e9;
    if (p > 0.005 && p < 0.995) implied.push(probes[i].halfFrac / (probit((1 + p) / 2) * sqrtT));
    return multiplierOf(r.costRaw, r.quantityRaw);
  });
  if (implied.length > 0) {
    implied.sort((a, b) => a - b);
    // Median, damped so one weird probe can't yank the ladder; converges within a refresh or two.
    const med = implied[Math.floor(implied.length / 2)];
    const next = Math.min(rangeCalib.sigmaAnnual * 3, Math.max(rangeCalib.sigmaAnnual / 3, med));
    rangeCalib.sigmaAnnual = Math.min(SIGMA_ANNUAL_MAX, Math.max(SIGMA_ANNUAL_MIN, next));
  } else if (results.every((r) => r == null)) {
    // Every probe aborted: near-certainly the bands sit past max_entry_probability (sigma estimate too
    // high), so walk it down and re-fit next refresh. The floor stops a runaway.
    rangeCalib.sigmaAnnual = Math.max(SIGMA_ANNUAL_MIN, rangeCalib.sigmaAnnual / 2);
  }
  rangeCalib.mults = mults;
  rangeCalib.at = now();
}

// TTL + in-flight dedupe; a failed refresh keeps the prior calibration (analytic fallback covers cold start).
async function ensureRangeCalib(): Promise<void> {
  if (now() - rangeCalib.at < CALIB_TTL_MS) return;
  calibInflight ??= refreshRangeCalib()
    .catch(() => {})
    .finally(() => {
      calibInflight = null;
    });
  await calibInflight;
}

// RANGE mints at 1x leverage on the tier path: the win condition stays exactly "inside the band at the
// buzzer" (no mid-round liquidation knockout) and the payout is ~1/p whenever the tap lands. The legacy
// widthPct path (range-v2) keeps its fixed band + leverage stack.
async function resolveRealRange(netRaw: bigint, stakeRaw: bigint, input: { widthPct?: number; tier?: number }): Promise<ResolvedReal> {
  void ensureRangeCalib(); // keep the implied vol warm in the background; never block a tap on it
  const market = rangeMarket();
  const { spot1e9: cachedSpot, tickSize, admissionTickSize, maxLeverage1e9 } = realEcon(market);
  const spot1e9 = await freshRealSpot(cachedSpot);
  const seconds = Math.max(1, (market.expiryMs - now()) / 1000);
  const sigma = rangeSigmaFrac(seconds);
  let halfFrac: number;
  let leverage1e9: bigint;
  let tierMult = 0;
  if (input.tier != null && Number.isFinite(input.tier)) {
    const tierIdx = Math.max(0, Math.min(RANGE_TIER_PROBS.length - 1, Math.round(input.tier)));
    const p = RANGE_TIER_PROBS[tierIdx];
    halfFrac = probit((1 + p) / 2) * sigma;
    leverage1e9 = LEVERAGE_ONE;
    tierMult = rangeCalib.mults[tierIdx] ?? tierMultOf(p);
  } else {
    const widthPct = input.widthPct ?? NaN;
    if (!(widthPct > 0) || widthPct > 10) throw new PlayError('INVALID_PARAMS', 'Band width out of range');
    const maxHalfFrac = probit((1 + REAL_RANGE_MAX_PROB) / 2) * sigma;
    halfFrac = Math.min(widthPct / 100 / 2, maxHalfFrac);
    leverage1e9 = rangeLeverage(rangeWinProb(halfFrac, sigma), maxLeverage1e9);
  }
  const half = (spot1e9 * BigInt(Math.round(halfFrac * 1e9))) / FLOAT_SCALING;
  const { lowerTick, higherTick } = ticksForRange(spot1e9 - half, spot1e9 + half, tickSize, admissionTickSize);
  return {
    game: 'range',
    kind: 'range',
    marketId: market.oracleId,
    asset: REAL_BTC_GAME_ASSET,
    spot1e9,
    tickSize,
    admissionTickSize,
    lowerTick,
    higherTick,
    leverage1e9,
    // Size the mint off NET; the wrapper is funded to the full STAKE so the rake withdraws cleanly.
    amountRaw: premiumBudget(netRaw),
    minQuantityRaw: POSITION_LOT_SIZE,
    expiryMs: market.expiryMs,
    duration: Math.max(1, Math.round(seconds)),
    entrySpot: realFmt(spot1e9),
    tierMultiplier: tierMult,
    lowerDisplay: realFmt(spot1e9 - half),
    upperDisplay: realFmt(spot1e9 + half),
    widthPct: input.widthPct ?? Math.round(halfFrac * 200 * 1e4) / 1e4,
  };
}

// Tier quotes: multiplier = the last SIMULATED mint's multiple per tier (chain truth incl. fees/spread,
// analytic fallback pre-calibration), so the promise holds whenever the tap lands; sigmaMult + expiryMs +
// the calibrated annualVol let the client redraw the live band width between fetches.
export async function quoteRangeTiersReal(): Promise<{ quotes: RangeTierQuoteDTO[]; model: RangeQuoteModelDTO } | null> {
  try {
    await ensureRangeCalib();
    const market = rangeMarket();
    const { spot1e9 } = realEcon(market);
    const spot = Number(spot1e9) / 1e9;
    const seconds = Math.max(1, (market.expiryMs - now()) / 1000);
    const sigma = rangeSigmaFrac(seconds);
    const duration = Math.max(1, Math.round(seconds));
    const quotes = RANGE_TIER_PROBS.map((p, tier) => {
      const sigmaMult = probit((1 + p) / 2);
      const halfFrac = sigmaMult * sigma;
      const half = spot * halfFrac;
      return {
        tier,
        prob: p,
        multiplier: rangeCalib.mults[tier] ?? tierMultOf(p),
        sigmaMult,
        halfPct: halfFrac * 100,
        lower: String(spot - half),
        upper: String(spot + half),
        entrySpot: String(spot),
        duration,
        expiryMs: market.expiryMs,
      };
    });
    return { quotes, model: { annualVol: rangeCalib.sigmaAnnual, minRoundMs: RANGE_MIN_ORACLE_LIFE_MS } };
  } catch {
    return null;
  }
}

export function quoteRangeBatchReal(widthPcts: number[]): RangeQuote[] {
  const widths = widthPcts.filter((width) => width > 0 && width <= 10);
  if (widths.length === 0) return [];
  try {
    const market = rangeMarket();
    const { spot1e9, maxLeverage1e9 } = realEcon(market);
    const spot = Number(spot1e9) / 1e9;
    const seconds = Math.max(1, (market.expiryMs - now()) / 1000);
    const sigma = rangeSigmaFrac(seconds); // calibrated implied vol, same as the tier path
    const maxHalfFrac = probit((1 + REAL_RANGE_MAX_PROB) / 2) * sigma;
    const duration = Math.max(1, Math.round(seconds));
    return widths.map((widthPct) => {
      const halfFrac = Math.min(widthPct / 100 / 2, maxHalfFrac);
      const p = rangeWinProb(halfFrac, sigma);
      const lev = Number(rangeLeverage(p, maxLeverage1e9)) / 1e9;
      const mult = Math.max(1.01, (1 / p) * lev * (1 - REAL_RANGE_QUOTE_HAIRCUT));
      const half = spot * halfFrac;
      return { multiplier: mult, lower: String(spot - half), upper: String(spot + half), entrySpot: String(spot), duration, widthPct };
    });
  } catch {
    return [];
  }
}

// netRaw sizes the position (stake - house rake); stakeRaw funds the wrapper fully so the rake can be
// withdrawn after mint. At rake = 0, netRaw === stakeRaw (byte-identical to no-rake).
export async function resolveReal(input: CreatePlayInputShape, netRaw: bigint, stakeRaw: bigint, seed?: string): Promise<ResolvedReal> {
  if (input.game === 'lucky') {
    const actualSeed = seed ?? newSeed();
    const side: Side = seedFloat(actualSeed, 1) < 0.5 ? 'up' : 'down';
    const tier = pickTier(seedFloat(actualSeed, 2));
    return resolveRealBinary('lucky', netRaw, stakeRaw, side, tier, actualSeed);
  }
  if (input.game === 'moonshot') {
    if (input.side !== 'up' && input.side !== 'down') throw new PlayError('INVALID_PARAMS', 'Pick a direction');
    if (!Number.isFinite(input.reach)) throw new PlayError('INVALID_PARAMS', 'Pick a reach');
    return resolveRealBinary('moonshot', netRaw, stakeRaw, input.side, Math.max(2, Math.min(25, input.reach)));
  }
  return resolveRealRange(netRaw, stakeRaw, input);
}
