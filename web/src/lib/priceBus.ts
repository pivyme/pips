// The client price bus. ONE shared, ref-counted WebSocket for the whole app, multiplexing every
// asset any chart wants (Lucky's up-to-3 charts share this single connection). `subscribe(asset, cb)`
// returns an unsub; callbacks get the same `PriceTick` shape the old SSE `streamPrices` delivered, so
// `Chart.tsx` swaps one for the other with no other change.
//
// Resilience: auto-reconnect with backoff, resubscribe the live asset set on every (re)open, and a
// hard fallback to the SSE `/stream/prices` path (same data, per-connection) if the WS can't establish
// or the flag is off. Demo mode keeps its in-memory twin (no backend). The whole thing is display-only
// (L-015): nothing truthful reads this feed.

import { env } from '@/env'
import { getAuthToken, streamPrices, type PriceTick } from './api'
import { demoStreamPrices, isDemo } from './demo'

type Cb = (t: PriceTick) => void

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

// Give up on the WS for this session and route every asset through the SSE fallback. Sticky: a page
// reload retries the WS. This is what makes the transport strictly no-worse-than-today.
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

export const priceBus = { subscribe }
