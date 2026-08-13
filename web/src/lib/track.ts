// track(): the entire client analytics surface. One import, one call, no thinking at the call site.
//
//   import { track } from '@/lib/track'
//   track('custom.skin_apply', { skin: 'aurum' })
//
// Every guarantee below is this file's job, never a call site's (§12):
//   - returns void, not a promise. Nothing to await, nothing to forget to await.
//   - never throws. The whole body sits in a try/catch.
//   - never blocks. It pushes to an array and returns.
//   - queue capped at 200, oldest dropped. Load-bearing: we already crashed an iOS tab at 514MB once, and
//     a runaway loop calling track() must not be the cause of the second time.
//   - no retries, no persistence. A failed flush drops those events, which is what keeps this file small.
//   - no-ops when disabled or the name is unknown (dev warns, prod stays silent).
//   - zero dependencies. The envelope is native crypto.subtle.
//
// EVENT_NAMES is a twin of backend/src/config/analytics-catalog.ts, which is the source of truth. A typo
// fails typecheck here and `bun run check:admin` fails the gate if the two arrays drift.

import { env } from '@/env'
import { getAuthToken } from '@/lib/api'
import { isDemo } from '@/lib/demo'

export const EVENT_NAMES = [
  'app.open',
  'app.pwa_launch',
  'app.install_prompt',

  'door.landing_view',
  'door.gate_pass',
  'door.gate_fail',
  'door.start_tap',
  'door.auth_start',
  'door.auth_ok',
  'door.auth_fail',
  'door.onboard_view',
  'door.onboard_username_set',
  'door.onboard_done',

  'hub.view',
  'hub.game_tile_tap',
  'hub.inplay_resume',

  'game.open',
  'game.knob_change',
  'game.stake_change',
  'game.play_tap',
  'game.play_open',
  'game.play_error',
  'game.cashout_tap',
  'game.cashout_done',
  'game.settled',
  'game.restore',

  'menu.open',
  'menu.section',
  'menu.setting_toggle',

  'money.deposit_open',
  'money.deposit_quote',
  'money.deposit_execute',
  'money.deposit_done',
  'money.deposit_fail',
  'money.withdraw_open',
  'money.withdraw_done',
  'money.withdraw_fail',
  'money.faucet_tap',
  'money.grant_received',

  'arcade.start',
  'arcade.end',

  'social.share_open',
  'social.share_card',
  'social.referral_open',
  'social.referral_claim',

  'custom.studio_open',
  'custom.skin_preview',
  'custom.skin_apply',

  'friction.chain_unavailable',
  'friction.sponsor_paused',
  'friction.session_heal',
  'friction.error_screen',

  // server-emitted, present so the twin matches the catalog. Never sent from here.
  'admin.role_change',
  'admin.setting_change',
] as const

export type EventName = (typeof EVENT_NAMES)[number]

const KNOWN: ReadonlySet<string> = new Set(EVENT_NAMES)

export type EventProps = Record<string, string | number | boolean | null | undefined>

const MAX_QUEUE = 200
const FLUSH_AT = 20
const FLUSH_MS = 5_000
const SESSION_IDLE_MS = 30 * 60 * 1000

interface Queued {
  /** Ready bytes when the seal resolved, plaintext JSON until then. Either way the flush is a concat. */
  bytes: Uint8Array | null
  json: string
}

const queue: Queued[] = []
let timer: ReturnType<typeof setTimeout> | null = null
let installed = false

// ---------------------------------------------------------------------------
// identity: an anon id that survives login, a session id that rotates when idle
// ---------------------------------------------------------------------------

let anonId = ''
let sessionId = ''

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null // private mode or a blocked storage partition
  }
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // in-memory only, which is fine: the ids just have to be stable for this page's lifetime
  }
}

function rid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

// Persisted, because the pre-auth funnel is only joinable to a user if the same anonId shows up on
// door.auth_ok after login. Not identity, just a join key.
export function getAnonId(): string {
  if (anonId) return anonId
  anonId = readStore('pips_anon') ?? rid('a')
  writeStore('pips_anon', anonId)
  return anonId
}

export function getSessionId(): string {
  const now = Date.now()
  const lastAt = Number(readStore('pips_sess_at') ?? 0)
  const stored = readStore('pips_sess')
  if (!sessionId && stored && now - lastAt < SESSION_IDLE_MS) sessionId = stored
  if (!sessionId) sessionId = rid('s')
  writeStore('pips_sess', sessionId)
  writeStore('pips_sess_at', String(now))
  return sessionId
}

// ---------------------------------------------------------------------------
// envelope (§4.4): a runtime-issued key, sealed per event at queue time
// ---------------------------------------------------------------------------

const ENVELOPE_VERSION = 1
const PLAINTEXT_VERSION = 0

let sidBytes: Uint8Array | null = null
let aesKey: CryptoKey | null = null
let handshake: Promise<void> | null = null
let sealBroken = false

