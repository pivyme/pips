// Add-to-Home-Screen guide: full-screen overlay (docs/DESIGN.md) showing the install steps for the
// visitor's exact browser. Mounted by _app in place of the 3D console while useInstallGate().active.
import { useState } from 'react'
import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import toast from 'react-hot-toast'
import { haptic } from '@/lib/haptics'
import { HapticOverlay } from '@/components/HapticOverlay'
import { cnm } from '@/utils/style'
import type { InstallContext, InstallGateState } from '@/lib/platform'

export function InstallGate({ ctx, canPrompt, promptInstall, skip }: InstallGateState) {
  const [dontShowAgain, setDontShowAgain] = useState(false)
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="absolute inset-0 z-30 flex flex-col items-center overflow-y-auto bg-canvas px-6 py-[max(40px,calc(env(safe-area-inset-top)+28px))] text-center"
    >
      {/* The whole block sits vertically centered (my-auto). The Share-button pointer is the one
          exception: it's pinned to the bottom below, because it points at Safari's real toolbar. */}
      <div className="my-auto flex w-full flex-col items-center">
        <img
          src="/assets/logos/pips-yellow-badge-3d.png"
          alt="PIPS"
          draggable={false}
          className="h-14 w-auto select-none drop-shadow-[0_10px_30px_rgba(0,0,0,0.6)]"
        />
        <h1 className="mt-5 text-2xl font-extrabold tracking-tight text-text">Install PIPS</h1>
        <p className="mt-2 max-w-[17rem] text-[14px] leading-snug text-text-2">
          Full screen, instant launch, no browser bar.
        </p>

        <div className="mt-7 flex w-full max-w-sm flex-col items-center">
          <Panel ctx={ctx} canPrompt={canPrompt} promptInstall={promptInstall} />
        </div>

        <label className="mt-7 flex cursor-pointer select-none items-center gap-2.5">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => {
              setDontShowAgain(e.target.checked)
              haptic('selection')
            }}
            className="sr-only"
          />
          <span
            className={cnm(
              'flex h-5 w-5 items-center justify-center rounded-md border transition-colors',
              dontShowAgain ? 'border-brand-500 bg-brand-500 text-black' : 'border-line-strong bg-surface',
            )}
          >
            {dontShowAgain && <CheckGlyph className="h-3.5 w-3.5" />}
          </span>
          <span className="text-[13.5px] font-semibold text-text-3">Don't show this again</span>
        </label>

        <div className="relative mt-4 w-full max-w-xs">
          <button
            type="button"
            onClick={() => skip(dontShowAgain)}
            className="pointer-events-none h-12 w-full rounded-full border border-line-strong bg-surface-2 text-[14.5px] font-semibold text-text-2 transition-colors hover:bg-surface hover:text-text active:scale-[0.98]"
          >
            Continue in browser
          </button>
          <HapticOverlay
            className="absolute inset-0 rounded-full"
            preset="selection"
            silent
            onTap={() => skip(dontShowAgain)}
          />
        </div>
      </div>

      {ctx === 'ios-safari' && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[max(18px,calc(env(safe-area-inset-bottom)+12px))] flex flex-col items-center gap-1.5 text-text-3">
          <span className="text-[12.5px] font-semibold">Find Share in the bar below</span>
          <motion.div animate={{ y: [0, 7, 0] }} transition={{ duration: 1.3, repeat: Infinity, ease: 'easeInOut' }}>
            <ChevronDownGlyph className="h-6 w-6 text-brand-500" />
          </motion.div>
        </div>
      )}
    </motion.div>
  )
}

