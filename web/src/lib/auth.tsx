// Auth context. One token, two modes. dev auto-logs-in the testing wallet on load; privy runs the
// Google/email login + non-custodial embedded Sui wallet handshake so our JWT-protected API works.
// The token lives in localStorage and is mirrored into the api client so every request carries it.
// The Privy hooks live inside PrivyProvider, so privy mode is driven by a bridge (lib/privy.tsx)
// that talks to this context through AuthControlContext. dev + demo never touch Privy.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import type { UserDTO } from '@/lib/api'
import { env } from '@/env'
import { ApiError, api, setAuthToken, setManagerNotReadyHandler } from '@/lib/api'
import { connectWallet, signLoginMessage, type SuiWallet } from '@/lib/walletConnect'
import { demoUser, isDemo } from '@/lib/demo'
import { setHapticsEnabled } from '@/lib/haptics'
import { setSoundEnabled } from '@/lib/sound'
import { readWalletBalances } from '@/lib/sui/predict'

const TOKEN_KEY = 'pips_token'
const WALLET_DEBUG_INTERVAL_MS = 30_000
export const loadToken = (): string | null => {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}
const saveToken = (token: string | null): void => {
  if (typeof window === 'undefined') return
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token)
    else window.localStorage.removeItem(TOKEN_KEY)
  } catch {
    // private mode / storage disabled: token just stays in memory for the session
  }
}

type AuthStatus = 'loading' | 'authed' | 'anon' | 'error'

// What blew up during sign-in, kept around so the door can show a real reason (and a contact link)
// instead of a generic toast. `details` is the backend's underlying cause (dev only).
export interface AuthError {
  code?: string
  message: string
  details?: string
}

// Normalize anything thrown during a sign-in into a displayable AuthError.
export function toAuthError(e: unknown): AuthError {
  if (e instanceof ApiError) return { code: e.code, message: e.message, details: e.details }
  if (e instanceof Error) return { message: e.message }
  return { message: 'Something went wrong' }
}

interface AuthContextValue {
  status: AuthStatus
  user: UserDTO | null
  // Set when status is 'error': the reason sign-in failed. Null otherwise.
  error: AuthError | null
  // True while re-provisioning a re-armed session in place (drives the recovery overlay).
  recovering: boolean
  signIn: () => Promise<void>
  // Native Sui wallet connect (custodial login): connect the wallet, sign the nonce, verify. The
  // wallet object comes from the door's picker. Throws on cancel/failure so the caller can react.
  signInWithWallet: (wallet: SuiWallet) => Promise<void>
  signOut: () => void
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

// Internal seam for the Privy bridge: apply a session, set status, and register Privy's own
// login/logout so signIn/signOut can drive them. Not part of the public auth surface.
interface AuthControl {
  apply: (token: string, user: UserDTO) => void
  // Second arg carries the failure reason when moving to 'error'; cleared on any other status.
  setStatus: (s: AuthStatus, error?: AuthError | null) => void
  registerPrivy: (c: { signIn: () => Promise<void>; signOut: () => Promise<void> } | null) => void
}
const AuthControlContext = createContext<AuthControl | null>(null)
export function useAuthControl(): AuthControl {
  const ctx = useContext(AuthControlContext)
  if (!ctx) throw new Error('useAuthControl must be used within AuthProvider')
  return ctx
}

const isPrivy = env.VITE_AUTH_MODE === 'privy'

// After a devnet refresh the backend re-arms every user: the on-chain PredictManager is nulled and
// chips/gas are re-issued on the next login. A live session then carries a stale null manager, so
// every play 409s MANAGER_NOT_READY. /auth/me reports managerReady; when it comes back false we
// self-heal in place (POST /auth/heal re-provisions server-side) behind a brief overlay, and only
// fall back to the door if the heal can't restore it. A healthy login is never managerLost, so
// onboarding and the normal first run never touch this path.
const managerLost = (u: UserDTO): boolean => !isDemo() && !u.managerReady

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<UserDTO | null>(null)
  const [error, setError] = useState<AuthError | null>(null)
  // True while self-healing a re-armed session (see recoverSession). Drives a thin "getting your
  // account ready" overlay so the heal is seamless, not a flash of broken plays.
  const [recovering, setRecovering] = useState(false)
  const started = useRef(false)
  const privyControl = useRef<{ signIn: () => Promise<void>; signOut: () => Promise<void> } | null>(null)
  // Single-flights the heal so a burst of MANAGER_NOT_READY 409s (a frustrated player tapping PLAY)
  // triggers one recovery, not many.
  const recoveringRef = useRef(false)

