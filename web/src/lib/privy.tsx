// Privy auth for privy mode: Google/email login, embedded Sui wallet provisioned + owned server-side (client never creates a wallet or grants a session signer).
// Privy's hooks must live inside PrivyProvider, so this file owns the provider and a headless bridge feeding the auth context (lib/auth.tsx) via AuthControlContext.

import { useCallback, useEffect, useRef } from 'react'
import { PrivyProvider, useLogin, usePrivy } from '@privy-io/react-auth'
import { toSolanaWalletConnectors } from '@privy-io/react-auth/solana'

import { env } from '@/env'
import { api, setAuthToken } from '@/lib/api'
import { isDemo } from '@/lib/demo'
import { readRef } from '@/lib/referral'
import { clearStoredSession, isSessionRejected, loadToken, toAuthError, useAuthControl } from '@/lib/auth'

// Privy is active only in privy mode with an app id configured, and never in demo mode.
export const PRIVY_ENABLED = env.VITE_AUTH_MODE === 'privy' && Boolean(env.VITE_PRIVY_APP_ID) && !isDemo()

// Cross-chain deposit signing needs MetaMask/Phantom connected alongside the embedded Sui wallet. Sui is a
// Privy extended-chain (embedded/server) and EVM/Solana are first-class connector chains, disjoint
// subsystems, so this is purely additive and does not touch the Google + Sui login. Off unless the mainnet
// deploy flips VITE_BRIDGE_EXECUTE, and still needs the connectors toggled on in the Privy dashboard.
export const BRIDGE_CONNECTORS_ENABLED = env.VITE_BRIDGE_EXECUTE === 'true'

function PrivyBridge() {
  const { ready, authenticated, user, logout, getAccessToken } = usePrivy()
  const control = useAuthControl()
  const inFlight = useRef(false)
  const authedFor = useRef<string | null>(null)

// The door's CTA awaits signIn(), but Privy's login() returns void and never settles on its own (a dismissed modal would spin "Starting..." forever).
  // We settle our own promise from Privy's login events: exited_auth_flow rejects as a cancel, other errors reject for real, onComplete resolves it.
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
      // The app may still be signed in by another path (wallet-connect, a restored token); only fall
      // back to the door with no app session at all, else this clobbers a live login back to landing.
      if (!loadToken()) control.setStatus('anon')
      return
    }
    // Resolve our app session once per Privy session: authedFor pins it to the Privy user so we never loop, but a fresh login/switch re-runs it.
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

        // Backend provisions + owns the embedded Sui wallet keyed to this Privy user; client sends only
        // the access token (+ email for display), no client wallet, no session signer.
        const { token: appToken, user: u } = await api.authPrivyVerify({
          token,
          email: user?.email?.address,
          referralCode: readRef() ?? undefined,
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
        loginMethods: ['google', 'email', 'twitter'],
        // Match the app: PIPS near-black base (Privy derives the grey stack from its luminance) + amber accent, not Privy's default bluish dark.
        appearance: {
          theme: '#0d0d0d',
          accentColor: '#ffc016',
          ...(BRIDGE_CONNECTORS_ENABLED && { walletChainType: 'ethereum-and-solana' as const }),
        },
        // Enable Solana connectors only when bridge signing is on; EVM connectors need no extra config.
        ...(BRIDGE_CONNECTORS_ENABLED && {
          externalWallets: { solana: { connectors: toSolanaWalletConnectors() } },
        }),
      }}
    >
      <PrivyBridge />
      {children}
    </PrivyProvider>
  )
}
