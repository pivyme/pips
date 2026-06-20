// The landing "door", reimagined as an overlay over the live 3D console (not a separate page). The
// device floats behind as the hero; this layer is mostly click-through with the wordmark up top and
// the tagline + sign-in CTA along the bottom. Signing in flips the app phase, which settles the same
// device to center and fades the drifting background in. App-Surface language (docs/DESIGN.md).
import { useCallback, useEffect, useState } from 'react'
import { motion } from 'motion/react'
import toast from 'react-hot-toast'
import { config } from '@/config'
import { env } from '@/env'
import { haptic } from '@/lib/haptics'
import { isDemo, setDemoOverride } from '@/lib/demo'
import { useAuth } from '@/lib/auth'
import { useReducedMotion } from '@/hooks/useReducedMotion'

export function LandingOverlay() {
  const { status, signIn } = useAuth()
  const reduced = useReducedMotion()
  const [connecting, setConnecting] = useState(false)
  const demo = isDemo()
  const isPrivy = env.VITE_AUTH_MODE === 'privy'

  // Flip demo mode and reload so the api client, streams, and auth all re-resolve cleanly.
  const toggleDemo = useCallback((on: boolean) => {
    haptic('selection')
    setDemoOverride(on)
    window.location.reload()
  }, [])

  // A failed sign-in (e.g. the verify handshake errored) drops the spinner so the door stays usable.
  useEffect(() => {
    if (status === 'error') {
      setConnecting(false)
      toast.error('Could not sign you in. Try again.')
    }
  }, [status])

  const onCta = useCallback(async () => {
    haptic('rigid')
    setConnecting(true)
    try {
      // dev/demo resolve a session immediately; privy opens the Google/email modal. Either way the
      // app phase advances on its own once the session lands, so there's nothing to navigate here.
      await signIn()
    } catch {
      setConnecting(false)
      toast.error('Could not sign you in. Try again.')
    }
  }, [signIn])

  const busy = connecting || status === 'loading'
  const label = busy ? 'Signing you in...' : demo ? 'Enter demo' : isPrivy ? 'Continue with Google' : 'Enter'

  const ease = [0.16, 1, 0.3, 1] as const
  const rise = (delay: number) =>
    reduced
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.3, delay: delay * 0.5 } }
      : { initial: { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.6, ease, delay } }

  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center">
      {/* Wordmark up top, small so the device stays the hero. */}
      <motion.img
        src="/assets/logos/pips-yellow-badge-3d.png"
        alt="Pips"
        draggable={false}
        {...rise(0.05)}
        className="mt-[max(28px,calc(env(safe-area-inset-top)+16px))] h-12 w-auto select-none drop-shadow-[0_10px_30px_rgba(0,0,0,0.6)] sm:h-14"
      />

      {/* The middle is the device, click-through. */}
      <div className="flex-1" />

      {/* Tagline + CTA along the bottom. */}
      <motion.div
        {...rise(0.18)}
        className="w-full max-w-sm px-6 pb-[max(30px,calc(env(safe-area-inset-bottom)+22px))] text-center"
      >
        <h1 className="text-balance text-3xl font-extrabold leading-tight tracking-tight text-text">
          {config.tagline}
        </h1>
        <p className="mx-auto mt-2 max-w-xs text-[15px] text-text-2">
          No charts to read. No jargon. Just plays.
        </p>

        {demo && (
          <span className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-brand-500/30 bg-brand-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.08em] text-brand-500">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
            Demo mode · play money
          </span>
        )}

        <button
          type="button"
          onClick={() => void onCta()}
          disabled={busy}
          className="btn-primary pointer-events-auto mt-6 flex h-14 w-full items-center justify-center rounded-full text-base disabled:opacity-70"
        >
          {label}
        </button>
        <button
          type="button"
          onClick={() => toggleDemo(!demo)}
          className="pointer-events-auto mt-3.5 text-sm font-semibold text-text-3 underline underline-offset-4 transition-colors hover:text-text-2"
        >
          {demo ? 'Connect for real instead' : 'Just exploring? Try demo mode'}
        </button>

        <p className="mt-5 text-[11px] font-medium text-text-3">Built on Sui · DeepBook Predict</p>
      </motion.div>
    </div>
  )
}

// What the device screen shows while it floats on the landing: a quiet, powered-on attract loop in
// the in-screen instrument language (docs/SCREEN.md), so the handheld reads alive behind the door.
export function AttractScreen() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-black text-center">
      <span className="font-mono text-[10px] font-bold uppercase tracking-[0.32em] text-text-3">
        Pips Console
      </span>
      <div className="text-2xl font-black tracking-tight text-brand-500">PLAY TO TRADE</div>
      <span className="attract-blink font-mono text-[10px] font-bold uppercase tracking-[0.28em] text-text-2">
        Press start
      </span>
    </div>
  )
}
