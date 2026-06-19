// Privy auth for privy mode: Google/email login only. The embedded Sui wallet is provisioned and
// owned server-side (the app authorization key), so the client never creates a wallet or grants a
// session signer. It signs in, hands the Privy access token to /auth/privy/verify, and the backend
// provisions the wallet, signs plays via rawSign, and returns our JWT. Privy's hooks must live inside
// PrivyProvider, so this file owns the provider and a headless bridge that feeds the result into the
// auth context (lib/auth.tsx) through AuthControlContext. dev + demo modes never mount any of this.

import { useEffect, useRef } from 'react'
import { PrivyProvider, usePrivy } from '@privy-io/react-auth'

import { env } from '@/env'
import { api, setAuthToken } from '@/lib/api'
import { isDemo } from '@/lib/demo'
import { loadToken, useAuthControl } from '@/lib/auth'

// Privy is active only in privy mode with an app id configured, and never in demo mode.
export const PRIVY_ENABLED = env.VITE_AUTH_MODE === 'privy' && Boolean(env.VITE_PRIVY_APP_ID) && !isDemo()

function PrivyBridge() {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy()
  const control = useAuthControl()
  const inFlight = useRef(false)
  const authedFor = useRef<string | null>(null)

  // Expose Privy's login/logout so the auth context's signIn/signOut can drive them.
  useEffect(() => {
    control.registerPrivy({
      signIn: async () => {
        login()
      },
      signOut: async () => {
        await logout()
      },
    })
    return () => control.registerPrivy(null)
  }, [control, login, logout])

  // Resolve our session from the live Privy session.
  useEffect(() => {
    if (!ready) return
    if (!authenticated) {
      authedFor.current = null
      inFlight.current = false
      control.setStatus('anon')
      return
    }
    // Resolve our app session once per Privy session. authedFor pins it to the Privy user so we never
    // loop, but a fresh login (or account switch) re-runs it, and a failed attempt can retry.
    if (inFlight.current || authedFor.current === (user?.id ?? '')) return
    inFlight.current = true

    void (async () => {
      try {
        // Reuse a still-valid app JWT before re-running the verify handshake.
        const existing = loadToken()
        if (existing) {
          setAuthToken(existing)
          try {
            const { user: u } = await api.me()
            authedFor.current = user?.id ?? ''
            control.apply(existing, u)
            return
          } catch {
            // expired/invalid: mint a fresh one below
          }
        }

        const token = await getAccessToken()
        if (!token) throw new Error('Privy access token unavailable')

        // The backend provisions + owns the embedded Sui wallet keyed to this Privy user, so the
        // client sends only the access token (+ email for display). No client wallet, no session signer.
        const { token: appToken, user: u } = await api.authPrivyVerify({
          token,
          email: user?.email?.address,
        })
        authedFor.current = user?.id ?? ''
        control.apply(appToken, u)
      } catch (e) {
        console.error('[privy] sign-in failed', e)
        control.setStatus('error')
      } finally {
        inFlight.current = false
      }
    })()
  }, [ready, authenticated, control, getAccessToken, user])

  return null
}

// Wrap the app in PrivyProvider + the bridge when privy mode is on; otherwise a clean passthrough.
export function AppPrivyProvider({ children }: { children: React.ReactNode }) {
  if (!PRIVY_ENABLED) return <>{children}</>
  return (
    <PrivyProvider appId={env.VITE_PRIVY_APP_ID as string} config={{ loginMethods: ['google', 'email'] }}>
      <PrivyBridge />
      {children}
    </PrivyProvider>
  )
}
