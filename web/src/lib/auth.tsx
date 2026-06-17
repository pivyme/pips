// Auth context. One token, two modes. dev auto-logs-in the testing wallet on load; enoki runs
// the Google (zkLogin) handshake and signs a nonce so our JWT-protected API works. The token
// lives in localStorage and is mirrored into the api client so every request carries it.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

import { env } from '@/env'
import { api, ApiError, setAuthToken, type UserDTO } from '@/lib/api'
import { setHapticsEnabled } from '@/lib/haptics'

const TOKEN_KEY = 'pips_token'
const loadToken = (): string | null => {
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

interface AuthContextValue {
  status: AuthStatus
  user: UserDTO | null
  signIn: () => Promise<void>
  signOut: () => void
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

// The exact bytes the backend reconstructs and verifies. Keep in lockstep with auth.ts.
const authMessage = (nonce: string): string => `Sign in to Pips\n\nNonce: ${nonce}`

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<UserDTO | null>(null)
  const started = useRef(false)

  const apply = useCallback((token: string, u: UserDTO) => {
    saveToken(token)
    setAuthToken(token)
    setUser(u)
    setStatus('authed')
  }, [])

  const devLogin = useCallback(async () => {
    const { token, user: u } = await api.authDev()
    apply(token, u)
  }, [apply])

  const enokiHandshake = useCallback(
    async (address: string) => {
      const { nonce } = await api.authNonce(address)
      const { enokiSignPersonalMessage } = await import('./sui/enoki')
      const signature = await enokiSignPersonalMessage(authMessage(nonce))
      const { token, user: u } = await api.authVerify(address, signature)
      apply(token, u)
    },
    [apply],
  )

  const refresh = useCallback(async () => {
    try {
      const { user: u } = await api.me()
      setUser(u)
      setStatus('authed')
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        saveToken(null)
        setAuthToken(null)
        setUser(null)
        setStatus('anon')
      }
    }
  }, [])

  const signIn = useCallback(async () => {
    if (env.VITE_AUTH_MODE === 'dev') {
      await devLogin()
      return
    }
    const { enokiSignIn } = await import('./sui/enoki')
    await enokiSignIn(env.VITE_APP_URL ?? window.location.origin)
  }, [devLogin])

  const signOut = useCallback(() => {
    saveToken(null)
    setAuthToken(null)
    setUser(null)
    setStatus('anon')
  }, [])

  // Keep haptics in step with the user's setting, app-wide, from the moment the user loads.
  useEffect(() => {
    setHapticsEnabled(user?.settings.haptics ?? true)
  }, [user?.settings.haptics])

  useEffect(() => {
    if (started.current) return
    started.current = true

    void (async () => {
      const token = loadToken()
      if (token) {
        setAuthToken(token)
        try {
          const { user: u } = await api.me()
          setUser(u)
          setStatus('authed')
          return
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 401)) {
            setStatus('error')
            return
          }
          saveToken(null)
          setAuthToken(null)
        }
      }

      if (env.VITE_AUTH_MODE === 'dev') {
        try {
          await devLogin()
        } catch {
          setStatus('error')
        }
        return
      }

      // enoki: complete a Google redirect if we are landing on the callback, else stay anon.
      if (typeof window !== 'undefined' && window.location.hash.includes('id_token')) {
        try {
          const { enokiHandleCallback } = await import('./sui/enoki')
          const address = await enokiHandleCallback()
          if (address) {
            await enokiHandshake(address)
            window.history.replaceState(null, '', window.location.pathname)
            return
          }
        } catch {
          setStatus('error')
          return
        }
      }
      setStatus('anon')
    })()
  }, [devLogin, enokiHandshake])

  return <AuthContext.Provider value={{ status, user, signIn, signOut, refresh }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
