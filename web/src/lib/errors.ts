import toast from 'react-hot-toast'
import { ApiError } from './api'

// Map backend error codes to friendly copy (07-DESIGN-SYSTEM.md, reworded in plain language). The games never
// surface a raw Move abort or a code; they show one of these lines. No jargon, and say what happened to the balance.
const FRIENDLY: Record<string, string> = {
  MARKET_UNAVAILABLE: 'No game running right now. Try again in a sec.',
  MARKETS_FAILED: 'No game running right now. Try again in a sec.',
  INSUFFICIENT_DUSDC: 'Not enough balance for that play.',
  SPONSOR_FAILED: "That play didn't go through. Your balance is safe.",
  MINT_FAILED: "That play didn't go through. Your balance is safe.",
  PLAY_FAILED: "That play didn't go through. Your balance is safe.",
  REDEEM_FAILED: "Cash out didn't go through. Try again.",
  CASHOUT_FAILED: "Cash out didn't go through. Try again.",
  ORACLE_STALE: 'The price feed is catching up. One moment.',
  PLAYS_PAUSED: 'Plays are paused while we top up. Back in a moment.',
  RATE_LIMITED: 'One play at a time. Hang on a sec.',
}

// The stable code, for analytics and error grouping. Never the message: our messages carry ids and amounts,
// so grouping on the text gives one row per occurrence instead of one per bug.
export function errorCode(e: unknown): string {
  if (e instanceof ApiError && e.code) return e.code
  return 'UNKNOWN'
}

export function friendlyError(e: unknown): string {
  if (e instanceof ApiError && FRIENDLY[e.code]) return FRIENDLY[e.code]
  return 'Something went wrong. Try again.'
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
