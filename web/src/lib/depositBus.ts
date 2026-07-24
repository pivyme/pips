// The deposit-landed event bus, dependency-free so the deposit watch (and any future app-wide watcher) can
// emit and the DepositLanded overlay can listen without an import cycle. Deduped per digest via localStorage,
// so a row re-returned by a checkpoint-boundary re-scan celebrates exactly once, ever.

import type { WalletTxDTO } from './api'

type Listener = (row: WalletTxDTO) => void
const listeners = new Set<Listener>()

const SEEN_KEY = 'pips_seen_deposit_digests'
const SEEN_CAP = 300
let seen: Set<string> | null = null

function loadSeen(): Set<string> {
  if (seen) return seen
  seen = new Set()
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    if (raw) for (const d of JSON.parse(raw) as string[]) seen.add(d)
  } catch {
    // storage blocked: dedup falls back to in-memory only, still one-celebration-per-session
  }
  return seen
}

function markSeen(key: string): void {
  const s = loadSeen()
  s.add(key)
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-SEEN_CAP)))
  } catch {
    // ignore
  }
}

// Emit a landed deposit for the celebration. Deduped by digest (or id as a fallback), so a re-scan never
// double-fires the popup.
export function emitDepositLanded(row: WalletTxDTO): void {
  const key = row.digest || row.id
  if (!key) return
  if (loadSeen().has(key)) return
  markSeen(key)
  for (const l of listeners) l(row)
}

export function subscribeDepositLanded(l: Listener): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
