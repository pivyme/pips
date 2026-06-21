// The landing "door", reimagined as an overlay over the live 3D console (not a separate page). The
// device floats behind as the hero; this layer is mostly click-through with the wordmark up top and
// the tagline + sign-in CTA along the bottom. Signing in flips the app phase, which settles the same
// device to center and fades the drifting background in. App-Surface language (docs/DESIGN.md).
import { useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import toast from 'react-hot-toast'
import { config } from '@/config'
import { env } from '@/env'
import { haptic } from '@/lib/haptics'
import { isDemo, setDemoOverride } from '@/lib/demo'
import { useAuth } from '@/lib/auth'
import { listSuiWallets, onWalletsChange, isUserRejection, type SuiWallet } from '@/lib/walletConnect'
import { useReducedMotion } from '@/hooks/useReducedMotion'

// `onEnter` walks the user off the door into the shell (onboarding or app). It fires once a session
// is ready: immediately for an already-authed session when the CTA is tapped (dev/demo auto-login, or
// a returning privy session), or after the privy modal resolves.
export function LandingOverlay({ onEnter }: { onEnter: () => void }) {
  const { status, signIn, signInWithWallet } = useAuth()
  const reduced = useReducedMotion()
  const [connecting, setConnecting] = useState(false)
  const demo = isDemo()
  const isPrivy = env.VITE_AUTH_MODE === 'privy'
  // Native Sui wallet connect, alongside whatever the primary CTA does. Hidden in demo.
  const walletEnabled = env.VITE_WALLET_CONNECT_ENABLED === 'true' && !demo
  const [wallets, setWallets] = useState<SuiWallet[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)

  // Track installed Sui wallets (extensions register asynchronously, often after first paint).
  // Client-only: getWallets touches window, and effects never run on the server.
  useEffect(() => {
    if (!walletEnabled) return
    setWallets(listSuiWallets())
    return onWalletsChange(() => setWallets(listSuiWallets()))
  }, [walletEnabled])

  // Flip demo mode and reload so the api client, streams, and auth all re-resolve cleanly.
  const toggleDemo = useCallback((on: boolean) => {
    haptic('selection')
    setDemoOverride(on)
    window.location.reload()
  }, [])

  // A session landed while we are on the door: a returning real privy session auto-walks in; dev and
  // demo always show the door and walk in only once the CTA was tapped (connecting). Demo never
  // auto-enters even under a privy env, so the door is always part of the demo showcase.
  useEffect(() => {
    if (status === 'authed' && (connecting || (isPrivy && !demo))) onEnter()
  }, [status, connecting, isPrivy, demo, onEnter])

  // A failed sign-in (e.g. the verify handshake errored) drops the spinner so the door stays usable.
  useEffect(() => {
    if (status === 'error') {
      setConnecting(false)
      toast.error('Could not sign you in. Try again.', { id: 'signin-error' })
    }
  }, [status])

  const onCta = useCallback(async () => {
    haptic('rigid')
    if (status === 'authed') {
      onEnter()
      return
    }
    setConnecting(true)
    try {
      // dev/demo resolve a session immediately (the effect walks us in); privy opens the modal and
      // settles once the user finishes or backs out.
      await signIn()
    } catch (e) {
      // Backing out of the sign-in modal is not an error, just drop the spinner. Anything else is a
      // real failure worth flagging.
      setConnecting(false)
      if (!(e instanceof Error && e.message === 'login_cancelled')) {
        toast.error('Could not sign you in. Try again.', { id: 'signin-error' })
      }
    }
  }, [status, signIn, onEnter])

  // Run the connect + sign + verify for one wallet. Reuses `connecting`, so the success effect above
  // walks the user in once the session lands. A dismissed wallet popup is silent; other failures toast.
  const signInWith = useCallback(
    async (wallet: SuiWallet) => {
      setPickerOpen(false)
      setConnecting(true)
      try {
        await signInWithWallet(wallet)
      } catch (e) {
        setConnecting(false)
        if (!isUserRejection(e))
          toast.error('Could not connect that wallet. Try again.', { id: 'wallet-connect-error' })
      }
    },
    [signInWithWallet],
  )

  // The "Connect Sui Wallet" CTA: no wallet -> hint, one -> straight in, several -> the picker.
  const onWalletCta = useCallback(() => {
    haptic('rigid')
    const found = listSuiWallets()
    setWallets(found)
    if (found.length === 0) {
      toast('No Sui wallet found. Install Slush, Sui Wallet, or Suiet.', {
        id: 'no-wallet',
        icon: '👛',
      })
      return
    }
    if (found.length === 1) {
      void signInWith(found[0])
      return
    }
    setPickerOpen(true)
  }, [signInWith])

  const busy = connecting || status === 'loading'
  const label = busy ? 'Starting...' : 'START'

  const ease = [0.16, 1, 0.3, 1] as const
  const rise = (delay: number) =>
    reduced
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.3, delay: delay * 0.5 } }
      : { initial: { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.6, ease, delay } }

  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center">
      {/* Scrim so the copy + CTA read cleanly over the floating device behind them. Only as tall as the
          text block needs: dark behind the headline, then feathering to clear just above it so the
          screen, PRESS START, and most of the device stay visible. */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[46%]"
        style={{
          background:
            'linear-gradient(to top, #000 0%, #000 40%, rgba(0,0,0,0.85) 65%, rgba(0,0,0,0) 100%)',
        }}
      />

      {/* Wordmark up top, small so the device stays the hero. */}
      <motion.img
        src="/assets/logos/pips-yellow-badge-3d.png"
        alt="PIPS"
        draggable={false}
        {...rise(0.05)}
        className="mt-[max(28px,calc(env(safe-area-inset-top)+16px))] h-12 w-auto select-none drop-shadow-[0_10px_30px_rgba(0,0,0,0.6)] sm:h-14"
      />

      {/* The middle is the device, click-through. */}
      <div className="flex-1" />

      {/* Tagline + CTA along the bottom. relative z-10 keeps it above the scrim. */}
      <motion.div
        {...rise(0.18)}
        className="relative z-10 w-full max-w-sm px-6 pb-[max(30px,calc(env(safe-area-inset-bottom)+22px))] text-center"
      >
        <h1 className="text-balance text-3xl font-extrabold leading-tight tracking-tight text-text">
          {config.tagline}
        </h1>
        <p className="mx-auto mt-2 max-w-xs text-[15px] text-text-2">
          Fun enough you forget it's trading.<br/> Real enough to matter.
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
          className="btn-primary pointer-events-auto mt-6 flex h-14 w-full items-center justify-center rounded-full text-lg disabled:opacity-70"
        >
          {label}
        </button>

        {walletEnabled && (
          <button
            type="button"
            onClick={onWalletCta}
            disabled={busy}
            className="pointer-events-auto mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-full border border-line-strong bg-surface/60 text-[15px] font-bold text-text transition-colors hover:bg-surface disabled:opacity-60"
          >
            <WalletGlyph className="h-4 w-4 text-text-2" />
            {connecting ? 'Connecting...' : 'Connect Sui Wallet'}
          </button>
        )}

        <button
          type="button"
          onClick={() => toggleDemo(!demo)}
          className="pointer-events-auto mt-3.5 text-sm font-semibold text-text-3 underline underline-offset-4 transition-colors hover:text-text-2"
        >
          {demo ? 'Connect for real instead' : 'Just exploring? Try demo mode'}
        </button>

        <p className="mt-5 text-[11px] font-medium text-text-3">Powered by DeepBook Predict</p>
      </motion.div>

      <WalletPicker
        open={pickerOpen}
        wallets={wallets}
        onPick={(w) => void signInWith(w)}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  )
}

