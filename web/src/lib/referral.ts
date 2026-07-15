// Referral link capture + build. One seam: stash/read/clear the pending token in localStorage
// (private-mode safe, matches lib/auth.tsx's token storage pattern), plus compose the shareable
// URL client-side. The capture routes stash `@handle` (username format) or a bare code (anon
// format); resolveReferrer on the backend tells the two apart by the leading `@`.
import { env } from '@/env'

const REF_KEY = 'pips_ref'

export function stashRef(token: string): void {
  if (typeof window === 'undefined' || !token) return
  try {
    window.localStorage.setItem(REF_KEY, token)
  } catch {
    // private mode / storage blocked: the referral is lost, sign-in still works
  }
}

export function readRef(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(REF_KEY)
  } catch {
    return null
  }
}

export function clearRef(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(REF_KEY)
  } catch {
    // ignore
  }
}

export function buildReferralLink({
  code,
  anon,
  username,
}: {
  code: string
  anon: boolean
  username: string | null
}): string {
  const base = env.VITE_APP_URL ?? window.location.origin
  return !anon && username ? `${base}/@${username}` : `${base}/r/${code}`
}