function subtle(): SubtleCrypto | null {
  try {
    return typeof crypto !== 'undefined' && crypto.subtle ? crypto.subtle : null
  } catch {
    return null // insecure context
  }
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// One handshake per page. Failure is permanent for this session and harmless: we fall back to version-byte
// 0 plaintext on the same endpoint, which the server accepts.
function ensureSession(): Promise<void> {
  if (handshake) return handshake
  handshake = (async () => {
    const sub = subtle()
    if (!sub) {
      sealBroken = true
      return
    }
    try {
      const res = await fetch(`${env.VITE_API_URL}/a/hello`, { method: 'POST' })
      const body = (await res.json()) as { data?: { sid?: string; key?: string } }
      const sid = body.data?.sid
      const key = body.data?.key
      if (!sid || !key) throw new Error('no session')
      sidBytes = b64ToBytes(sid.replace(/-/g, '+').replace(/_/g, '/'))
      aesKey = await sub.importKey('raw', b64ToBytes(key) as unknown as ArrayBuffer, 'AES-GCM', false, ['encrypt'])
    } catch {
      sealBroken = true
    }
  })()
  return handshake
}

function plaintextRecord(json: string): Uint8Array {
  const body = new TextEncoder().encode(json)
  const out = new Uint8Array(1 + body.length)
  out[0] = PLAINTEXT_VERSION
  out.set(body, 1)
  return out
}

// Sealing runs in a microtask off the call path, so track() still returns immediately. By the time a flush
// happens the bytes are ready, which is what makes the visibilitychange flush a pure synchronous concat:
// crypto.subtle is async, and iOS can freeze a backgrounding page before an encrypt promise resolves.
async function sealInto(item: Queued): Promise<void> {
  try {
    await ensureSession()
    const sub = subtle()
    if (sealBroken || !sub || !sidBytes || !aesKey) {
      item.bytes = plaintextRecord(item.json)
      return
    }
    const nonce = new Uint8Array(12)
    crypto.getRandomValues(nonce)
    const ct = new Uint8Array(
      await sub.encrypt(
        { name: 'AES-GCM', iv: nonce as unknown as ArrayBuffer, additionalData: sidBytes as unknown as ArrayBuffer, tagLength: 128 },
        aesKey,
        new TextEncoder().encode(item.json),
      ),
    )
    const out = new Uint8Array(1 + sidBytes.length + nonce.length + ct.length)
    out[0] = ENVELOPE_VERSION
    out.set(sidBytes, 1)
    out.set(nonce, 1 + sidBytes.length)
    out.set(ct, 1 + sidBytes.length + nonce.length)
    item.bytes = out
  } catch {
    item.bytes = plaintextRecord(item.json)
  }
}

// [2B length][record] per event, so the server can split a batch it never sees the plaintext of.
function frame(records: Uint8Array[]): Uint8Array {
  const total = records.reduce((n, r) => n + 2 + r.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const r of records) {
    out[at] = (r.length >> 8) & 0xff
    out[at + 1] = r.length & 0xff
    out.set(r, at + 2)
    at += 2 + r.length
  }
  return out
}

// ---------------------------------------------------------------------------
// flush
// ---------------------------------------------------------------------------

/** Exported so the launch event can carry the PWA split, which the UA alone cannot tell us. */
export function isPwaLaunch(): boolean {
  return isStandalone()
}

function isStandalone(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
  } catch {
    return false
  }
}

function enabled(): boolean {
  // Demo mode has no backend to talk to, and a demo session is not a real user's behaviour anyway. Read it
  // through isDemo(), the same seam api.ts uses: the landing toggle writes localStorage, not the env, so an
  // env-only check leaves every toggled-in demo session posting fake events into the real table.
  return !isDemo()
}

export function flushTrack(useBeacon = false): void {
  try {
    if (!queue.length) return
    // Anything still sealing stays queued for the next flush rather than being dropped or sent twice.
    const ready: Queued[] = []
    for (const item of queue) {
      if (item.bytes) ready.push(item)
      if (ready.length >= FLUSH_AT) break
    }
    if (!ready.length) return
    for (const item of ready) queue.splice(queue.indexOf(item), 1)

    const body = frame(ready.map((r) => r.bytes as Uint8Array))
    const url = `${env.VITE_API_URL}/a/e`
    const token = getAuthToken()

    // sendBeacon survives a backgrounded iOS tab, but it cannot carry an Authorization header, so an authed
    // flush uses keepalive fetch and only the anonymous case beacons.
    if (useBeacon && !token && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([body as unknown as BlobPart], { type: 'application/octet-stream' }))
      return
    }

    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body as unknown as BodyInit,
      keepalive: true,
    }).catch(() => {})
  } catch {
    // A failed flush is a dropped batch, never an error the app sees.
  }
}

function scheduleFlush(): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    flushTrack()
  }, FLUSH_MS)
}