  // Single entry point for status + error so the two never drift: an error carries a reason and
  // clears on any healthy transition.
  const move = useCallback((s: AuthStatus, err?: AuthError | null) => {
    setError(s === 'error' ? err ?? { message: 'Could not sign you in. Please try again.' } : null)
    setStatus(s)
  }, [])

  const fail = useCallback((e: unknown) => move('error', toAuthError(e)), [move])

  const apply = useCallback((token: string, u: UserDTO) => {
    saveToken(token)
    setAuthToken(token)
    setUser(u)
    move('authed')
  }, [move])

  const devLogin = useCallback(async () => {
    const { token, user: u } = await api.authDev()
    apply(token, u)
  }, [apply])

  const signOut = useCallback(async () => {
    // Await Privy's logout so the session is fully cleared before the door shows again. Fire-and-forget
    // left Privy still authenticated, so the next login skipped the modal and the bridge silently
    // re-authed the same account. Then drop our app session.
    if (isPrivy && privyControl.current) {
      try {
        await privyControl.current.signOut()
      } catch (e) {
        console.error('[auth] privy logout failed', e)
      }
    }
    saveToken(null)
    setAuthToken(null)
    setUser(null)
    move('anon')
  }, [move])

  // Self-heal a re-armed session in place: ask the backend to re-provision (new PredictManager +
  // re-funded chips) and adopt the fresh user, all behind a brief overlay so the player never sees
  // the broken state. Single-flighted. Only if the heal can't restore the manager (chain still down,
  // signer gone) do we fall back to the door, where the next sign-in retries and shows the refreshing
  // sheet if needed.
  const recoverSession = useCallback(async () => {
    if (recoveringRef.current) return
    recoveringRef.current = true
    setRecovering(true)
    try {
      const { user: u } = await api.authHeal()
      if (managerLost(u)) {
        await signOut()
        return
      }
      setUser(u)
      move('authed')
    } catch {
      await signOut()
    } finally {
      recoveringRef.current = false
      setRecovering(false)
    }
  }, [move, signOut])

