import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Illo } from '@/ui/Illo'
import { config } from '@/config'
import { env } from '@/env'
import { haptic } from '@/lib/haptics'
import { useAuth } from '@/lib/auth'

// Landing is the one full-width surface: hero + footer, one screen, no scroll. The door in.
// dev mode auto-signs-in behind the scenes (Enter just walks through); enoki mode kicks off
// the Google handshake. Either way, first entry drops a welcome toast and lands on Games.
export const Route = createFileRoute('/')({ component: Landing })

const WELCOME_KEY = 'pips_welcomed'
function welcomeOnce(): void {
  if (typeof window === 'undefined') return
  try {
    if (window.localStorage.getItem(WELCOME_KEY)) return
    window.localStorage.setItem(WELCOME_KEY, '1')
  } catch {
    return
  }
  toast.success('Welcome. $1,000 in play chips, on the house.')
}

function Landing() {
  const { status, signIn } = useAuth()
  const navigate = useNavigate()
  const [connecting, setConnecting] = useState(false)
  const isEnoki = env.VITE_AUTH_MODE === 'enoki'

  const enter = useCallback(() => {
    welcomeOnce()
    void navigate({ to: '/games' })
  }, [navigate])

  // A session landed while we are on the door: dev (auto, or right after Enter) or the enoki
  // redirect back from Google. Walk them in.
  useEffect(() => {
    if (status === 'authed' && (connecting || isEnoki)) enter()
  }, [status, connecting, isEnoki, enter])

  const onCta = useCallback(async () => {
    haptic('rigid')
    if (status === 'authed') {
      enter()
      return
    }
    setConnecting(true)
    try {
      // dev: resolves to an authed session (the effect walks us in).
      // enoki: redirects to Google and never returns here.
      await signIn()
    } catch {
      setConnecting(false)
      toast.error('Could not sign you in. Try again.')
    }
  }, [status, signIn, enter])

  const busy = connecting || status === 'loading'
  const label = busy ? 'Signing you in...' : isEnoki ? 'Continue with Google' : 'Enter'

  return (
    <div className="flex min-h-dvh flex-col bg-black">
      <main className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <Illo name="console" size={148} />
        <h1 className="mt-7 text-5xl font-extrabold tracking-tight sm:text-6xl">Pips</h1>
        <p className="mt-3 max-w-sm text-lg text-text-2">{config.tagline}</p>
        <p className="mt-1 max-w-xs text-sm text-text-3">No charts to read. No jargon. Just plays.</p>
        <button
          type="button"
          onClick={() => void onCta()}
          disabled={busy}
          className="btn-primary mt-9 flex h-14 w-full max-w-xs items-center justify-center rounded-full text-base disabled:opacity-70"
        >
          {label}
        </button>
      </main>
      <footer className="flex items-center justify-between px-6 py-5 text-xs text-text-3">
        <span>Built on Sui · DeepBook Predict</span>
        <a href={config.links.github} target="_blank" rel="noreferrer" className="transition-colors hover:text-text-2">
          GitHub
        </a>
      </footer>
    </div>
  )
}
