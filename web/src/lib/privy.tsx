// Privy auth for privy mode: Google/email login only. The embedded Sui wallet is provisioned and
// owned server-side (the app authorization key), so the client never creates a wallet or grants a
// session signer. It signs in, hands the Privy access token to /auth/privy/verify, and the backend
// provisions the wallet, signs plays via rawSign, and returns our JWT. Privy's hooks must live inside
// PrivyProvider, so this file owns the provider and a headless bridge that feeds the result into the
// auth context (lib/auth.tsx) through AuthControlContext. dev + demo modes never mount any of this.

import { useCallback, useEffect, useRef } from 'react'
import { PrivyProvider, useLogin, usePrivy } from '@privy-io/react-auth'

import { env } from '@/env'
import { api, setAuthToken } from '@/lib/api'
import { isDemo } from '@/lib/demo'
import { clearStoredSession, isSessionRejected, loadToken, toAuthError, useAuthControl } from '@/lib/auth'

// Privy is active only in privy mode with an app id configured, and never in demo mode.
export const PRIVY_ENABLED = env.VITE_AUTH_MODE === 'privy' && Boolean(env.VITE_PRIVY_APP_ID) && !isDemo()

function PrivyBridge() {
  const { ready, authenticated, user, logout, getAccessToken } = usePrivy()
  const control = useAuthControl()
  const inFlight = useRef(false)
  const authedFor = useRef<string | null>(null)

  // The door's CTA awaits signIn(), but Privy's login() returns void and never settles on its own, so
  // a dismissed modal would leave the door spinning "Starting..." forever. We bridge that: signIn()
  // returns a promise we settle from Privy's login events. Backing out fires onError('exited_auth_flow'),
  // which rejects as a cancel (the door drops the spinner, no error toast); other errors reject as real
  // failures; onComplete resolves it (the verify effect below then mints our session).
  const pendingLogin = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null)
  const settleLogin = useCallback((err?: Error) => {
    const p = pendingLogin.current
    if (!p) return
    pendingLogin.current = null
    if (err) p.reject(err)
    else p.resolve()
  }, [])

  const { login } = useLogin({
    onComplete: () => settleLogin(),
    onError: (error) =>
      settleLogin(new Error(error === 'exited_auth_flow' ? 'login_cancelled' : String(error))),
  })

  // Expose Privy's login/logout so the auth context's signIn/signOut can drive them.
  useEffect(() => {
    control.registerPrivy({
      signIn: () =>
        new Promise<void>((resolve, reject) => {
          settleLogin(new Error('login_cancelled')) // drop any stale attempt before starting a fresh one
          pendingLogin.current = { resolve, reject }
          login()
        }),
      signOut: async () => {
        settleLogin(new Error('login_cancelled'))
        await logout()
      },
    })
    return () => control.registerPrivy(null)
  }, [control, login, logout, settleLogin])

  // Resolve our session from the live Privy session.
  useEffect(() => {
    if (!ready) return
    if (!authenticated) {
      authedFor.current = null
      inFlight.current = false
      // Privy is unauthenticated, but the app may still be signed in by another path (a wallet-connect
      // session, or a restored token mid-validation). Only fall back to the door when there is no app
      // session at all, otherwise this would clobber the wallet login and bounce it back to landing.
      if (!loadToken()) control.setStatus('anon')
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
          } catch (e) {
            if (isSessionRejected(e)) clearStoredSession()
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
        authedFor.current = null
        clearStoredSession()
        console.error('[privy] sign-in failed', e)
        control.setStatus('error', toAuthError(e))
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
    <PrivyProvider
      appId={env.VITE_PRIVY_APP_ID as string}
      config={{
        loginMethods: ['google', 'email'],
        // Match the app: dark modal with the PIPS amber accent, not Privy's default light theme.
        appearance: { theme: 'dark', accentColor: '#ffc016' },
      }}
    >
      <PrivyBridge />
      {children}
    </PrivyProvider>
  )
}
