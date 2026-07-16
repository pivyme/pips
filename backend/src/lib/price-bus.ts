// displaySpot(asset): Binance motion EMA-pinned to the on-chain oracle, degrading to gameSpot if either stalls.
// Display-only (L-015), entry/cash-out/settle always read the chain; fork mode short-circuits to gameSpot verbatim.

import {
  IS_REAL_PREDICT,
  PRICE_PIN_BUZZER_MS,
  PRICE_PIN_REENTRY_MS,
  PRICE_PIN_SLEW_FRAC_PER_SEC,
  PRICE_PIN_TAU_MS,
} from '../config/main-config.ts';
import { binanceSpot } from './binance-ws.ts';
import { gameSpot } from './game-price.ts';
import { allMarkets, assetSpot } from './sui/markets.ts';

type Spot = { price: number; ts: number };

// Pin tuning (display only, deliberately gentle): TAU eases the offset toward the oracle gap, SLEW caps
// its correction speed, REENTRY is the healthy streak before trusting Binance again, BUZZER converges the pin near expiry so the reveal matches settlement. All four are env-overridable knobs in main-config.ts.
const PIN_TAU_MS = PRICE_PIN_TAU_MS;
const SLEW_FRAC_PER_SEC = PRICE_PIN_SLEW_FRAC_PER_SEC; // max offset move per second as a fraction of price
const REENTRY_AFTER_MS = PRICE_PIN_REENTRY_MS;
const BUZZER_CONVERGE_MS = PRICE_PIN_BUZZER_MS;

type Driver = 'binance' | 'fallback';
type St = {
  offset: number; // smoothed (oracleLevel - binancePrice), in price units
  lastAt: number; // last compute time, for the EMA dt
  driver: Driver;
  healthySince: number; // when Binance became continuously healthy again (0 = not counting)
  lastDisplay: number; // last emitted price, for a seamless handoff / re-seed
};

const states = new Map<string, St>();

function stateOf(asset: string): St {
  let st = states.get(asset);
  if (!st) {
    st = { offset: 0, lastAt: 0, driver: 'fallback', healthySince: 0, lastDisplay: 0 };
    states.set(asset, st);
  }
  return st;
}

// True when the soonest live oracle for this asset is inside the buzzer window (an open play is about
// to settle). Reads only the markets cache, so this fires only in the last seconds before settlement, not continuously.
function buzzerConverging(asset: string, now: number): boolean {
  let soonest = Infinity;
  for (const m of allMarkets()) {
    if (m.underlying !== asset || m.settled) continue;
    const t = m.expiryMs - now;
    if (t > 0 && t < soonest) soonest = t;
  }
  return soonest <= BUZZER_CONVERGE_MS;
}

// Pure: EMA-pulls the offset toward `target` (time-constant tauMs), then slew-clamps the move to
// slewFracPerSec * dt * price so a Binance flash drifts toward the oracle instead of teleporting.
export function pinnedOffsetStep(prev: number, target: number, dtMs: number, price: number, tauMs: number, slewFracPerSec: number): number {
  const k = 1 - Math.exp(-dtMs / tauMs);
  const desired = prev + (target - prev) * k;
  const maxStep = slewFracPerSec * (dtMs / 1000) * price;
  const step = desired - prev;
  if (step > maxStep) return prev + maxStep;
  if (step < -maxStep) return prev - maxStep;
  return desired;
}

// Pure: the fallback-ladder re-entry hysteresis. Binance drives only after a healthy streak of reentryMs;
// any unhealthy read drops to fallback immediately, so a single gap never stutters the line between modes.
export function nextPinDriver(prev: Driver, canBinance: boolean, healthySince: number, now: number, reentryMs: number): { driver: Driver; healthySince: number } {
  if (!canBinance) return { driver: 'fallback', healthySince: 0 };
  if (prev === 'binance') return { driver: 'binance', healthySince };
  const since = healthySince === 0 ? now : healthySince;
  if (now - since >= reentryMs) return { driver: 'binance', healthySince: 0 };
  return { driver: 'fallback', healthySince: since };
}

// The chart display price for an asset. Async to match gameSpot (the fallback awaits a Pyth read on a
// cold boot). Returns null only when even gameSpot has nothing yet; the SSE/WS layer guards null.
export async function displaySpot(asset: string): Promise<Spot | null> {
  // Fork mode / real mode with the feed off both funnel here: binanceSpot is null, so the ladder falls
  // straight to gameSpot. Short-circuit fork mode outright so its output is byte-identical (no state).
  if (!IS_REAL_PREDICT) return gameSpot(asset);

  const now = Date.now();
  const oracleSpot = assetSpot(asset); // on-chain BS level (display units) | null
  const b = binanceSpot(asset); // fresh Binance last-trade | null
  const st = stateOf(asset);
  const canBinance = b != null && oracleSpot != null && oracleSpot > 0;

  // Driver decision with re-entry hysteresis: drop to fallback the moment Binance can't drive (already
  // null only after BINANCE_STALE_MS of silence), but require a healthy streak before switching back so a recovered tick doesn't stutter the line.
  const dec = nextPinDriver(st.driver, canBinance, st.healthySince, now, REENTRY_AFTER_MS);
  const switchedToBinance = st.driver === 'fallback' && dec.driver === 'binance';
  st.driver = dec.driver;
  st.healthySince = dec.healthySince;
  if (switchedToBinance && b != null && oracleSpot != null) {
    // Re-seed the offset from the current gap so the first Binance value == the last displayed value.
    st.offset = (st.lastDisplay > 0 ? st.lastDisplay : oracleSpot) - b.price;
  }

  if (st.driver === 'binance' && b != null && oracleSpot != null) {
    const target = oracleSpot - b.price;
    const dt = Math.min(Math.max(now - (st.lastAt || now), 1), 2000);
    if (buzzerConverging(asset, now)) {
      st.offset = target; // full convergence so the near-buzzer line matches settlement
    } else {
      st.offset = pinnedOffsetStep(st.offset, target, dt, b.price, PIN_TAU_MS, SLEW_FRAC_PER_SEC);
    }
    st.lastAt = now;
    const price = b.price + st.offset;
    st.lastDisplay = price > 0 ? price : b.price;
    return { price: st.lastDisplay, ts: now };
  }

  // Fallback: today's eased on-chain feed. Keep the offset roughly seeded so a future re-entry is smooth.
  const g = await gameSpot(asset);
  st.lastAt = now;
  if (g && g.price > 0) {
    st.lastDisplay = g.price;
    if (b != null) st.offset = g.price - b.price;
  }
  return g;
}

// Test/introspection hook: reset the per-asset pin state so a unit test starts clean.
export function _resetPriceBus(): void {
  states.clear();
}
