// displaySpot(asset): the chart line's LEVEL is the FRESH on-chain oracle (the same series entry/band/settle
// sample), with Binance contributing only bounded, zero-mean, high-frequency texture that can never pull the
// line more than WIGGLE_MAX off the oracle and converges to 0 near the buzzer. Display-only (L-015):
// entry/cash-out/settle always read the chain, and the result reveal snaps to the true on-chain settlePrice.

import {
  PRICE_LEVEL_TAU_MS,
  PRICE_ORACLE_TTL_MS,
  PRICE_PIN_BUZZER_MS,
  PRICE_PIN_REENTRY_MS,
  PRICE_PIN_TAU_MS,
  PRICE_WIGGLE_MAX_FRAC,
} from '../config/main-config.ts';
import { binanceSpot } from './binance-ws.ts';
import { gameSpot } from './game-price.ts';
import { allMarkets, assetSpot } from './sui/markets.ts';
import { REAL_BTC_ASSET } from './sui/config-real.ts';
import { readBtcSpot } from './sui/predict-real.ts';

type Spot = { price: number; ts: number };

const REAL_BTC_GAME_ASSET = 'BTC'; // the only asset with a live BS spot object to anchor against

// Level/texture tuning (display only). LEVEL_TAU eases the sub-2s oracle steps onto the line without a
// stair-step. PIN_TAU is the Binance SLOW-EMA window defining what counts as high-frequency texture
// (binance - slowEMA). REENTRY is the healthy streak before trusting Binance texture again after an outage.
// BUZZER converges the line onto the bare oracle near expiry so the reveal matches settlement.
const LEVEL_TAU_MS = PRICE_LEVEL_TAU_MS;
const BIN_SLOW_TAU_MS = PRICE_PIN_TAU_MS;
const REENTRY_AFTER_MS = PRICE_PIN_REENTRY_MS;
const BUZZER_CONVERGE_MS = PRICE_PIN_BUZZER_MS;
const WIGGLE_MAX_FRAC = PRICE_WIGGLE_MAX_FRAC; // max stray from the oracle, as a fraction of price

type Driver = 'binance' | 'fallback';
type St = {
  easedLevel: number; // smoothed fresh-oracle LEVEL, the line's level (price units)
  slowBin: number; // slow EMA of Binance, for the zero-mean texture = binance - slowBin
  lastAt: number; // last compute time, for the EMA dt
  driver: Driver;
  healthySince: number; // when Binance became continuously healthy again (0 = not counting)
  lastDisplay: number; // last emitted price, for a seamless handoff / re-seed
};

const states = new Map<string, St>();

function stateOf(asset: string): St {
  let st = states.get(asset);
  if (!st) {
    st = { easedLevel: 0, slowBin: 0, lastAt: 0, driver: 'fallback', healthySince: 0, lastDisplay: 0 };
    states.set(asset, st);
  }
  return st;
}

// === Fresh-oracle anchor (BTC) ===
// The line's LEVEL should pin to a fresher oracle than the 2s market-sync cache. Reuse readBtcSpot() behind a
// small TTL cache and a single-inflight guard so the 10Hz broadcast costs ~1 chain read/sec, NEVER awaited on
// the hot path: displaySpot returns the last cached anchor immediately and refreshes in the background.
type Anchor = { price: number; at: number };
let btcAnchor: Anchor | null = null;
let anchorInflight: Promise<void> | null = null;

function refreshBtcAnchor(): void {
  if (anchorInflight) return; // at most one read in flight
  anchorInflight = readBtcSpot()
    .then((s) => {
      if (s && s.spot1e9 > 0n) btcAnchor = { price: Number(s.spot1e9) / 1e9, at: Date.now() };
    })
    .catch(() => {
      // keep the last anchor on a failed read; assetSpot still covers the caller
    })
    .finally(() => {
      anchorInflight = null;
    });
}

// The fresh on-chain oracle level for an asset, display units. BTC uses the TTL-cached live BS spot (the same
// feed freshRealSpot/load_live_pricer mark against); non-BTC and BTC-cold-boot degrade to the synced market spot.
function freshOracleAnchor(asset: string, now: number): number | null {
  if (asset === REAL_BTC_GAME_ASSET && REAL_BTC_ASSET) {
    if (!btcAnchor || now - btcAnchor.at >= PRICE_ORACLE_TTL_MS) refreshBtcAnchor(); // background only
    if (btcAnchor) return btcAnchor.price;
    // cold boot: no anchor read has landed yet, fall through to the 2s synced spot
  }
  return assetSpot(asset);
}

