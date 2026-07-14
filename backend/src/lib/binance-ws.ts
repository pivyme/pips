// The Binance display feed. One shared upstream websocket (NOT per-user, NOT per-chart) subscribed to a
// combined aggTrade stream for every configured asset. It maintains the last-trade price per asset in
// memory; the price bus (price-bus.ts) reads it, pins its LEVEL to the on-chain oracle, and streams the
// result to charts. This module never records or settles anything (L-015): it is pure display motion.
//
// Real mode (testnet) + mainnet only. In fork mode (localnet/devnet) the socket never opens (the walk
// engine is what settles there and is already lively), so binanceSpot always returns null and the bus
// falls straight through to the on-chain gameSpot. It also stays silent when BINANCE_ENABLED is off.
//
// Robustness is deliberate (a hosted, long-lived socket): auto-reconnect with capped backoff + jitter, a
// staleness watchdog that force-reconnects a silent-but-open socket, and loud logging on repeated connect
// failure (geo-block / 451) without ever crashing the process. Binance sends WebSocket ping control
// frames every ~20s and the runtime auto-pongs, and closes the connection after 24h; a close just trips
// the reconnect path, so both are handled for free. The fallback ladder in price-bus.ts makes any of
// these degrade to today's on-chain chart with zero regression.

import { BINANCE_ENABLED, BINANCE_STALE_MS, BINANCE_SYMBOLS, BINANCE_WS_URL, IS_REAL_PREDICT } from '../config/main-config.ts';
import { assetSpot } from './sui/markets.ts';

type Spot = { price: number; ts: number };

// asset -> latest last-trade price + local receive time. ts is the local clock (not Binance's trade
// time) so the staleness watchdog measures wire liveness, which is what the fallback ladder cares about.
const spots = new Map<string, Spot>();
// symbol (e.g. BTCUSDT) -> asset (BTC), the reverse of BINANCE_SYMBOLS, resolved once per message.
const symbolToAsset = new Map<string, string>(
  Object.entries(BINANCE_SYMBOLS).map(([asset, sym]) => [sym.toUpperCase(), asset]),
);

let ws: WebSocket | null = null;
let started = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let compareTimer: ReturnType<typeof setInterval> | null = null;
let backoffMs = 1000; // exponential, reset on a healthy first message
let consecutiveFailures = 0; // drives the loud geo-block warning after repeated connect failures
let lastMsgAt = 0; // local time of the last aggTrade of any asset; 0 = never
let geoWarned = false; // log the geo-block hint at most once per dry spell

const BACKOFF_MAX_MS = 30_000;
const GEO_WARN_AFTER = 5; // consecutive failed connects before the loud "likely geo-blocked" hint

// The freshest Binance last-trade for an asset, or null if never seen or stale. price-bus.ts also
// re-checks staleness itself; returning null here on stale keeps a single source of truth for "no feed".
export function binanceSpot(asset: string): Spot | null {
  const s = spots.get(asset);
  if (!s) return null;
  if (Date.now() - s.ts > BINANCE_STALE_MS) return null;
  return s;
}

// Whether the upstream is currently healthy (connected + a recent message). For logging / status only.
export function binanceHealthy(): boolean {
  return ws?.readyState === WebSocket.OPEN && lastMsgAt > 0 && Date.now() - lastMsgAt <= BINANCE_STALE_MS;
}

// Build the combined-stream URL from the configured symbols. Binance auto-subscribes from the query, so
// there is no separate SUBSCRIBE frame to resend, the reconnect (fresh URL) IS the resubscribe.
function streamUrl(): string {
  const streams = Object.values(BINANCE_SYMBOLS)
    .map((sym) => `${sym}@aggTrade`)
    .join('/');
  return `${BINANCE_WS_URL}?streams=${streams}`;
}

function scheduleReconnect(): void {
  if (reconnectTimer || !started) return;
  const jitter = Math.floor(backoffMs * 0.3 * Math.random());
  const delay = backoffMs + jitter;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
  (reconnectTimer as { unref?: () => void }).unref?.();
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
}

