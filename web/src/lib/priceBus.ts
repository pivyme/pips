// The client price bus: one shared, ref-counted WebSocket multiplexing every asset any chart wants (Lucky's up-to-3 charts share this connection).
// Auto-reconnects with backoff and falls back to per-connection SSE if the WS can't establish; display-only (L-015), nothing truthful reads this feed.

import { env } from '@/env'
import { api, getAuthToken, streamPrices, type PriceTick } from './api'
import { demoStreamPrices, isDemo } from './demo'

type Cb = (t: PriceTick) => void
// The chart pre-roll, ages already resolved against the server clock: ageMs back from "now" at fetch time.
export type PricePast = { asset: string; fetchedAt: number; points: Array<{ ageMs: number; p: number }> }

const WS_ENABLED = env.VITE_PRICE_WS_ENABLED !== 'false'
const WS_OPEN_TIMEOUT_MS = 4000 // no OPEN within this -> treat the attempt as failed
const WS_MAX_FAILS = 3 // consecutive failed connects before falling back to SSE for the session
const BACKOFF_MAX_MS = 15000

const base = env.VITE_API_URL.replace(/\/$/, '')
const wsBase = base.replace(/^http/, 'ws') // http->ws, https->wss

const subs = new Map<string, Set<Cb>>() // asset -> callbacks
const sseUnsubs = new Map<string, () => void>() // asset -> active SSE unsub (fallback transport)

let ws: WebSocket | null = null
let mode: 'ws' | 'sse' = WS_ENABLED ? 'ws' : 'sse'
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let openTimer: ReturnType<typeof setTimeout> | null = null
let backoffMs = 1000
let fails = 0

function dispatch(asset: string, tick: PriceTick): void {
  const set = subs.get(asset)
  if (!set) return
  for (const cb of set) {
    try {
      cb(tick)
    } catch {
      // a bad consumer never kills the feed
    }
  }
}

function currentAssets(): string[] {
  return [...subs.keys()]
}

function sendSub(): void {
  if (ws?.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'sub', assets: currentAssets() }))
    } catch {
      // the reconnect path resubscribes
    }
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer || mode !== 'ws') return
  const delay = backoffMs + Math.floor(backoffMs * 0.3 * Math.random())
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS)
}

// Gives up on the WS for this session, routing every asset through SSE; sticky until a page reload retries the WS, so the transport is never worse than before.
function fallbackToSse(): void {
  if (mode === 'sse') return
  mode = 'sse'
  if (openTimer) clearTimeout(openTimer)
  if (reconnectTimer) clearTimeout(reconnectTimer)
  openTimer = reconnectTimer = null
  try {
    ws?.close()
  } catch {
    // already gone
  }
  ws = null
  console.warn('[priceBus] WebSocket unavailable, using SSE fallback for this session')
  for (const asset of subs.keys()) ensureSse(asset)
}

function ensureSse(asset: string): void {
  if (sseUnsubs.has(asset)) return
  // streamPrices is the real per-connection SSE here (demo is handled in subscribe()).
  sseUnsubs.set(asset, streamPrices(asset, (t) => dispatch(asset, t)))
}

function teardownSse(asset: string): void {
  sseUnsubs.get(asset)?.()
  sseUnsubs.delete(asset)
}