// ---------------------------------------------------------------------------
// track
// ---------------------------------------------------------------------------

export function track(name: EventName, props?: EventProps): void {
  try {
    if (!enabled()) return
    if (!KNOWN.has(name)) {
      if (import.meta.env.DEV) console.warn(`[track] unknown event "${String(name)}", add it to EVENT_NAMES`)
      return
    }

    const item: Queued = {
      bytes: null,
      json: JSON.stringify({
        name,
        props: cleanProps(props),
        sessionId: getSessionId(),
        anonId: getAnonId(),
        ts: Date.now(),
        // Metadata, not a prop: the UA cannot tell an iOS standalone PWA from iOS Safari, and this rides
        // along even on a sendBeacon flush, which cannot set a header.
        standalone: isStandalone() || undefined,
      }),
    }

    // Oldest-dropped, so a runaway loop costs a bounded 200 slots and the newest events survive.
    queue.push(item)
    while (queue.length > MAX_QUEUE) queue.shift()

    void sealInto(item).then(() => {
      if (queue.length >= FLUSH_AT) flushTrack()
    })
    scheduleFlush()
  } catch {
    // track() cannot throw. Ever.
  }
}

const ONCE_CAP = 50
const firedOnce = new Set<string>()

// For a screen that can remount in a loop. A crash boundary re-mounts every time the tree throws, so a
// plain per-mount effect turns one broken session into hundreds of rows and the Usage page then ranks the
// error screen above opening the app. Same shape as the client error hook's per-session dedupe.
export function trackOnce(name: EventName, props?: EventProps): void {
  try {
    const key = `${name}|${JSON.stringify(props ?? {})}`
    if (firedOnce.has(key)) return
    // Varied props must not turn the guard itself into the leak, so the set is bounded like the queue.
    if (firedOnce.size >= ONCE_CAP) return
    firedOnce.add(key)
    track(name, props)
  } catch {
    // same contract as track(): never throws
  }
}

const SETTLE_MS = 700
const settleTimers = new Map<string, ReturnType<typeof setTimeout>>()

// For a control a user scrubs: a knob or a stake slider fires dozens of changes for one intent, and the
// rule is that an event fires once per user action. This waits for the value to settle and then sends the
// final one, so a scrub is one row rather than forty.
export function trackSettled(name: EventName, props?: EventProps): void {
  try {
    const existing = settleTimers.get(name)
    if (existing) clearTimeout(existing)
    settleTimers.set(
      name,
      setTimeout(() => {
        settleTimers.delete(name)
        track(name, props)
      }, SETTLE_MS),
    )
  } catch {
    // same contract as track(): a scheduling failure is a lost event, never an app error
  }
}

// Depth 1, finite numbers, short strings: the same shape the server enforces, applied here so a bad call
// site is a dropped prop rather than a rejected batch.
function cleanProps(props?: EventProps): Record<string, string | number | boolean | null> | undefined {
  if (!props) return undefined
  const out: Record<string, string | number | boolean | null> = {}
  let kept = 0
  for (const [key, value] of Object.entries(props)) {
    if (kept >= 16 || value === undefined) continue
    if (!/^[a-z0-9_.]{1,40}$/.test(key)) continue
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue
      out[key] = value
    } else if (typeof value === 'boolean' || value === null) {
      out[key] = value
    } else if (typeof value === 'string') {
      out[key] = value.slice(0, 200)
    } else {
      continue // an object or array would be depth 2, which the server rejects outright
    }
    kept++
  }
  return Object.keys(out).length ? out : undefined
}

// Flush triggers: 5s timer (above), 20 queued (above), route change, and visibilitychange: hidden, which is
// the one that matters on mobile. `subscribe` is the router's, passed in so this file imports no router.
export function installTrack(subscribe?: (fn: () => void) => void): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushTrack(true)
  })
  window.addEventListener('pagehide', () => flushTrack(true))
  subscribe?.(() => flushTrack())
}

/** Test seam: drops the queue and the handshake so a case starts clean. */
export function resetTrackState(): void {
  for (const t of settleTimers.values()) clearTimeout(t)
  settleTimers.clear()
  firedOnce.clear()
  queue.length = 0
  if (timer) clearTimeout(timer)
  timer = null
  installed = false
  sidBytes = null
  aesKey = null
  handshake = null
  sealBroken = false
  anonId = ''
  sessionId = ''
}

/** Test seam: the queue depth, which is the thing rule 11 caps. */
export function queuedCount(): number {
  return queue.length
}

/** Test seam: the queued payloads, so a case can prove WHICH events a full queue dropped. */
export function queuedPayloads(): string[] {
  return queue.map((q) => q.json)
}

/** Test seam: how many queued events have finished sealing. Only a test waits on this; a flush never does. */
export function sealedCount(): number {
  return queue.filter((q) => q.bytes).length
}
