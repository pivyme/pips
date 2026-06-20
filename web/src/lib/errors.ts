import toast from 'react-hot-toast'
import { ApiError } from './api'

// Map backend error codes to the verbatim friendly copy (07-DESIGN-SYSTEM.md). The games never
// surface a raw Move abort or a code; they show one of these lines.
const FRIENDLY: Record<string, string> = {
  MARKET_UNAVAILABLE: 'No live market right now. Try again in a sec.',
  MARKETS_FAILED: 'No live market right now. Try again in a sec.',
  INSUFFICIENT_DUSDC: 'Not enough chips for that bet.',
  SPONSOR_FAILED: "That play didn't go through. Your bet is safe.",
  MINT_FAILED: "That play didn't go through. Your bet is safe.",
  PLAY_FAILED: "That play didn't go through. Your bet is safe.",
  REDEEM_FAILED: "Cash out didn't go through. Try again.",
  CASHOUT_FAILED: "Cash out didn't go through. Try again.",
  ORACLE_STALE: 'Price feed is catching up. One moment.',
}

export function friendlyError(e: unknown): string {
  if (e instanceof ApiError && FRIENDLY[e.code]) return FRIENDLY[e.code]
  return 'Something hiccuped. Try again.'
}

export function toastError(e: unknown): void {
  // Key the toast by error code (or the message for unknowns) so the same error replaces its own
  // toast instead of stacking. A retry loop hitting one failure shows one toast, not a wall of them.
  const id = e instanceof ApiError && e.code ? `err-${e.code}` : 'err-generic'
  toast.error(friendlyError(e), { id })
}