function connect(): void {
  if (mode !== 'ws' || ws) return
  const token = getAuthToken()
  if (!token || currentAssets().length === 0) {
    // No token yet (auth still loading) or nothing to watch. A subscribe() call retries.
    return
  }
  const url = `${wsBase}/ws?assets=${encodeURIComponent(currentAssets().join(','))}&t=${encodeURIComponent(token)}`
  let sock: WebSocket
  try {
    sock = new WebSocket(url)
  } catch {
    fails++
    if (fails >= WS_MAX_FAILS) fallbackToSse()
    else scheduleReconnect()
    return
  }
  ws = sock

  openTimer = setTimeout(() => {
    if (sock.readyState !== WebSocket.OPEN) {
      try {
        sock.close()
      } catch {
        // onclose drives the retry / fallback
      }
    }
  }, WS_OPEN_TIMEOUT_MS)

  sock.onopen = () => {
    if (openTimer) clearTimeout(openTimer)
    openTimer = null
    backoffMs = 1000
    fails = 0
    sendSub() // resubscribe the live asset set on every (re)open
  }
  sock.onmessage = (e) => {
    try {
      const m = JSON.parse(String(e.data)) as { type?: string; asset?: string; price?: string; ts?: number }
      if (m.type === 'price' && m.asset && m.price != null) {
        dispatch(m.asset, { price: String(m.price), ts: m.ts ?? Date.now() })
      }
    } catch {
      // ignore a malformed frame
    }
  }
  sock.onerror = () => {
    // onclose fires next and owns the retry decision.
  }
  sock.onclose = () => {
    if (openTimer) clearTimeout(openTimer)
    openTimer = null
    if (ws === sock) ws = null
    if (mode !== 'ws') return
    fails++
    if (fails >= WS_MAX_FAILS) fallbackToSse()
    else scheduleReconnect()
  }
}

// Subscribe a chart to an asset's price feed. Returns an unsub. Same contract as the old streamPrices.
export function subscribe(asset: string, cb: Cb, onError?: () => void): () => void {
  // Demo mode: the in-memory twin, no backend, no shared socket.
  if (isDemo()) return demoStreamPrices(asset, cb)
  void onError // WS/SSE both self-heal; the chart's onError is a no-op safety hook, kept for parity.

  let set = subs.get(asset)
  if (!set) {
    set = new Set()
    subs.set(asset, set)
  }
  set.add(cb)

  if (mode === 'ws') {
    if (ws) sendSub() // socket already up: tell the server about the (possibly) new asset
    else connect() // opens with the current asset set, or no-ops until a token exists
  } else {
    ensureSse(asset)
  }

  return () => {
    const s = subs.get(asset)
    if (!s) return
    s.delete(cb)
    if (s.size > 0) return
    subs.delete(asset)
    if (mode === 'sse') teardownSse(asset)
    else sendSub() // narrow the server-side subscription; the server reaps the idle asset loop
  }
}

// === Shared chart pre-roll ===
// The line behind the leading edge is the server's recorded window, not a local random walk, so two devices
// opening the same game draw the same past. Ages are server-relative (not epoch), so a skewed device clock
// can't shift the history sideways. Cached briefly and deduped in flight: Lucky's stacked charts and a
// remount inside a round all ride one request.

const PAST_TTL_MS = 2000
const pastCache = new Map<string, PricePast>()
const pastInflight = new Map<string, Promise<PricePast | null>>()

const isFresh = (past: PricePast): boolean => performance.now() - past.fetchedAt < PAST_TTL_MS

// The pre-roll if it's already in hand, else null. Synchronous so a chart can seed its first paint from real
// history with no swap when something prefetched it.
export function cachedPast(asset: string): PricePast | null {
  const hit = pastCache.get(asset)
  return hit && isFresh(hit) ? hit : null
}

export function fetchPast(asset: string): Promise<PricePast | null> {
  const hit = cachedPast(asset)
  if (hit) return Promise.resolve(hit)
  const running = pastInflight.get(asset)
  if (running) return running
  const req = api
    .priceHistory(asset)
    .then((res) => {
      const points = res.points
        .map((pt) => ({ ageMs: res.now - pt.t, p: pt.p }))
        .filter((pt) => Number.isFinite(pt.ageMs) && pt.ageMs >= 0 && pt.p > 0)
      if (points.length === 0) return null
      const past: PricePast = { asset, fetchedAt: performance.now(), points }
      pastCache.set(asset, past)
      return past
    })
    .catch(() => null) // no history is not an error, the chart falls back to its own warm-up seed
    .finally(() => {
      pastInflight.delete(asset)
    })
  pastInflight.set(asset, req)
  return req
}

export const priceBus = { subscribe, cachedPast, fetchPast }