function Panel({
  ctx,
  canPrompt,
  promptInstall,
}: {
  ctx: InstallContext
  canPrompt: boolean
  promptInstall: () => Promise<void>
}) {
  if (ctx === 'android-prompt') {
    return canPrompt ? (
      <>
        <div className="relative h-14 w-full">
          <button
            type="button"
            onClick={() => void promptInstall()}
            className="btn-primary pointer-events-none flex h-14 w-full items-center justify-center gap-2 rounded-full text-[16px]"
          >
            <PlusSquareGlyph className="h-5 w-5" />
            Add to Home Screen
          </button>
          <HapticOverlay
            className="absolute inset-0 rounded-full"
            preset="rigid"
            silent
            onTap={() => void promptInstall()}
          />
        </div>
        <p className="mt-3 text-[13px] text-text-3">One tap, and PIPS lands on your home screen.</p>
      </>
    ) : (
      <StepCard title="Add to your home screen">
        <Step n={1}>
          Tap the <MenuDotsGlyph className="mx-0.5 inline h-4 w-4 -translate-y-px text-brand-500" /> menu in your browser
        </Step>
        <Step n={2}>
          Pick <b className="font-bold text-text">Install app</b> or <b className="font-bold text-text">Add to Home screen</b>
        </Step>
      </StepCard>
    )
  }

  if (ctx === 'ios-safari') {
    return <IOSSteps />
  }

  if (ctx === 'ios-other') {
    return (
      <>
        <p className="max-w-[18rem] text-[14.5px] leading-snug text-text-2">
          PIPS installs from <b className="font-bold text-text">Safari</b>. Open this page in Safari, then add it to your
          home screen.
        </p>
        <CopyLinkButton />
        <div className="mt-6 w-full opacity-90">
          <IOSSteps compact />
        </div>
      </>
    )
  }

  // in-app webview
  return (
    <>
      <p className="max-w-[18rem] text-[14.5px] leading-snug text-text-2">
        You're inside an app's browser. Open PIPS in your real browser to install it.
      </p>
      <CopyLinkButton />
      <p className="mt-3 text-[13px] text-text-3">Tap the menu, then "Open in browser".</p>
    </>
  )
}

function IOSSteps({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={cnm(
        'flex w-full flex-col gap-3 rounded-3xl border border-line-strong bg-surface p-5 text-left',
        compact && 'gap-2.5 p-4',
      )}
    >
      <Step n={1}>
        Tap <ShareGlyph className="mx-0.5 inline h-[18px] w-[18px] -translate-y-px text-brand-500" /> Share
        <span className="text-text-3">
          {' '}
          (newer iOS: <MenuDotsGlyph className="mx-0.5 inline h-4 w-4 -translate-y-px text-text-2" /> then Share)
        </span>
      </Step>
      <Step n={2}>
        Pick <PlusSquareGlyph className="mx-0.5 inline h-[17px] w-[17px] -translate-y-px text-brand-500" />{' '}
        <b className="font-bold text-text">Add to Home Screen</b>
      </Step>
      <Step n={3}>
        Tap <b className="font-bold text-text">Add</b>. Done.
      </Step>
    </div>
  )
}

function StepCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex w-full flex-col gap-3 rounded-3xl border border-line-strong bg-surface p-5 text-left">
      <span className="text-[12px] font-bold uppercase tracking-[0.08em] text-text-3">{title}</span>
      {children}
    </div>
  )
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-500 text-[13px] font-extrabold text-black">
        {n}
      </span>
      <span className="text-[14.5px] font-semibold leading-snug text-text-2">{children}</span>
    </div>
  )
}

function CopyLinkButton() {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      toast.success('Link copied')
    } catch {
      toast.error('Could not copy the link')
    }
  }
  return (
    <div className="relative mt-5 w-full">
      <button
        type="button"
        onClick={() => void copy()}
        className="btn-primary pointer-events-none flex h-12 w-full items-center justify-center gap-2 rounded-full text-[15px]"
      >
        <LinkGlyph className="h-[18px] w-[18px]" />
        Copy link
      </button>
      <HapticOverlay className="absolute inset-0 rounded-full" preset="rigid" onTap={() => void copy()} />
    </div>
  )
}

function ShareGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M12 15V4m0 0L8.5 7.5M12 4l3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7 10H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function PlusSquareGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" stroke="currentColor" strokeWidth="1.9" />
      <path d="M12 8.5v7M8.5 12h7" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  )
}

function ChevronDownGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CheckGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 6.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function LinkGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M9 15l6-6M10.5 6.5l1-1a4 4 0 0 1 6 6l-1 1m-9 3-1 1a4 4 0 0 1-6-6l1-1"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function MenuDotsGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  )
}
