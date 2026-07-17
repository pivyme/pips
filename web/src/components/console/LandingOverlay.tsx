// The landing "door": an overlay over the live 3D console (not a separate page), mostly click-through
// with wordmark up top and tagline/CTA at bottom. Signing in flips the app phase, docs/DESIGN.md.
import { useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { config } from '@/config'
import { env } from '@/env'
import { haptic } from '@/lib/haptics'
import { HapticOverlay } from '@/components/HapticOverlay'
import { SocialFooter } from '@/components/SocialFooter'
import { isDemo, setDemoOverride } from '@/lib/demo'
import { accessGuardEnabled, isUnlocked, tryUnlock } from '@/lib/accessGuard'
import { api } from '@/lib/api'
import { readRef } from '@/lib/referral'
import { cnm } from '@/utils/style'
import { useAuth, toAuthError, type AuthError } from '@/lib/auth'
import { listSuiWallets, onWalletsChange, isUserRejection, type SuiWallet } from '@/lib/walletConnect'
import { probeChainWiped } from '@/lib/sui/predict'
import { useReducedMotion } from '@/hooks/useReducedMotion'

// `onEnter` walks the user off the door into the shell. Fires immediately for an already-authed
// session on CTA tap (dev/demo, returning privy), or after the privy modal resolves.
export function LandingOverlay({ onEnter }: { onEnter: () => void }) {
  const { status, error: authError, signIn, signInWithWallet } = useAuth()
  const reduced = useReducedMotion()
  const [connecting, setConnecting] = useState(false)
  const demo = isDemo()
  const isPrivy = env.VITE_AUTH_MODE === 'privy'
  // Native Sui wallet connect, alongside whatever the primary CTA does. Hidden in demo.
  const walletEnabled = env.VITE_WALLET_CONNECT_ENABLED === 'true' && !demo
  const [wallets, setWallets] = useState<SuiWallet[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  // The sign-in failure currently on screen, fed by the privy bridge (status='error') and the direct
  // throw paths below. Null hides the sheet.
  const [signInError, setSignInError] = useState<AuthError | null>(null)
  // Private test deploy access-code sheet (VITE_ACCESS_GUARD), shown when START is tapped before this device has entered the code.
  const [codeOpen, setCodeOpen] = useState(false)

  // A referral link stashed a code before landing here (lib/referral.ts, /@{$handle} and /r/$code routes).
  // Fire-and-forget: a failed or unknown token renders nothing and never blocks sign-in; skipped in demo.
  const [inviteText, setInviteText] = useState<string | null>(null)
  useEffect(() => {
    if (demo) return
    const token = readRef()
    if (!token) return
    let active = true
    api
      .resolveReferral(token)
      .then((r) => {
        if (active && r.valid) setInviteText(r.handle ? `@${r.handle} invited you` : 'You were invited')
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [demo])

  // Track installed Sui wallets (extensions register async, after first paint). Client-only: effects
  // never run on the server and getWallets touches window.
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

  // A returning privy session auto-walks in; dev/demo always show the door and only enter once the CTA
  // is tapped, so demo stays part of the showcase. The access gate holds even an authed session until unlocked.
  useEffect(() => {
    if (accessGuardEnabled() && !isUnlocked()) return
    if (status === 'authed' && (connecting || (isPrivy && !demo))) onEnter()
  }, [status, connecting, isPrivy, demo, onEnter])

  // Probes whether the chain deployment is gone (a backend re-deploy or migration) and upgrades to
  // CHAIN_UNAVAILABLE client-side too, since the backend may lag; spinner stays up through the probe so the right copy paints first.
  const surfaceError = useCallback(async (err: AuthError) => {
    const wiped = err.code === 'CHAIN_UNAVAILABLE' || (await probeChainWiped())
    setConnecting(false)
    setSignInError(wiped ? { ...err, code: 'CHAIN_UNAVAILABLE' } : err)
    haptic('error')
  }, [])

  // A failed sign-in raises the error sheet with the real reason, so the door stays usable and a reviewer can see what broke.
  useEffect(() => {
    if (status === 'error') void surfaceError(authError ?? { message: 'Could not sign you in. Please try again.' })
  }, [status, authError, surfaceError])

  // The real entry: walk an already-authed session in, else kick off sign-in.
  const proceed = useCallback(async () => {
    if (status === 'authed') {
      onEnter()
      return
    }
    setSignInError(null) // a fresh attempt drops the last failure sheet
    setConnecting(true)
    try {
      // dev/demo resolve a session immediately (the effect walks us in); privy opens the modal and
      // settles once the user finishes or backs out.
      await signIn()
    } catch (e) {
      // Backing out of the modal isn't an error (just drop the spinner); any other failure is real and surfaces via surfaceError.
      if (e instanceof Error && e.message === 'login_cancelled') {
        setConnecting(false)
        return
      }
      await surfaceError(toAuthError(e))
    }
  }, [status, signIn, onEnter, surfaceError])

  const onCta = useCallback(() => {
    haptic('rigid')
    // Private test deploy: hold at the door until this device enters the access code.
    if (accessGuardEnabled() && !isUnlocked()) {
      setCodeOpen(true)
      return
    }
    void proceed()
  }, [proceed])

  // Code accepted: drop the sheet and continue into the app (sign-in or straight in).
  const onUnlocked = useCallback(() => {
    setCodeOpen(false)
    haptic('rigid')
    void proceed()
  }, [proceed])

  // Run the connect + sign + verify for one wallet. Reuses `connecting`, so the success effect above
  // walks the user in once the session lands. A dismissed wallet popup is silent; other failures toast.
  const signInWith = useCallback(
    async (wallet: SuiWallet) => {
      setPickerOpen(false)
      setSignInError(null)
      setConnecting(true)
      try {
        await signInWithWallet(wallet)
      } catch (e) {
        if (isUserRejection(e)) {
          setConnecting(false)
          return
        }
        await surfaceError(toAuthError(e))
      }
    },
    [signInWithWallet, surfaceError],
  )

  // The "Connect Sui Wallet" CTA: no wallet -> hint, one -> straight in, several -> the picker.
  // Hidden for now alongside the button below. Uncomment both to bring native wallet connect back.
  // const onWalletCta = useCallback(() => {
  //   haptic('rigid')
  //   const found = listSuiWallets()
  //   setWallets(found)
  //   if (found.length === 0) {
  //     toast('No Sui wallet found. Install Slush, Sui Wallet, or Suiet.', {
  //       id: 'no-wallet',
  //       icon: '👛',
  //     })
  //     return
  //   }
  //   if (found.length === 1) {
  //     void signInWith(found[0])
  //     return
  //   }
  //   setPickerOpen(true)
  // }, [signInWith])

  const busy = connecting || status === 'loading'
  const label = busy ? 'Starting...' : 'START'

  const ease = [0.16, 1, 0.3, 1] as const
  const rise = (delay: number) =>
    reduced
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.3, delay: delay * 0.5 } }
      : { initial: { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.6, ease, delay } }

  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center">
      {/* Scrim so the copy + CTA read cleanly over the floating device. Only as tall as the text needs,
          feathering clear just above the headline so the screen and device stay visible. */}
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

        {inviteText && <p className="mt-4 text-[13px] font-bold text-brand-500">{inviteText}</p>}

        <div className="relative pointer-events-auto mt-6 w-full">
          <button
            type="button"
            onClick={() => void onCta()}
            disabled={busy}
            className="btn-primary pointer-events-none flex h-14 w-full items-center justify-center rounded-full text-lg disabled:opacity-70"
          >
            {label}
          </button>
          <HapticOverlay
            className="absolute inset-0 rounded-full"
            preset="rigid"
            disabled={busy}
            silent
            onTap={() => void onCta()}
          />
        </div>

        {/* Connect Sui Wallet button hidden for now. Uncomment to bring native wallet connect back.
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
        */}

        <div className="relative pointer-events-auto mt-3.5 inline-block">
          <button
            type="button"
            onClick={() => toggleDemo(!demo)}
            className="pointer-events-none text-sm font-semibold text-text-3 underline underline-offset-4 transition-colors hover:text-text-2"
          >
            {demo ? 'Connect for real instead' : 'Just exploring? Try demo mode'}
          </button>
          <HapticOverlay className="absolute inset-0" preset="selection" silent onTap={() => toggleDemo(!demo)} />
        </div>

        <SocialFooter dense className="pointer-events-auto mt-6" />
      </motion.div>

      <AccessCodeSheet open={codeOpen} onUnlocked={onUnlocked} onClose={() => setCodeOpen(false)} />

      <WalletPicker
        open={pickerOpen}
        wallets={wallets}
        onPick={(w) => void signInWith(w)}
        onClose={() => setPickerOpen(false)}
      />

      <SignInErrorSheet
        error={signInError}
        onRetry={() => {
          setSignInError(null)
          void onCta()
        }}
        onTryDemo={() => toggleDemo(true)}
        onClose={() => setSignInError(null)}
      />
    </div>
  )
}

// Shown when sign-in fails, App-Surface bottom sheet naming what broke with a direct line to us.
// CHAIN_UNAVAILABLE is special-cased as maintenance (chain briefly unreachable), pushing demo mode as the way in.
function SignInErrorSheet({
  error,
  onRetry,
  onTryDemo,
  onClose,
}: {
  error: AuthError | null
  onRetry: () => void
  onTryDemo: () => void
  onClose: () => void
}) {
  const [showDetails, setShowDetails] = useState(false)
  // The technical line worth showing: the backend's underlying cause if present, else the message.
  const detail = error?.details || error?.message
  // The Predict deployment is unreachable (the chain is down or the deploy is mid-migration); the
  // backend tags this via error code since details are stripped in prod.
  const chainDown = error?.code === 'CHAIN_UNAVAILABLE'

  return (
    <AnimatePresence onExitComplete={() => setShowDetails(false)}>
      {error && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="pointer-events-auto absolute inset-0 z-30 bg-black/75"
          />
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ duration: 0.34, ease: [0.16, 1, 0.3, 1] }}
            className="pointer-events-auto absolute inset-x-0 bottom-0 z-40 mx-auto w-full max-w-sm rounded-t-3xl border border-line-strong bg-surface p-5 pb-[max(24px,calc(env(safe-area-inset-bottom)+18px))]"
          >
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-line-strong" />

            {chainDown ? (
              <>
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-500/15 text-brand-500">
                  <RefreshGlyph className="h-6 w-6" />
                </div>

                <h2 className="text-center text-lg font-extrabold tracking-tight text-text">PIPS is back soon</h2>
                <p className="mx-auto mt-1.5 max-w-xs text-center text-[13.5px] leading-snug text-text-2">
                  We're doing some maintenance to get PIPS back online. Sign-in is down for a bit,
                  usually back within a couple of hours. You can play demo mode right now with free
                  practice chips.
                </p>

                <button
                  type="button"
                  onClick={onTryDemo}
                  className="btn-primary mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-full text-[15px]"
                >
                  Play demo mode
                </button>

                <div className="mt-2.5 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onRetry}
                    className="flex h-11 flex-1 items-center justify-center rounded-full border border-line-strong bg-canvas text-[14px] font-bold text-text transition-colors hover:bg-surface-2"
                  >
                    Try again
                  </button>
                  <div className="relative h-11 flex-1">
                    <a
                      href={config.links.support}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => haptic('rigid')}
                      className="pointer-events-none flex h-11 w-full items-center justify-center gap-1.5 rounded-full border border-line-strong bg-canvas text-[14px] font-bold text-text transition-colors hover:bg-surface-2"
                    >
                      <TelegramGlyph className="size-4" />
                      Telegram
                    </a>
                    <HapticOverlay
                      className="absolute inset-0 rounded-full"
                      preset="rigid"
                      onTap={() => window.open(config.links.support, '_blank', 'noopener,noreferrer')}
                    />
                  </div>
                </div>
              </>
            ) : (
              <>
                <img
                  src="/assets/icons/icon-warning.webp"
                  alt=""
                  className="mx-auto mb-3 h-16 w-16"
                  draggable={false}
                />

                <h2 className="text-center text-lg font-extrabold tracking-tight text-text">
                  We couldn't sign you in
                </h2>
                <p className="mx-auto mt-1.5 max-w-xs text-center text-[13.5px] leading-snug text-text-2">
                  Something went wrong on our end, so sign-in didn't finish. If you are reviewing PIPS,
                  message us and we will fix it right away.
                </p>

                {error.code && (
                  <div className="mt-3 flex justify-center">
                    <span className="rounded-full border border-line-strong bg-canvas px-2.5 py-1 font-mono text-[10.5px] font-bold uppercase tracking-[0.06em] text-text-3">
                      {error.code}
                    </span>
                  </div>
                )}

                <div className="relative mt-5 w-full">
                  <a
                    href={config.links.support}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => haptic('rigid')}
                    className="btn-primary pointer-events-none flex h-12 w-full items-center justify-center gap-2 rounded-full text-[15px]"
                  >
                    <TelegramGlyph className="size-4.5" />
                    Message us on Telegram
                  </a>
                  <HapticOverlay
                    className="absolute inset-0 rounded-full"
                    preset="rigid"
                    onTap={() => window.open(config.links.support, '_blank', 'noopener,noreferrer')}
                  />
                </div>

                <div className="mt-2.5 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onRetry}
                    className="flex h-11 flex-1 items-center justify-center rounded-full border border-line-strong bg-canvas text-[14px] font-bold text-text transition-colors hover:bg-surface-2"
                  >
                    Try again
                  </button>
                  <button
                    type="button"
                    onClick={onClose}
                    className="flex h-11 flex-1 items-center justify-center rounded-full text-[14px] font-bold text-text-3 transition-colors hover:text-text-2"
                  >
                    Dismiss
                  </button>
                </div>
              </>
            )}

            {detail && (
              <div className="mt-3 border-t border-line pt-3">
                <button
                  type="button"
                  onClick={() => setShowDetails((v) => !v)}
                  className="mx-auto flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-3 transition-colors hover:text-text-2"
                >
                  {showDetails ? 'Hide' : 'Show'} technical details
                </button>
                <AnimatePresence initial={false}>
                  {showDetails && (
                    <motion.pre
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                      className="selectable mt-2 max-h-32 overflow-auto whitespace-pre-wrap wrap-break-word rounded-xl border border-line bg-canvas p-3 font-mono text-[11px] leading-relaxed text-text-3 select-text"
                    >
                      {detail}
                    </motion.pre>
                  )}
                </AnimatePresence>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

// The access gate for a private test deploy (VITE_ACCESS_GUARD). A centered blur overlay that asks
// for the code. A correct one is remembered per-device by tryUnlock, so the door never asks again.
function AccessCodeSheet({
  open,
  onUnlocked,
  onClose,
}: {
  open: boolean
  onUnlocked: () => void
  onClose: () => void
}) {
  const [code, setCode] = useState('')
  const [error, setError] = useState(false)

  const submit = () => {
    if (tryUnlock(code)) {
      onUnlocked()
    } else {
      setError(true)
      haptic('error')
    }
  }

  return (
    <AnimatePresence
      onExitComplete={() => {
        setCode('')
        setError(false)
      }}
    >
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-black/70 px-6 backdrop-blur-md"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-xs rounded-3xl border border-line-strong bg-surface p-6"
          >
            <h2 className="text-center text-lg font-extrabold tracking-tight text-text">Private testing</h2>
            <p className="mx-auto mt-1.5 max-w-[15rem] text-center text-[13.5px] leading-snug text-text-2">
              PIPS is not open yet. Enter the access code to continue.
            </p>

            <input
              autoFocus
              value={code}
              onChange={(e) => {
                setCode(e.target.value)
                setError(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
              placeholder="Access code"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className={cnm(
                'mt-5 h-12 w-full rounded-2xl border bg-canvas px-4 text-center text-[15px] font-semibold tracking-wide text-text outline-none transition-colors placeholder:font-medium placeholder:text-text-3',
                error ? 'border-down' : 'border-line-strong focus:border-brand-500',
              )}
            />
            {error && (
              <p className="mt-2 text-center text-[12.5px] font-semibold text-down">That code didn't work.</p>
            )}

            <div className="relative mt-4 w-full">
              <button
                type="button"
                onClick={submit}
                disabled={!code.trim()}
                className="btn-primary pointer-events-none flex h-12 w-full items-center justify-center rounded-full text-[15px] disabled:opacity-50"
              >
                Unlock
              </button>
              <HapticOverlay
                className="absolute inset-0 rounded-full"
                preset="rigid"
                disabled={!code.trim()}
                silent
                onTap={submit}
              />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function RefreshGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M3.5 12a8.5 8.5 0 0 1 14.5-6m2 0v-4m0 4h-4M20.5 12A8.5 8.5 0 0 1 6 18m-2 0v4m0-4h4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function TelegramGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M21.94 4.51 18.9 19.2c-.23 1.02-.84 1.27-1.7.79l-4.7-3.46-2.27 2.18c-.25.25-.46.46-.95.46l.34-4.78L18.3 6.6c.38-.34-.08-.53-.59-.19L6.96 13.4l-4.65-1.45c-1.01-.32-1.03-1.01.21-1.5l18.18-7c.85-.3 1.59.2 1.24 1.06Z" />
    </svg>
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

// The device screen while it floats on landing: just a black backing. "PRESS START" renders as a real
// plane on the 3D screen (ConsoleCanvas) so it tilts with the handheld instead of detaching as a flat overlay.
export function AttractScreen() {
  return <div className="h-full w-full bg-black" />
}