// True when the soonest live oracle for this asset is inside the buzzer window (an open play is about to
// settle). Reads only the markets cache, so it fires only in the last seconds before settlement.
function buzzerConverging(asset: string, now: number): boolean {
  let soonest = Infinity;
  for (const m of allMarkets()) {
    if (m.underlying !== asset || m.settled) continue;
    const t = m.expiryMs - now;
    if (t > 0 && t < soonest) soonest = t;
  }
  return soonest <= BUZZER_CONVERGE_MS;
}

// Pure: the fallback-ladder re-entry hysteresis. Binance drives the TEXTURE only after a healthy streak of
// reentryMs; any unhealthy read drops to fallback immediately, so a single gap never stutters the line.
export function nextPinDriver(prev: Driver, canBinance: boolean, healthySince: number, now: number, reentryMs: number): { driver: Driver; healthySince: number } {
  if (!canBinance) return { driver: 'fallback', healthySince: 0 };
  if (prev === 'binance') return { driver: 'binance', healthySince };
  const since = healthySince === 0 ? now : healthySince;
  if (now - since >= reentryMs) return { driver: 'binance', healthySince: 0 };
  return { driver: 'fallback', healthySince: since };
}

// The chart display price for an asset. Async to match gameSpot (the fallback rung awaits a Pyth read on a
// cold boot). Returns null only when even gameSpot has nothing yet; the SSE/WS layer guards null.
export async function displaySpot(asset: string): Promise<Spot | null> {
  const now = Date.now();
  const anchor = freshOracleAnchor(asset, now); // fresh on-chain oracle level (display units) | null
  const b = binanceSpot(asset); // fresh Binance last-trade | null
  const st = stateOf(asset);
  const canBinance = b != null && anchor != null && anchor > 0;

  const dec = nextPinDriver(st.driver, canBinance, st.healthySince, now, REENTRY_AFTER_MS);
  st.driver = dec.driver;
  st.healthySince = dec.healthySince;

  if (st.driver === 'binance' && b != null && anchor != null) {
    const dt = Math.min(Math.max(now - (st.lastAt || now), 1), 2000);
    st.lastAt = now;

    // Near the buzzer, snap the level onto the fresh oracle and kill the texture so the line == what settles.
    if (buzzerConverging(asset, now)) {
      st.easedLevel = anchor;
      st.slowBin = b.price; // park the texture EMA so re-entry after the round starts at texture 0
      st.lastDisplay = anchor;
      return { price: anchor, ts: now };
    }

    // 1) Ease the LEVEL toward the fresh oracle: the level IS the oracle series entry/settle sample, not the
    //    Binance basis. Short tau glides the sub-2s oracle steps without reintroducing lag.
    const kLvl = 1 - Math.exp(-dt / LEVEL_TAU_MS);
    st.easedLevel = st.easedLevel > 0 ? st.easedLevel + (anchor - st.easedLevel) * kLvl : anchor;

    // 2) Zero-mean, high-frequency texture = binance - its slow EMA. Lively 10Hz motion that averages to 0,
    //    so the line oscillates AROUND the oracle instead of drifting off it.
    const kBin = 1 - Math.exp(-dt / BIN_SLOW_TAU_MS);
    st.slowBin = st.slowBin > 0 ? st.slowBin + (b.price - st.slowBin) * kBin : b.price;

    // 3) Hard-clamp the texture to +/- WIGGLE_MAX so a Binance spike or a persistent basis can never pull the
    //    line more than a small wiggle off the fresh oracle.
    const wiggle = anchor * WIGGLE_MAX_FRAC;
    const texture = Math.max(-wiggle, Math.min(wiggle, b.price - st.slowBin));

    const price = st.easedLevel + texture;
    st.lastDisplay = price > 0 ? price : st.easedLevel;
    return { price: st.lastDisplay, ts: now };
  }

  // Fallback: no Binance -> the eased on-chain feed (gameSpot). Keep the level/texture seeded so a future
  // re-entry is seamless (level continues from here, texture starts at 0).
  const g = await gameSpot(asset);
  st.lastAt = now;
  if (g && g.price > 0) {
    st.easedLevel = g.price;
    st.lastDisplay = g.price;
    if (b != null) st.slowBin = b.price;
  }
  return g;
}

// Test/introspection hook: reset the per-asset state and the anchor cache so a unit test starts clean.
export function _resetPriceBus(): void {
  states.clear();
  btcAnchor = null;
  anchorInflight = null;
}
