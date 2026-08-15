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
import { captureError } from '../lib/analytics.ts';
import { FLOAT_SCALING, multiplier as multiplierOf } from '../lib/sui/config.ts';
import { liveByAsset, type Market } from '../lib/sui/markets.ts';
import { LEVERAGE_ONE, POSITION_LOT_SIZE, quoteMint, readBtcSpot, resolveWrapper, simulateMint, ticksForBinary, ticksForRange } from '../lib/sui/predict-real.ts';
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
  strike1e9?: bigint; // binary only: the exact strike, so an abort fallback can step it without reparsing the display string
  strikeDisplay?: string;
  lowerDisplay?: string;
  upperDisplay?: string;
  widthPct?: number;
  seed?: string;
};

export type CreatePlayInputShape =
  | { game: 'lucky'; stake: string | number }
  | { game: 'range'; stake: string | number; asset: string; widthPct?: number; tier?: number }
  | { game: 'moonshot'; stake: string | number; asset: string; side: Side; reach: number }
  | { game: 'pin'; stake: string | number; asset: string; pin: number; window: number };

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

// The leverage this market will actually admit right now. `max_admission_leverage` (3x on BTC) is only the
// global ceiling: admitted_leverage_cap() short-circuits to exactly 1x inside `no_leverage_window_ms`, which
// is ONE HOUR on testnet, so every 1m market we route to caps at 1x. Asking for more is a guaranteed
// ELeverageAboveAdmissionCap abort, which is what burned an attempt on every tier above 2x.
function admittedMaxLeverage(market: Market): bigint {
  const ceiling = market.maxLeverage1e9 ? BigInt(market.maxLeverage1e9) : LEVERAGE_ONE;
  const window = market.noLeverageWindowMs ? Number(market.noLeverageWindowMs) : 0;
  return market.expiryMs - now() < window ? LEVERAGE_ONE : ceiling;
}

