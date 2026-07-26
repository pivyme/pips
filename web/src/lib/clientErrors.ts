// Client error capture: a root ErrorBoundary plus window.onerror and unhandledrejection. Until this
// existed, a white screen on iOS was completely invisible to us.
//
// The load-bearing rule here is the per-session dedupe. A render loop can throw thousands of times a
// second, and this is the top flood vector in the whole system, so the same fingerprint is reported at
// most once per session and everything after that is counted locally and dropped.
//
// Nothing in this file may ever rethrow into the app.

import { env } from '@/env'
import { getAuthToken } from '@/lib/api'
import { isDemo } from '@/lib/demo'

const ENDPOINT = '/a/err'
const MAX_PER_SESSION = 20

const seen = new Set<string>()
let installed = false
let sessionId = ''

// Stable per tab, rotates on reload. Enough to answer "was this one user's session or everyone".
export function clientSessionId(): string {
  if (sessionId) return sessionId
  try {
    const existing = sessionStorage.getItem('pips_sid')
    if (existing) {
      sessionId = existing
      return sessionId
    }
  } catch {
    // private mode or a blocked storage partition: fall through to an in-memory id
  }
  sessionId = `s_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
  try {
    sessionStorage.setItem('pips_sid', sessionId)
  } catch {
    // in-memory only, which is fine: the id just has to be stable for this page's lifetime
  }
  return sessionId
}

// Client-side twin of the server's normalize(): enough to collapse a loop into one report. The server
// still computes the real fingerprint, this only decides what we bother sending.
export function clientFingerprint(message: string, stack?: string | null): string {
  const norm = (message || '')
    .toLowerCase()
    .replace(/0x[a-f0-9]{6,}/g, '<addr>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>')
    .replace(/\bc[a-z0-9]{20,30}\b/g, '<id>')
    .replace(/\b\d{3,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
  const frame = (stack ?? '')
    .split('\n')
    .slice(1)
    .find((l) => l.includes('http') && !l.includes('node_modules')) ?? ''
  return `${norm}|${frame.trim().slice(0, 120)}`
}

export interface ClientReport {
  message: string
  stack?: string | null
  kind: 'client'
  sessionId: string
  release: string
  url: string
  standalone: boolean
}

/** Test seam: clears the per-session dedupe so a case can observe the first report again. */
export function resetClientErrorState(): void {
  seen.clear()
  installed = false
}

/** Test seam: how many distinct fingerprints have been reported this session. */
export function reportedCount(): number {
  return seen.size
}

// Returns true when this error was actually sent. Never throws, never awaits on the caller's path.
export function reportClientError(error: unknown, extra?: Record<string, string>): boolean {
  try {
    if (isDemo()) return false // the demo sim has no backend to report to, and the toggle is localStorage, not env

    const err = error instanceof Error ? error : null
    const message = (err?.message ?? String(error ?? 'unknown error')).slice(0, 500)
    const stack = err?.stack ?? null
    const fp = clientFingerprint(message, stack)

    // The flood guard, and the reason client_errors.enabled exists as a kill switch behind it.
    if (seen.has(fp)) return false
    if (seen.size >= MAX_PER_SESSION) return false
    seen.add(fp)

    const report: ClientReport & Record<string, unknown> = {
      message,
      stack: stack ? stack.slice(0, 8192) : null,
      kind: 'client',
      sessionId: clientSessionId(),
      release: typeof __RELEASE__ === 'string' ? __RELEASE__ : 'dev',
      url: typeof location !== 'undefined' ? location.pathname : '',
      standalone: isStandalone(),
      ...extra,
    }

    const token = getAuthToken()
    void fetch(`${env.VITE_API_URL}${ENDPOINT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(report),
      keepalive: true,
    }).catch(() => {})

    return true
  } catch {
    // Capturing an error must never become the error.
    return false
  }
}

function isStandalone(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
  } catch {
    return false
  }
}

// Global hooks. Both handlers report and return, never preventDefault, so the browser console still gets
// the error and any other listener still runs.
export function installClientErrorHooks(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  window.addEventListener('error', (e: ErrorEvent) => {
    reportClientError(e.error ?? e.message, { source: 'onerror' })
  })

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    reportClientError(e.reason, { source: 'unhandledrejection' })
  })
}
