import toast from 'react-hot-toast'
import { ApiError } from './api'

// Map backend error codes to the verbatim friendly copy (07-DESIGN-SYSTEM.md). The games never
// surface a raw Move abort or a code; they show one of these lines.
const FRIENDLY: Record<string, string> = {
  MARKET_UNAVAILABLE: 'No live market right now. Try again in a sec.',
  MARKETS_FAILED: 'No live market right now. Try again in a sec.',
  INSUFFICIENT_DUSDC: 'Not enough chips for that play.',
  SPONSOR_FAILED: "That play didn't go through. Your play is safe.",
  MINT_FAILED: "That play didn't go through. Your play is safe.",
  PLAY_FAILED: "That play didn't go through. Your play is safe.",
  REDEEM_FAILED: "Cash out didn't go through. Try again.",
  CASHOUT_FAILED: "Cash out didn't go through. Try again.",
  ORACLE_STALE: 'Price feed is catching up. One moment.',
  PLAYS_PAUSED: 'Plays paused while we top up. Back in a moment.',
  RATE_LIMITED: 'One play at a time. Hang on a sec.',
}

export function friendlyError(e: unknown): string {
  if (e instanceof ApiError && FRIENDLY[e.code]) return FRIENDLY[e.code]
  return 'Something hiccuped. Try again.'
}

// Expected, benign outcomes the player should never see a toast for: PLAY_NOT_OPEN is the cash-out buzzer
// race (round already crossed expiry, settles on its own), MANAGER_NOT_READY heals in place via recoverSession.
const SILENT = new Set(['PLAY_NOT_OPEN', 'MANAGER_NOT_READY'])

export function toastError(e: unknown): void {
  if (e instanceof ApiError && SILENT.has(e.code)) return
  // Key the toast by error code (or the message for unknowns) so the same error replaces its own
  // toast instead of stacking. A retry loop hitting one failure shows one toast, not a wall of them.
  const id = e instanceof ApiError && e.code ? `err-${e.code}` : 'err-generic'
  toast.error(friendlyError(e), { id })
}