// The wallet chooser, shown only when more than one Sui wallet is installed. A simple bottom sheet in
// the App-Surface language (the door is App-Surface, not the in-device instrument style).
function WalletPicker({
  open,
  wallets,
  onPick,
  onClose,
}: {
  open: boolean
  wallets: SuiWallet[]
  onPick: (w: SuiWallet) => void
  onClose: () => void
}) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="pointer-events-auto absolute inset-0 z-30 bg-black/70"
          />
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ duration: 0.34, ease: [0.16, 1, 0.3, 1] }}
            className="pointer-events-auto absolute inset-x-0 bottom-0 z-40 mx-auto w-full max-w-sm rounded-t-3xl border border-line-strong bg-surface p-5 pb-[max(24px,calc(env(safe-area-inset-bottom)+18px))]"
          >
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-line-strong" />
            <h2 className="mb-1 text-center text-lg font-extrabold tracking-tight text-text">Choose a wallet</h2>
            <p className="mb-4 text-center text-[13px] text-text-3">Sign in with your Sui wallet.</p>
            <div className="flex flex-col gap-2">
              {wallets.map((w) => (
                <button
                  key={w.name}
                  type="button"
                  onClick={() => onPick(w)}
                  className="flex items-center gap-3 rounded-2xl border border-line-strong bg-canvas px-4 py-3 text-left transition-colors hover:bg-surface-2"
                >
                  {w.icon ? (
                    <img src={w.icon} alt="" className="h-8 w-8 rounded-lg" />
                  ) : (
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-2">
                      <WalletGlyph className="h-4 w-4 text-text-2" />
                    </span>
                  )}
                  <span className="text-[15px] font-bold text-text">{w.name}</span>
                </button>
              ))}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

function WalletGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M3 7.5A2.5 2.5 0 0 1 5.5 5H17a2 2 0 0 1 2 2v.5M3 7.5V17a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-3.5M3 7.5h15.5a1.5 1.5 0 0 1 1.5 1.5v1.5H16a2 2 0 1 0 0 4h4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// The device screen while it floats on the landing: just a black backing. The "PRESS START" attract
// text is rendered as a real plane on the 3D screen (see ConsoleCanvas), so it tilts and floats with
// the handheld instead of detaching like a flat overlay would when the device angles in the hero pose.
export function AttractScreen() {
  return <div className="h-full w-full bg-black" />
}