function connect(): void {
  if (!started) return;
  let sock: WebSocket;
  try {
    sock = new WebSocket(streamUrl());
  } catch (e) {
    // Constructing the socket threw (bad URL, etc.). Treat as a failed connect and back off, never throw.
    consecutiveFailures++;
    console.warn('[Binance] socket construct failed:', e instanceof Error ? e.message : e);
    scheduleReconnect();
    return;
  }
  ws = sock;

  sock.onopen = () => {
    // Connection is up, but not yet proven live (no data). Backoff resets on the first real message.
    consecutiveFailures = 0;
    geoWarned = false;
    console.log('[Binance] connected:', streamUrl());
  };

  sock.onmessage = (ev) => {
    const now = Date.now();
    lastMsgAt = now;
    backoffMs = 1000; // healthy data flowing, reset the backoff
    try {
      const frame = JSON.parse(String(ev.data)) as { data?: { s?: string; p?: string } };
      const d = frame.data;
      if (!d?.s || !d.p) return;
      const asset = symbolToAsset.get(d.s.toUpperCase());
      if (!asset) return;
      const price = Number(d.p);
      if (!Number.isFinite(price) || price <= 0) return;
      spots.set(asset, { price, ts: now });
    } catch {
      // Malformed frame; the next one arrives in milliseconds. Never let a parse error kill the socket.
    }
  };

  sock.onerror = () => {
    // A handshake/transport error. onclose fires right after and drives the reconnect, so just count it.
    consecutiveFailures++;
    if (consecutiveFailures >= GEO_WARN_AFTER && !geoWarned) {
      geoWarned = true;
      console.warn(
        `[Binance] ${consecutiveFailures} consecutive connect failures for ${BINANCE_WS_URL}. The deploy region may be geo-blocked (Binance blocks the US and several cloud regions). The chart is running on the on-chain fallback with no regression; set PIPS_BINANCE_WS_URL to binance.us or a relay to restore live motion.`,
      );
    }
  };

  sock.onclose = () => {
    if (ws === sock) ws = null;
    scheduleReconnect();
  };
}

// Tear down a socket that is OPEN but has gone silent (no data past the stale window). A silent socket
// won't fire onclose on its own, so force it: close triggers reconnect, and a fresh URL resubscribes.
function watchdog(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (lastMsgAt === 0) return; // opened but no data yet, give it a beat (backoff handles a truly dead open)
  if (Date.now() - lastMsgAt > BINANCE_STALE_MS * 2) {
    console.warn('[Binance] feed silent past the stale window, forcing reconnect');
    try {
      ws.close();
    } catch {
      // ignore; onclose (or the next watchdog tick) reconnects
    }
  }
}

// De-risk aid (phase 1): periodically log the live Binance spot next to the on-chain BS oracle spot so
// the two feeds can be eyeballed on the deploy box. Low cadence, real mode only, so it is not noise.
function logCompare(): void {
  for (const asset of Object.keys(BINANCE_SYMBOLS)) {
    const b = binanceSpot(asset);
    const o = assetSpot(asset);
    if (b == null && o == null) continue;
    const delta = b && o ? (((b.price - o) / o) * 100).toFixed(3) + '%' : 'n/a';
    console.log(`[Binance] ${asset} live=${b ? b.price.toFixed(2) : 'stale'} oracle=${o != null ? o.toFixed(2) : 'none'} Δ=${delta}`);
  }
}

// Open the shared upstream. Idempotent. No-op unless real mode + enabled (fork keeps its walk engine, and
// the feed can be killed via PIPS_BINANCE_ENABLED=false). Safe to call at boot regardless of mode.
export function startBinance(): void {
  if (started) return;
  if (!IS_REAL_PREDICT || !BINANCE_ENABLED) {
    console.log(`[Binance] display feed off (${!IS_REAL_PREDICT ? 'fork mode' : 'BINANCE_ENABLED=false'}); chart uses the on-chain oracle`);
    return;
  }
  if (symbolToAsset.size === 0) {
    console.warn('[Binance] no symbols configured (PIPS_BINANCE_SYMBOLS empty); display feed disabled');
    return;
  }
  started = true;
  connect();
  watchdogTimer = setInterval(watchdog, BINANCE_STALE_MS);
  (watchdogTimer as { unref?: () => void }).unref?.();
  compareTimer = setInterval(logCompare, 30_000);
  (compareTimer as { unref?: () => void }).unref?.();
}

// Stop the feed and clear timers. For tests / graceful shutdown; not used in the normal server lifecycle.
export function stopBinance(): void {
  started = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (watchdogTimer) clearInterval(watchdogTimer);
  if (compareTimer) clearInterval(compareTimer);
  reconnectTimer = watchdogTimer = compareTimer = null;
  try {
    ws?.close();
  } catch {
    // ignore
  }
  ws = null;
}
