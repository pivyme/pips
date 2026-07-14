// The display price bus. `displaySpot(asset)` is the single source the chart transport (SSE + the WS
// hub) reads: Binance MOTION pinned to the on-chain oracle LEVEL. Nothing truthful reads it (L-015),
// entry / cash-out / settle all keep reading the chain. It is a graceful degradation ladder, so the
// worst case is exactly today's chart, never worse, never a crash.
//
//  1. Primary (real mode, Binance healthy): `binanceSpot + smoothedOffset`, where the offset is an
//     EMA of `(oracleLevel - binancePrice)`, slew-limited so a Binance-only flash drifts toward the
//     oracle instead of teleporting. The line moves freely with real BTC; only the reconciliation gap
//     is rate-limited (never the price). `entrySpot` (the same BS oracle level) sits on the line by
//     construction, so overlays need no client-side offset.
//  2. Binance stale/down: fall straight through to `gameSpot()` (today's eased on-chain BS spot). The
//     pinned level already equals the oracle, so the last good Binance value ~ the on-chain spot, the
//     handoff does not jump. Hysteresis (a healthy streak before switching back) stops flapping.
//  3. On-chain also cold: `gameSpot` itself falls to raw Pyth. Defense in depth, all three exist today.
//
// Fork mode (localnet/devnet) short-circuits to `gameSpot` verbatim, so its chart is byte-identical to
// before (the walk engine is what settles there and is already lively, never pin it to an external feed).

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

// Pin tuning (display only, so deliberately gentle). PIN_TAU pulls the offset toward the oracle gap;
// SLEW caps how fast that gap can correct so a flash drifts, not teleports; REENTRY is the healthy
// streak required before trusting Binance again after an outage; BUZZER converges the pin fully as an
// oracle nears expiry so the visual outcome lines up with settlement (the reveal still snaps to truth).
// All four are env-overridable knobs (main-config.ts) so a live real-mode session tunes without a redeploy.
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

// True when the soonest live oracle for this asset is inside the buzzer window, i.e. an open play is
// about to settle. Reads only the markets cache (no per-play coupling); real mode markets are ~cadence
// apart, so this fires only in the last seconds before a settlement, not continuously.
function buzzerConverging(asset: string, now: number): boolean {
  let soonest = Infinity;
  for (const m of allMarkets()) {
    if (m.underlying !== asset || m.settled) continue;
    const t = m.expiryMs - now;
    if (t > 0 && t < soonest) soonest = t;
  }
  return soonest <= BUZZER_CONVERGE_MS;
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

  // Driver decision with re-entry hysteresis: drop to fallback the moment Binance can't drive (it is
  // already null only after BINANCE_STALE_MS of silence), but require a healthy streak before switching
  // back so a single recovered tick doesn't stutter the line between modes.
  if (canBinance) {
    if (st.driver === 'fallback') {
      if (st.healthySince === 0) st.healthySince = now;
      if (now - st.healthySince >= REENTRY_AFTER_MS) {
        st.driver = 'binance';
        st.healthySince = 0;
        // Re-seed the offset from the current gap so the first Binance value == the last displayed value.
        st.offset = (st.lastDisplay > 0 ? st.lastDisplay : (oracleSpot as number)) - (b as Spot).price;
      }
    }
  } else {
    st.healthySince = 0;
    st.driver = 'fallback';
  }

  if (st.driver === 'binance' && b != null && oracleSpot != null) {
    const target = oracleSpot - b.price;
    const dt = Math.min(Math.max(now - (st.lastAt || now), 1), 2000);
    if (buzzerConverging(asset, now)) {
      st.offset = target; // full convergence so the near-buzzer line matches settlement
    } else {
      const k = 1 - Math.exp(-dt / PIN_TAU_MS);
      let desired = st.offset + (target - st.offset) * k;
      const maxStep = SLEW_FRAC_PER_SEC * (dt / 1000) * b.price;
      const step = desired - st.offset;
      if (step > maxStep) desired = st.offset + maxStep;
      else if (step < -maxStep) desired = st.offset - maxStep;
      st.offset = desired;
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
