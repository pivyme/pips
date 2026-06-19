// Privy auth for privy mode: a non-custodial embedded Sui wallet + Google/email login. Privy's
// hooks must live inside PrivyProvider, so this file owns the provider and a headless bridge that
// drives the login -> embedded Sui wallet -> session signer -> /auth/privy/verify handshake and
// feeds the result back into the auth context (lib/auth.tsx) through AuthControlContext. dev + demo
// modes never mount any of this, so they are entirely unaffected.

import { useCallback, useEffect, useRef } from 'react'
import { PrivyProvider, usePrivy, useSigners, type User as PrivyUser } from '@privy-io/react-auth'
import { useCreateWallet } from '@privy-io/react-auth/extended-chains'

import { env } from '@/env'
import { api, setAuthToken } from '@/lib/api'
import { isDemo } from '@/lib/demo'
import { loadToken, useAuthControl } from '@/lib/auth'

// Privy is active only in privy mode with an app id configured, and never in demo mode.
export const PRIVY_ENABLED = env.VITE_AUTH_MODE === 'privy' && Boolean(env.VITE_PRIVY_APP_ID) && !isDemo()

type SuiWallet = { address: string; publicKey: string; walletId: string }

// Pull an existing embedded Sui wallet out of the Privy user's linked accounts (re-login path).
// The linked-account union is wide, so read it permissively; the Phase 12 spike confirms the
// exact field names against a live wallet.
function findSuiWallet(user: PrivyUser | null): SuiWallet | null {
  const accounts = (user?.linkedAccounts ?? []) as unknown as Array<Record<string, unknown>>
  for (const a of accounts) {
    if (a.type === 'wallet' && a.chainType === 'sui' && typeof a.address === 'string') {
      const walletId = (a.id ?? a.walletId) as string | undefined
      return { address: a.address, publicKey: (a.publicKey as string) ?? '', walletId: walletId ?? '' }
    }
  }
  return null
}

function PrivyBridge() {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy()
  const { createWallet } = useCreateWallet()
  const { addSigners } = useSigners()
  const control = useAuthControl()
  const ran = useRef(false)

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

  // Ensure the embedded Sui wallet exists; reuse it on re-login, else create one.
  const ensureSuiWallet = useCallback(async (): Promise<SuiWallet> => {
    const existing = findSuiWallet(user)
    if (existing) return existing
    const { wallet } = await createWallet({ chainType: 'sui' })
    return { address: wallet.address, publicKey: wallet.public_key ?? '', walletId: wallet.id }
  }, [user, createWallet])

  // Delegate a session signer to the app's authorization key so the server can sign plays with no
  // per-spin popup. Needs the key-quorum id from the dashboard; without it, plays cannot sign yet.
  const grantSessionSigner = useCallback(
    async (address: string): Promise<void> => {
      const signerId = env.VITE_PRIVY_SESSION_SIGNER_ID
      if (!signerId) return
      await addSigners({ address, signers: [{ signerId, policyIds: [] }] })
    },
    [addSigners],
  )

  // Resolve our session from the live Privy session.
  useEffect(() => {
    if (!ready) return
    if (!authenticated) {
      ran.current = false
      control.setStatus('anon')
      return
    }
    if (ran.current) return
    ran.current = true

    void (async () => {
      try {
        // Reuse a still-valid app JWT before re-running the full handshake.
        const existing = loadToken()
        if (existing) {
          setAuthToken(existing)
          try {
            const { user: u } = await api.me()
            control.apply(existing, u)
            return
          } catch {
            // expired/invalid: mint a fresh one below
          }
        }

        const sui = await ensureSuiWallet()
        // Dev aid for the Phase 12 signing spike: copy these into SPIKE_PRIVY_* to run
        // backend/scripts/verify-privy.ts against this exact wallet.
        if (import.meta.env.DEV) {
          console.info('[privy] sui wallet', { walletId: sui.walletId, publicKey: sui.publicKey, address: sui.address })
        }
        await grantSessionSigner(sui.address)
        const token = await getAccessToken()
        if (!token) throw new Error('Privy access token unavailable')

        const { token: appToken, user: u } = await api.authPrivyVerify({
          token,
          address: sui.address,
          publicKey: sui.publicKey,
          walletId: sui.walletId,
          email: user?.email?.address,
        })
        control.apply(appToken, u)
      } catch (e) {
        console.error('[privy] sign-in failed', e)
        control.setStatus('error')
      }
    })()
  }, [ready, authenticated, control, ensureSuiWallet, grantSessionSigner, getAccessToken, user])

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