  const refresh = useCallback(async () => {
    try {
      const { user: u } = await api.me()
      if (managerLost(u)) {
        await recoverSession() // re-armed session: heal in place, no logout
        return
      }
      setUser(u)
      move('authed')
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        saveToken(null)
        setAuthToken(null)
        setUser(null)
        move('anon')
      }
    }
  }, [move, recoverSession])

  const signIn = useCallback(async () => {
    setError(null) // a fresh attempt clears the last failure so the error sheet drops
    if (isDemo()) {
      apply('demo-token', demoUser())
      return
    }
    if (env.VITE_AUTH_MODE === 'dev') {
      await devLogin()
      return
    }
    // privy: the bridge owns the Privy login modal + the verify handshake.
    if (privyControl.current) await privyControl.current.signIn()
  }, [apply, devLogin])

  // Wallet-connect: connect -> ask the backend for a nonce -> sign it with the wallet -> verify ->
  // apply the session. Demo never uses this (the door hides it). No bridge needed, the Wallet
  // Standard is plain async, so this lives directly in the context.
  const signInWithWallet = useCallback(async (wallet: SuiWallet) => {
    const account = await connectWallet(wallet)
    const { message } = await api.authWalletNonce(account.address)
    const signature = await signLoginMessage(wallet, account, message)
    const { token, user: u } = await api.authWalletVerify({ address: account.address, signature })
    apply(token, u)
  }, [apply])

  // The instant case: a play (or any call) that 409s MANAGER_NOT_READY means this session's manager
  // was re-armed away. Heal on the first one (recoverSession single-flights, so the burst of 409s
  // from a player tapping PLAY collapses to one recovery).
  useEffect(() => {
    if (isDemo()) return
    setManagerNotReadyHandler(() => void recoverSession())
    return () => setManagerNotReadyHandler(null)
  }, [recoverSession])

  // Keep haptics + sound in step with the user's settings, app-wide, from the moment they load.
  useEffect(() => {
    setHapticsEnabled(user?.settings.haptics ?? true)
  }, [user?.settings.haptics])

  useEffect(() => {
    setSoundEnabled(user?.settings.sound ?? true)
  }, [user?.settings.sound])

  const address = user?.address
  useEffect(() => {
    if (!address || isDemo()) return

    let active = true
    let reading = false

    const logWallet = async () => {
      if (reading) return
      reading = true
      try {
        const balances = await readWalletBalances(address)
        if (!active) return
        console.info(
          `[PIPS wallet]\nAddress: ${address}\nSUI: ${balances.sui}\nWallet DUSDC (manager excluded): ${balances.usdc ?? 'not configured'}\nUpdated: ${new Date().toISOString()}`,
        )
      } catch (error) {
        if (active) console.warn(`[PIPS wallet] Failed to read balances for ${address}`, error)
      } finally {
        reading = false
      }
    }

    void logWallet()
    const interval = window.setInterval(() => void logWallet(), WALLET_DEBUG_INTERVAL_MS)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [address])

  // Keep the globally displayed available balance current even when funds move outside the active
  // game screen (external deposits, another tab, or a background settlement). Each refresh reads
  // wallet DUSDC + PredictManager cash directly from chain.
  useEffect(() => {
    if (status !== 'authed' || isDemo()) return
    const onFocus = () => void refresh()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    const interval = window.setInterval(() => void refresh(), 30_000)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [status, refresh])

  useEffect(() => {
    if (started.current) return
    started.current = true

    // Demo mode: no network, no chain. Drop straight into an authed mock session.
    if (isDemo()) {
      apply('demo-token', demoUser())
      return
    }

    void (async () => {
      const token = loadToken()
      if (token) {
        setAuthToken(token)
        try {
          const { user: u } = await api.me()
          if (managerLost(u)) {
            await recoverSession() // re-armed since last visit: heal in place before showing the app
            return
          }
          setUser(u)
          move('authed')
          return
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 401)) {
            fail(e)
            return
          }
          saveToken(null)
          setAuthToken(null)
        }
      }

      if (env.VITE_AUTH_MODE === 'dev') {
        try {
          await devLogin()
        } catch (e) {
          fail(e)
        }
        return
      }

      // privy: the bridge resolves status from the live Privy session (anon, or run the verify
      // handshake once Privy is ready). Stay 'loading' until it does.
    })()
  }, [apply, devLogin, move, fail, recoverSession])

  // Stable so the Privy bridge's effects don't re-run every render (an unstable control made the
  // bridge re-assert 'anon' right after a wallet login set 'authed', bouncing the user to the door).
  const registerPrivy = useCallback((c: { signIn: () => Promise<void>; signOut: () => Promise<void> } | null) => {
    privyControl.current = c
  }, [])
  const control = useMemo<AuthControl>(() => ({ apply, setStatus: move, registerPrivy }), [apply, move, registerPrivy])

  return (
    <AuthContext.Provider value={{ status, user, error, recovering, signIn, signInWithWallet, signOut, refresh }}>
      <AuthControlContext.Provider value={control}>{children}</AuthControlContext.Provider>
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