function realEcon(market: Market): { spot1e9: bigint; tickSize: bigint; admissionTickSize: bigint; maxLeverage1e9: bigint } {
  if (!market.spot1e9 || !market.admissionTickSizeRaw) throw new PlayError('ORACLE_STALE', 'Market has no price yet');
  return {
    spot1e9: BigInt(market.spot1e9),
    tickSize: BigInt(market.tickSize),
    admissionTickSize: BigInt(market.admissionTickSizeRaw),
    maxLeverage1e9: admittedMaxLeverage(market),
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

// The chain prices off a Block Scholes surface whose implied vol sits nowhere near the REAL_BTC_ANNUAL_VOL
// seed (measured ~0.10 at 12s to expiry, ~0.21 at 100s), so a strike placed on the seed lands multiples of
// sigma from where its tier intends: that is how a "5x" tier came to price at 38x, and how the far tiers fell
// through the protocol's 1% min_entry_probability floor. Every preflight quote reports the true entry
// probability, so each play back-solves the vol and leaves it for the next one; the seed is only a cold start.
// Bucketed by time to expiry, because the surface has real term structure: measured ~0.10 annual at 12s out
// against ~0.21 at 100s. One global number would be wrong at both ends and force a corrective re-quote on
// nearly every play; a 10s bucket lands the first strike on target and keeps the tap to a single quote.
const SIGMA_EMA = 0.5;
const SIGMA_BUCKETS = 7; // 10s each, covering the 5-65s range a 1m cadence can route to
const sigmaBucket = (seconds: number): number => Math.min(SIGMA_BUCKETS - 1, Math.max(0, Math.round(seconds / 10)));
const binaryCalib = { sigmaAnnual: new Array<number>(SIGMA_BUCKETS).fill(REAL_BTC_ANNUAL_VOL) };
const calibSigma = (seconds: number): number => binaryCalib.sigmaAnnual[sigmaBucket(seconds)];

function roundSigmaFrac(seconds: number): number {
  return calibSigma(seconds) * Math.sqrt(Math.max(1, seconds) / SECONDS_PER_YEAR);
}

// Back out the annual vol the chain just priced with, from a quoted probability at a known strike offset.
// Only sampled away from ATM: as p approaches 0.5 the probit divisor approaches 0 and the implied vol
// explodes, so a near-ATM quote (which is exactly what the walk-toward-spot fallback produces) would poison
// the bucket and fling the NEXT play's strike far enough out that nothing is admissible.
const SIGMA_SAMPLE_MIN_PROB = 0.02;
const SIGMA_SAMPLE_MAX_PROB = 0.42;

function noteImpliedSigma(offsetFrac: number, p: number, seconds: number): void {
  if (!(p > SIGMA_SAMPLE_MIN_PROB && p < SIGMA_SAMPLE_MAX_PROB) || offsetFrac <= 0) return;
  const sigma = offsetFrac / (probit(1 - p) * Math.sqrt(Math.max(1, seconds) / SECONDS_PER_YEAR));
  if (!Number.isFinite(sigma) || sigma <= 0) return;
  const i = sigmaBucket(seconds);
  // Clamp the SAMPLE before blending; blending an out-of-band reading still drags the bucket with it.
  const clamped = Math.min(SIGMA_ANNUAL_MAX, Math.max(SIGMA_ANNUAL_MIN, sigma));
  binaryCalib.sigmaAnnual[i] = binaryCalib.sigmaAnnual[i] * (1 - SIGMA_EMA) + clamped * SIGMA_EMA;
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
// constants::min_net_premium (6dp): the chain refuses a mint whose net premium is under $1 (L-011).
const MIN_NET_PREMIUM_RAW = 1_000_000n;
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

// Halve a strike's distance from spot, snapped back onto the admission grid. otmStrike1e9 keeps it at least
// one admission step clear, so repeated halving terminates on the closest mintable boundary.
function halveToSpot(side: Side, strike1e9: bigint, spot1e9: bigint, admissionTickSize: bigint): bigint {
  const gap = side === 'up' ? strike1e9 - spot1e9 : spot1e9 - strike1e9;
  if (gap <= 0n) return strike1e9;
  const raw1e9 = side === 'up' ? spot1e9 + gap / 2n : spot1e9 - gap / 2n;
  return otmStrike1e9(side, raw1e9, spot1e9, admissionTickSize);
}

// Last-resort fallback when a mint still aborts on admission (price moved between the preflight quote and
// the mint). Moves the strike toward ATM, which RAISES entry probability: the old fallback dropped leverage
// and re-derived the strike from the nominal tier, which pushed it further OUT and straight through the
// protocol's 1% min_entry_probability floor, turning a recoverable abort into a dead play.
// Null when the strike is already on the closest admissible boundary, so the caller errors instead of looping.
// Slide a band's centre half way to spot, width intact, and re-snap to the grid. Null when the grid puts it
// nowhere new, so the caller errors with chips safe instead of looping a doomed mint.
function recentreBandCloser(r: ResolvedReal, leverage1e9: bigint): ResolvedReal | null {
  const lower1e9 = r.lowerTick * r.tickSize;
  const higher1e9 = r.higherTick * r.tickSize;
  const centre1e9 = (lower1e9 + higher1e9) / 2n;
  const half1e9 = (higher1e9 - lower1e9) / 2n;
  const next1e9 = centre1e9 + (r.spot1e9 - centre1e9) / 2n;
  const { lowerTick, higherTick } = ticksForRange(next1e9 - half1e9, next1e9 + half1e9, r.tickSize, r.admissionTickSize);
  if (lowerTick === r.lowerTick && higherTick === r.higherTick) return null;
  return {
    ...r,
    leverage1e9,
    lowerTick,
    higherTick,
    lowerDisplay: realFmt(lowerTick * r.tickSize),
    upperDisplay: realFmt(higherTick * r.tickSize),
    // PIN records its named price here, so it has to travel with the band or the settle reveal states a miss
    // against a pin that was never bought.
    ...(r.strikeDisplay !== undefined ? { strikeDisplay: realFmt(next1e9) } : {}),
  };
}

export function restrikeCloser(r: ResolvedReal, leverage1e9: bigint): ResolvedReal | null {
  // A band gets the same treatment: slide its CENTRE half way to spot, keeping the width, which raises entry
  // probability the same way. RANGE centres on spot so this is a no-op returning null (its behaviour is
  // unchanged); it is PIN's off-centre band that has somewhere to move.
  if (r.kind === 'range') return recentreBandCloser(r, leverage1e9);
  if (!r.side || r.strike1e9 === undefined) return { ...r, leverage1e9 };
  const strike1e9 = halveToSpot(r.side, r.strike1e9, r.spot1e9, r.admissionTickSize);
  if (strike1e9 === r.strike1e9) return null;
  const { lowerTick, higherTick } = ticksForBinary(r.side, strike1e9, r.tickSize, r.admissionTickSize);
  return { ...r, leverage1e9, strike1e9, lowerTick, higherTick, strikeDisplay: realFmt(strike1e9) };
}

// The strike for a target win probability under a given vol, floored to REAL_BINARY_MIN_OFFSET_SIGMA and
// snapped to the admission grid. Same placement as binaryOffsetFloored, but parameterised by the vol so the
// preflight can re-place a strike on the vol the chain just quoted instead of the seed.
function strikeForProb(
  side: Side,
  p: number,
  spot1e9: bigint,
  sigmaAnnual: number,
  seconds: number,
  admissionTickSize: bigint,
): bigint {
  const sigmaFrac = sigmaAnnual * Math.sqrt(Math.max(1, seconds) / SECONDS_PER_YEAR);
  const raw = Math.max(probit(1 - p) * sigmaFrac, REAL_BINARY_MIN_OFFSET_SIGMA * sigmaFrac);
  const off = Math.max(-REAL_STRIKE_MAX_OFFSET_FRAC, Math.min(REAL_STRIKE_MAX_OFFSET_FRAC, raw));
  const offset = BigInt(Math.round(off * 1e9));
  const raw1e9 = side === 'up' ? (spot1e9 * (FLOAT_SCALING + offset)) / FLOAT_SCALING : (spot1e9 * (FLOAT_SCALING - offset)) / FLOAT_SCALING;
  return otmStrike1e9(side, raw1e9, spot1e9, admissionTickSize);
}

// The win probability a tier is meant to pay at: strikeTier = tier/leverage, p = 1/strikeTier (LUCKY.md §5b).
function targetProb(tier: number, leverage1e9: bigint): number {
  const strikeTier = tier / (Number(leverage1e9) / 1e9);
  return Math.min(1 - REAL_STRIKE_MIN_PROB, Math.max(REAL_STRIKE_MIN_PROB, 1 / strikeTier));
}

// Preflight the strike against the chain before spending a transaction on it. expiry_market::quote_mint is
// `public` for exactly this (devInspect pre-trade pricing, ~85ms a call), so a bad strike costs a read rather
// than a failed mint, and the quote is the only honest source for entry probability and all-in cost (L-012).
// Solves three things at once, re-quoting until they all hold: the chain admits the strike, it prices near the
// tier's target probability, and the all-in cost fits inside the stake.
const PREFLIGHT_STEPS = 7;
const PROB_TOLERANCE = 1.5; // re-place the strike when the quoted probability is off target by more than this
const COST_MARGIN_PCT = 4n; // headroom under the stake for the fee ramp between this quote and the mint

type Preflight = { strike1e9: bigint; lowerTick: bigint; higherTick: bigint; entryProbability: number; amountRaw: bigint };

async function preflightBinary(
  marketId: string,
  side: Side,
  tier: number,
  spot1e9: bigint,
  tickSize: bigint,
  admissionTickSize: bigint,
  leverage1e9: bigint,
  netRaw: bigint,
  seconds: number,
): Promise<Preflight | null> {
  const target = targetProb(tier, leverage1e9);
  const costTarget = (netRaw * (100n - COST_MARGIN_PCT)) / 100n;
  let strike1e9 = strikeForProb(side, target, spot1e9, calibSigma(seconds), seconds, admissionTickSize);
  let budgetRaw = premiumBudget(netRaw);
  let aimed = false; // whether the budget has already been rescaled for this strike's fee load
  let best: Preflight | null = null; // last strike that fully checked out, in case we run out of steps
  const trace: string[] = []; // why each candidate was rejected, so an exhausted search is diagnosable

  for (let step = 0; step < PREFLIGHT_STEPS; step++) {
    const { lowerTick, higherTick } = ticksForBinary(side, strike1e9, tickSize, admissionTickSize);
    const q = await quoteMint({ marketId, lowerTick, higherTick, maxPremiumRaw: budgetRaw, leverage1e9 });
    if (!q || q.allInCostRaw === 0n) {
      trace.push(`${realFmt(strike1e9)}@$${fmtUsd(budgetRaw)} refused`);
      // Inadmissible (past a probability bound): only a strike closer to spot can be admitted.
      const next = halveToSpot(side, strike1e9, spot1e9, admissionTickSize);
      if (next === strike1e9) return finishPreflight(best, trace, tier, target, seconds);
      strike1e9 = next;
      aimed = false; // new strike, new fee load
      continue;
    }
    const p = Number(q.entryProbability1e9) / 1e9;
    noteImpliedSigma(Math.abs(Number(strike1e9 - spot1e9)) / Number(spot1e9), p, seconds);

    // Trading fees ride on TOP of the premium and grow as the strike goes out (~1/sqrt(p)), so a far tier can
    // bill well over its premium. Aim the budget a few percent under the stake, then accept anything that
    // fits inside it: the rescale approaches its aim asymptotically, so requiring it to land strictly under
    // never terminates, which is what left the top reaches unplayable.
    if (q.allInCostRaw > costTarget && (!aimed || q.allInCostRaw > netRaw)) {
      trace.push(`${realFmt(strike1e9)} p=${p.toFixed(3)} costs $${fmtUsd(q.allInCostRaw)} > $${fmtUsd(costTarget)}`);
      const scaled = (budgetRaw * costTarget) / q.allInCostRaw;
      if (scaled >= MIN_NET_PREMIUM_RAW && scaled < budgetRaw) {
        budgetRaw = scaled;
        aimed = true;
        continue;
      }
      // Can't fit this strike inside the stake at the protocol's $1 minimum premium; a closer one costs less.
      const next = halveToSpot(side, strike1e9, spot1e9, admissionTickSize);
      if (next === strike1e9) return finishPreflight(best, trace, tier, target, seconds);
      strike1e9 = next;
      aimed = false; // new strike, new fee load
      continue;
    }

    best = { strike1e9, lowerTick, higherTick, entryProbability: p, amountRaw: budgetRaw };
    if (p >= target / PROB_TOLERANCE && p <= target * PROB_TOLERANCE) return best;
    trace.push(`${realFmt(strike1e9)} p=${p.toFixed(3)} off target ${target.toFixed(3)}`);
    // Admissible and affordable, but priced well off the tier: re-place it on the vol just implied.
    const retarget = strikeForProb(side, target, spot1e9, calibSigma(seconds), seconds, admissionTickSize);
    if (retarget === strike1e9) return best;
    strike1e9 = retarget;
  }
  return finishPreflight(best, trace, tier, target, seconds);
}

const fmtUsd = (raw: bigint): string => (Number(raw) / 1e6).toFixed(2);

// A search that ends with nothing playable is a real incident (the tier is unreachable on this market), so
// record WHY it ran out rather than surfacing a bare "no mintable strike". A partial result still plays.
function finishPreflight(best: Preflight | null, trace: string[], tier: number, target: number, seconds: number): Preflight | null {
  if (!best) {
    console.warn(`[preflight] ${tier}x unmintable (p*=${target.toFixed(3)}, ${Math.round(seconds)}s, sigma=${calibSigma(seconds).toFixed(3)}): ${trace.join(' | ')}`);
    captureError(new Error(`preflight found no mintable strike for ${tier}x`), {
      kind: 'chain',
      level: 'warn',
      fingerprint: 'chain.preflight_exhausted',
      context: { tier, targetProb: target, seconds: Math.round(seconds), sigma: calibSigma(seconds), trace },
    });
  }
  return best;
}

async function resolveRealBinary(game: 'lucky' | 'moonshot', netRaw: bigint, stakeRaw: bigint, side: Side, tier: number, seed?: string): Promise<ResolvedReal> {
  const market = realMarket(LUCKY_ROUND_MS);
  const { spot1e9: cachedSpot, tickSize, admissionTickSize, maxLeverage1e9 } = realEcon(market);
  const spot1e9 = await freshRealSpot(cachedSpot);
  const seconds = Math.max(1, (market.expiryMs - now()) / 1000);
  const leverage1e9 = binaryLeverage(tier, maxLeverage1e9);
  const pre = await preflightBinary(market.oracleId, side, tier, spot1e9, tickSize, admissionTickSize, leverage1e9, netRaw, seconds);
  if (!pre) throw new PlayError('MARKET_UNAVAILABLE', 'No mintable strike right now, try again');
  const { strike1e9, lowerTick, higherTick } = pre;
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
    // Budget comes from the quote, so the all-in cost (premium + fees) lands inside the stake.
    amountRaw: pre.amountRaw,
    minQuantityRaw: POSITION_LOT_SIZE,
    expiryMs: market.expiryMs,
    duration: Math.max(1, Math.round(seconds)),
    entrySpot: realFmt(spot1e9),
    tierMultiplier: tier,
    side,
    strike1e9,
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

// === PIN ===
// Range with the band centred on a price the player names instead of on spot. One mint_range at
// (pin - window, pin + window], same market and the same calibrated vol as RANGE.

// The WINDOW ladder, widest first: target win probabilities for a band centred ON SPOT. Probability-sized,
// never dollar-sized (L-013), because a hand-picked ±$5 is a fraction of a sigma on a ~26s round and aborts
// on admission. The screen renders the dollars this resolves to, not the reverse.
const PIN_WINDOW_PROBS = [0.5, 0.28, 0.14, 0.07];

// The chance a band centred `offsetFrac` away from spot contains the price at expiry. Reduces to
// rangeWinProb at offset 0, and it is what makes a far pin a genuine long shot rather than a wide one.
function pinWinProb(offsetFrac: number, halfFrac: number, sigma: number): number {
  const s = Math.max(sigma, 1e-9);
  const p = normCdf((offsetFrac + halfFrac) / s) - normCdf((offsetFrac - halfFrac) / s);
  return Math.min(REAL_RANGE_MAX_PROB, Math.max(0.005, p));
}

// How far the pin may travel, in sigma, PER WINDOW. A tight window planted far out is a different bet from a
// wide one: at 2.5 sigma the tightest rung prices at ~0.3%, well under the chain's 1% min_entry_probability,
// so a flat travel would hand the knob a stretch of dead ground where every mint aborts. Each window instead
// solves for the furthest offset still pricing above REAL_STRIKE_MIN_PROB, which leaves the whole knob travel
// mintable by construction: wide windows reach further, tight ones keep you near spot.
// The chain prices off a Block Scholes surface with visibly thinner tails than the lognormal this solves in:
// measured on testnet, a band the analytic calls 14% at 1.7 sigma out priced at 2.2% on chain, while the same
// band centred on spot priced ABOVE the analytic. A single fitted sigma cannot carry both ends, so the solved
// travel is haircut by a factor measured across all four windows with `scripts/verify-pin-ladder.ts`: at two
// thirds of the solved travel every window's chain entry probability sat at ~2-3%, right on the admission
// boundary and flipping to abort on noise, while at half it sat at 5-8% and every rung admitted. Re-run that
// script if the surface moves; do not tune this by feel.
const PIN_TRAVEL_SAFETY = 0.5;

const pinTravelSigma = (sigmaMult: number): number => {
  const p = (z: number): number => normCdf(z + sigmaMult) - normCdf(z - sigmaMult);
  if (p(0) <= REAL_STRIKE_MIN_PROB) return 0; // window already at the floor centred on spot
  let lo = 0;
  let hi = 8;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (p(mid) > REAL_STRIKE_MIN_PROB) lo = mid;
    else hi = mid;
  }
  return lo * PIN_TRAVEL_SAFETY;
};

// Fixed per window (both terms are in sigma), so it is solved once rather than per quote.
const PIN_WINDOWS = PIN_WINDOW_PROBS.map((prob, tier) => {
  const sigmaMult = probit((1 + prob) / 2);
  return { tier, prob, sigmaMult, travelSigma: pinTravelSigma(sigmaMult) };
});

// How far the chain's real multiple sits from the analytic 1/p at each probability, measured off the
// simulated mints RANGE already runs. The gap is spread plus the pricer's own vol view and it widens as the
// band tightens, so a bare 1/p overstates a tight window badly (measured 13.7x analytic against 8.79x real).
// Empty until the first calibration lands, and the estimate then reads 1:1 rather than guessing.
function pinCalibration(): Array<{ prob: number; ratio: number }> {
  const out: Array<{ prob: number; ratio: number }> = [];
  RANGE_TIER_PROBS.forEach((prob, i) => {
    const real = rangeCalib.mults[i];
    if (real == null || real <= 0) return;
    const ratio = real / tierMultOf(prob);
    if (ratio > 0.2 && ratio < 5) out.push({ prob, ratio });
  });
  return out;
}

/** The calibration ratio nearest a probability, in log space so 0.07 is judged against 0.11 not against 0.5. */
export function pinRatioAt(calibration: Array<{ prob: number; ratio: number }>, p: number): number {
  if (calibration.length === 0) return 1;
  let best = calibration[0];
  for (const c of calibration) {
    if (Math.abs(Math.log(c.prob / p)) < Math.abs(Math.log(best.prob / p))) best = c;
  }
  return best.ratio;
}

// What PIN's screen needs to draw every frame the knob moves: the round's spot and vol, the pin's usable
// travel, and each window's half-width. The multiple it derives from these is an ESTIMATE and is labelled
// as one; the real one is read off OrderMinted (L-012).
export async function quotePinModelReal(): Promise<{
  entrySpot: string;
  duration: number;
  expiryMs: number;
  annualVol: number;
  windows: Array<{ tier: number; prob: number; sigmaMult: number; travelSigma: number; halfPct: number }>;
  calibration: Array<{ prob: number; ratio: number }>;
} | null> {
  try {
    await ensureRangeCalib();
    const market = rangeMarket();
    const { spot1e9 } = realEcon(market);
    const seconds = Math.max(1, (market.expiryMs - now()) / 1000);
    const sigma = rangeSigmaFrac(seconds);
    return {
      entrySpot: realFmt(spot1e9),
      duration: Math.max(1, Math.round(seconds)),
      expiryMs: market.expiryMs,
      annualVol: rangeCalib.sigmaAnnual,
      calibration: pinCalibration(),
      // sigmaMult (half-width) and travelSigma (the pin's reach) are both in sigma, so the screen redraws the
      // box and the ladder as the clock decays sigma between fetches; halfPct is that width at quote time.
      windows: PIN_WINDOWS.map((w) => ({ ...w, halfPct: w.sigmaMult * sigma * 100 })),
    };
  } catch {
    return null;
  }
}

// The band a (pin offset, window) pair resolves to. Shared by the resolve path and the ladder proof below, so
// what gets verified is exactly what mints. The offset is CLAMPED to the window's travel rather than rejected:
// the knob's ladder is sigma-scaled off a spot that moves between the frame the player pressed on and this
// resolve, so a pin one step past the edge is a race, not a bad request.
function pinBand(p: {
  spot1e9: bigint;
  offsetFrac: number;
  window: number;
  sigma: number;
  tickSize: bigint;
  admissionTickSize: bigint;
}) {
  const w = PIN_WINDOWS[Math.max(0, Math.min(PIN_WINDOWS.length - 1, Math.round(p.window)))];
  const halfFrac = w.sigmaMult * p.sigma;
  const maxOffset = w.travelSigma * p.sigma;
  const offsetFrac = Math.max(-maxOffset, Math.min(maxOffset, p.offsetFrac));
  const pin1e9 = (p.spot1e9 * BigInt(Math.round((1 + offsetFrac) * 1e9))) / FLOAT_SCALING;
  const half = (p.spot1e9 * BigInt(Math.round(halfFrac * 1e9))) / FLOAT_SCALING;
  const { lowerTick, higherTick } = ticksForRange(pin1e9 - half, pin1e9 + half, p.tickSize, p.admissionTickSize);
  return { w, halfFrac, offsetFrac, pin1e9, half, lowerTick, higherTick };
}

/**
 * Every corner of PIN's ladder as the band it would really mint, so `scripts/verify-pin-ladder.ts` can
 * simulate each one and prove the whole knob travel admits before a multiple is offered on screen. Read-only.
 */
export async function probePinLadder(stepsPerSide: number): Promise<{
  marketId: string;
  spot1e9: bigint;
  seconds: number;
  sigma: number;
  bands: Array<{ window: number; prob: number; offsetSigma: number; pin1e9: bigint; halfUsd: number; lowerTick: bigint; higherTick: bigint }>;
}> {
  const market = rangeMarket();
  const { spot1e9: cachedSpot, tickSize, admissionTickSize } = realEcon(market);
  // Same fresh read the resolve path takes, so a rung is probed against the spot it would mint at. Sizing a
  // whole sweep off one snapshot lets BTC drift a sigma underneath it and the marginal rungs flip on noise.
  const spot1e9 = await freshRealSpot(cachedSpot);
  const seconds = Math.max(1, (market.expiryMs - now()) / 1000);
  const sigma = rangeSigmaFrac(seconds);
  const bands = PIN_WINDOWS.flatMap((w) =>
    Array.from({ length: stepsPerSide * 2 + 1 }, (_, i) => {
      const offsetSigma = ((i - stepsPerSide) / stepsPerSide) * w.travelSigma;
      const b = pinBand({ spot1e9, offsetFrac: offsetSigma * sigma, window: w.tier, sigma, tickSize, admissionTickSize });
      return {
        window: w.tier,
        prob: w.prob,
        offsetSigma,
        pin1e9: b.pin1e9,
        halfUsd: (Number(b.half) / 1e9),
        lowerTick: b.lowerTick,
        higherTick: b.higherTick,
      };
    }),
  );
  return { marketId: market.oracleId, spot1e9, seconds, sigma, bands };
}

async function resolveRealPin(netRaw: bigint, stakeRaw: bigint, input: { pin: number; window: number }): Promise<ResolvedReal> {
  void ensureRangeCalib(); // shares RANGE's implied vol; never block a tap on it
  const market = rangeMarket();
  const { spot1e9: cachedSpot, tickSize, admissionTickSize } = realEcon(market);
  const spot1e9 = await freshRealSpot(cachedSpot);
  const seconds = Math.max(1, (market.expiryMs - now()) / 1000);
  const sigma = rangeSigmaFrac(seconds);

  if (!(input.pin > 0)) throw new PlayError('INVALID_PARAMS', 'Name a price');
  const spot = Number(spot1e9) / 1e9;
  const { halfFrac, offsetFrac, pin1e9, half, lowerTick, higherTick } = pinBand({
    spot1e9,
    offsetFrac: (input.pin - spot) / spot,
    window: input.window,
    sigma,
    tickSize,
    admissionTickSize,
  });

  return {
    game: 'pin',
    kind: 'range',
    marketId: market.oracleId,
    asset: REAL_BTC_GAME_ASSET,
    spot1e9,
    tickSize,
    admissionTickSize,
    lowerTick,
    higherTick,
    leverage1e9: LEVERAGE_ONE,
    amountRaw: premiumBudget(netRaw),
    minQuantityRaw: POSITION_LOT_SIZE,
    expiryMs: market.expiryMs,
    duration: Math.max(1, Math.round(seconds)),
    entrySpot: realFmt(spot1e9),
    tierMultiplier: (() => {
      const p = pinWinProb(offsetFrac, halfFrac, sigma);
      return tierMultOf(p) * pinRatioAt(pinCalibration(), p);
    })(),
    // The named price, recorded so the settle reveal can state the miss distance against the truth.
    strikeDisplay: realFmt(pin1e9),
    lowerDisplay: realFmt(pin1e9 - half),
    upperDisplay: realFmt(pin1e9 + half),
    widthPct: Math.round(halfFrac * 200 * 1e4) / 1e4,
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
  if (input.game === 'pin') return resolveRealPin(netRaw, stakeRaw, input);
  return resolveRealRange(netRaw, stakeRaw, input);
}
