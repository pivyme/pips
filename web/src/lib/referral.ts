// Referral link capture + build. Stash/read/clear the pending token in localStorage (private-mode safe)
// and compose the shareable URL client-side. Capture stashes `@handle` or a bare code; resolveReferrer on the backend tells them apart by the leading `@`.
import { env } from '@/env'
import { SITE_URL } from '@/config'

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

// The origin every shareable link is built on. The browser's own origin wins on purpose: a build-time
// VITE_APP_URL is one stale deploy variable away from handing every user a localhost invite (it did).
// Env, then the canonical domain, only cover SSR, where there is no window to ask. A `www.` host is
// normalized off, the bare domain is the one we brand and it serves the same routes.
export function shareOrigin(): string {
  const raw =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : (env.VITE_APP_URL ?? SITE_URL)
  return raw.replace(/^(https?:\/\/)www\./, '$1')
}

// Same origin without the scheme, for the compact hints we print next to a link ("playpips.fun/@you").
export function shareHost(): string {
  return shareOrigin().replace(/^https?:\/\//, '')
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
  const base = shareOrigin()
  return !anon && username ? `${base}/@${username}` : `${base}/r/${code}`
}
