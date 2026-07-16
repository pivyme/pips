// Auth context. One token, two modes: dev auto-logs-in the testing wallet; privy runs the Google/email
// + embedded Sui wallet handshake through a bridge (lib/privy.tsx, AuthControlContext), since Privy's hooks must live inside PrivyProvider.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import type { UserDTO } from '@/lib/api'
import { env } from '@/env'
import { ApiError, api, setAuthToken, setManagerNotReadyHandler } from '@/lib/api'
import { connectWallet, signLoginMessage, type SuiWallet } from '@/lib/walletConnect'
import { demoUser, isDemo } from '@/lib/demo'
import { setHapticsEnabled } from '@/lib/haptics'
import { setSoundEnabled } from '@/lib/sound'
import { readWalletBalances } from '@/lib/sui/predict'
import { clearRef, readRef } from '@/lib/referral'

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
export const clearStoredSession = (): void => {
  saveToken(null)
  setAuthToken(null)
}

export const isSessionRejected = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 401

type AuthStatus = 'loading' | 'authed' | 'anon' | 'error'

// What blew up during sign-in, so the door can show a real reason instead of a generic toast. `details` is the backend's cause (dev only).
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
  // Native Sui wallet connect (custodial login): connect, sign the nonce, verify; throws on cancel/failure.
  signInWithWallet: (wallet: SuiWallet) => Promise<void>
  signOut: () => void
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

// Internal seam for the Privy bridge: apply a session, set status, and register Privy's login/logout. Not part of the public auth surface.
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

// After a devnet refresh every user re-arms (PredictManager nulled), so a live session 409s MANAGER_NOT_READY
// until POST /auth/heal re-provisions it in place; never sign out for this, just stay signed in and retry later.
const managerLost = (u: UserDTO): boolean => !isDemo() && !u.managerReady
// Backoff after a failed heal, so a player hammering PLAY doesn't reopen the overlay on every tap.
const HEAL_BACKOFF_MS = 15_000

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<UserDTO | null>(null)
  const [error, setError] = useState<AuthError | null>(null)
  // True while self-healing a re-armed session (recoverSession); drives the "getting your account ready" overlay.
  const [recovering, setRecovering] = useState(false)
  const started = useRef(false)
  const privyControl = useRef<{ signIn: () => Promise<void>; signOut: () => Promise<void> } | null>(null)
  // Single-flights the heal so a burst of MANAGER_NOT_READY 409s triggers one recovery, not many.
  const recoveringRef = useRef(false)
  // Epoch ms until which we skip heal attempts after one that couldn't restore the manager.
  const healBackoffUntil = useRef(0)

  // Single entry point for status + error so the two never drift: error clears on any healthy transition.
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
    // The backend only attributes a stashed referral on account creation, so clearing it unconditionally
    // is safe: real attribution already landed, a no-op resolve just leaves a stale code around.
    clearRef()
  }, [move])

  const devLogin = useCallback(async () => {
    const { token, user: u } = await api.authDev()
    apply(token, u)
  }, [apply])

  const signOut = useCallback(async () => {
    // Await Privy's logout fully before dropping our session: fire-and-forget left Privy still
    // authenticated, so the next login skipped the modal and silently re-authed the same account.
    if (isPrivy && privyControl.current) {
      try {
        await privyControl.current.signOut()
      } catch (e) {
        console.error('[auth] privy logout failed', e)
      }
    }
    clearStoredSession()
    setUser(null)
    move('anon')
  }, [move])

  // Self-heal a re-armed session: ask the backend to re-provision (new PredictManager + chips) behind a
  // brief overlay. Never changes status or signs out; if it can't heal yet, stay signed in and back off.
  const recoverSession = useCallback(async () => {
    if (recoveringRef.current || Date.now() < healBackoffUntil.current) return
    recoveringRef.current = true
    setRecovering(true)
    try {
      const { user: u } = await api.authHeal()
      setUser(u) // adopt the freshest user either way (new manager, or still-not-ready)
      healBackoffUntil.current = managerLost(u) ? Date.now() + HEAL_BACKOFF_MS : 0
    } catch {
      // network / route missing / server error: keep the session, retry after the backoff
      healBackoffUntil.current = Date.now() + HEAL_BACKOFF_MS
    } finally {
      recoveringRef.current = false
      setRecovering(false)
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const { user: u } = await api.me()
      setUser(u)
      move('authed')
      if (managerLost(u)) void recoverSession() // re-armed session: heal in the background, stay in
    } catch (e) {
      if (isSessionRejected(e)) {
        clearStoredSession()
        setUser(null)
        move('anon')
      }
    }
  }, [move, recoverSession])

  const signIn = useCallback(async () => {
    setError(null) // a fresh attempt clears the last failure so the error sheet drops
    // A failed Privy verify can leave the provider session alive while our app session never lands, so
    // the next "login" isn't a real restart. Tear it down on retry so START always means a fresh pass.
    if (isPrivy && status === 'error' && privyControl.current) {
      try {
        await privyControl.current.signOut()
      } catch (e) {
        console.error('[auth] privy reset before retry failed', e)
      }
    }
    // A new sign-in should never inherit a JWT from an older local backend/env.
    clearStoredSession()
    if (isDemo()) {
      apply('demo-token', demoUser())
      return
    }
    if (env.VITE_AUTH_MODE === 'dev') {
      await devLogin()
      return
    }
    // privy: the bridge owns the Privy login modal + the verify handshake.
    if (privyControl.current) {
      move('loading')
      await privyControl.current.signIn()
    }
  }, [apply, devLogin, move, status])

  // Wallet-connect: connect -> nonce -> sign -> verify -> apply session. Demo never uses this (door
  // hides it); no bridge needed, the Wallet Standard is plain async so it lives directly here.
  const signInWithWallet = useCallback(async (wallet: SuiWallet) => {
    const account = await connectWallet(wallet)
    const { message } = await api.authWalletNonce(account.address)
    const signature = await signLoginMessage(wallet, account, message)
    const { token, user: u } = await api.authWalletVerify({ address: account.address, signature, referralCode: readRef() ?? undefined })
    apply(token, u)
  }, [apply])

  // Any call 409ing MANAGER_NOT_READY means this session's manager was re-armed away; heal on the first
  // one (recoverSession single-flights, so a burst of 409s collapses to one recovery).
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

  // Keep the displayed balance current even when funds move outside the active game screen (external
  // deposits, another tab, background settlement); each refresh reads wallet + manager cash from chain.
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
          setUser(u)
          move('authed') // always show the app; never park a returning user on a loading veil
          if (managerLost(u)) void recoverSession() // re-armed since last visit: heal in the background
          return
        } catch (e) {
          if (!isSessionRejected(e)) {
            fail(e)
            return
          }
          clearStoredSession()
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

      // privy: the bridge resolves status from the live Privy session; stay 'loading' until it does.
    })()
  }, [apply, devLogin, move, fail, recoverSession])

  // Stable so the bridge's effects don't re-run every render (was bouncing a fresh wallet login back to the door).
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
