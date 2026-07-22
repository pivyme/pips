import { useState } from 'react'
import type { ReactNode } from 'react'
import { Check, ChevronDown, Copy, Gamepad2, Home, RotateCw } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import toast from 'react-hot-toast'
import { HapticOverlay } from '@/components/HapticOverlay'
import { haptic } from '@/lib/haptics'
import { cnm } from '@/utils/style'

// One design for both fault states (404 + crash): the console has "lost signal". A dead device
// screen with a flatlined price trace, then the App Surface language, bold black type + amber
// commit buttons + recessed skeuo detail, so it reads like PIPS, not a stock error page.

type Tone = 'lost' | 'fault'

// The hero: an amber-less molded bezel (card-neo) cradling a recessed screen that shows a live
// trace snapping to a dead flatline, the big fault code watermarked over it.
function DeadDevice({ code, tone }: { code: string; tone: Tone }) {
  const dead = tone === 'fault' ? 'var(--color-down)' : 'rgba(255,255,255,0.42)'
  const status = tone === 'fault' ? 'SYSTEM FAULT' : 'SIGNAL LOST'
  return (
    <div className="card-neo rounded-card p-3">
      <div
        className="relative aspect-[16/10] w-full overflow-hidden rounded-[16px] bg-black"
        style={{
          boxShadow:
            'inset 0 2px 10px rgba(0,0,0,0.85), inset 0 0 0 1px rgba(0,0,0,0.6), inset 0 0 60px rgba(0,0,0,0.5)',
        }}
      >
        <div className="viz-grid absolute inset-0 opacity-60" />
        <div className="viz-scanlines absolute inset-0 opacity-70" />

        {/* Top strip: wordmark left, blinking status right. */}
        <div className="absolute inset-x-0 top-0 flex items-center justify-between px-3 pt-2.5 text-[9px] font-bold uppercase tracking-[0.2em]">
          <span className="text-text-3">PIPS</span>
          <span className="flex items-center gap-1.5" style={{ color: dead }}>
            <span
              className="h-1.5 w-1.5 rounded-full animate-pulse"
              style={{ background: dead, boxShadow: `0 0 6px ${dead}` }}
            />
            {status}
          </span>
        </div>

        {/* The fault code, big and watermarked, sits behind the trace. */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span
            className="tnum font-black leading-none text-white/[0.16]"
            style={{ fontSize: 'clamp(88px, 30vw, 132px)', textShadow: '0 0 30px rgba(0,0,0,0.55)' }}
          >
            {code}
          </span>
        </div>

        {/* The trace: a live jagged run that snaps to a dead flatline, drawn full-opacity on top. */}
        <svg
          viewBox="0 0 320 160"
          fill="none"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
        >
          <path
            className="fault-draw"
            d="M0,96 L18,86 L34,104 L50,78 L66,110 L82,72 L98,98 L114,88 L130,120 L146,60 L160,92"
            pathLength={1}
            stroke="var(--color-brand-500)"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ filter: 'drop-shadow(0 0 4px rgba(255,192,22,0.35))' }}
          />
          <path
            className="fault-draw"
            d="M160,92 L320,92"
            pathLength={1}
            stroke={dead}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray="1"
            style={{ animationDelay: '0.55s', filter: `drop-shadow(0 0 5px ${dead})` }}
          />
          <circle cx={160} cy={92} r={3.5} fill={dead} className="animate-pulse" />
        </svg>

        {/* Screen vignette to sell the glass. */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{ boxShadow: 'inset 0 0 40px rgba(0,0,0,0.7)' }}
        />
      </div>
    </div>
  )
}

// A commit control matching the menu's tactile model: pointer-events-none visible element +
// HapticOverlay for the real iOS tick. `href` hard-navigates (a guaranteed reset from a crashed
// boundary), `onPress` runs a handler.
function ActionButton({
  label,
  icon: Icon,
  variant,
  href,
  onPress,
}: {
  label: string
  icon: LucideIcon
  variant: 'primary' | 'ghost'
  href?: string
  onPress?: () => void
}) {
  const act = () => {
    if (href) window.location.assign(href)
    else onPress?.()
  }
  const base =
    'pointer-events-none flex h-12 items-center justify-center gap-2 rounded-full px-5 text-[13px] font-extrabold uppercase tracking-wide transition-transform active:scale-[0.97]'
  const skin =
    variant === 'primary'
      ? 'btn-primary'
      : 'surface-skeuo text-text-2'
  const inner = (
    <>
      <Icon className="h-4 w-4" strokeWidth={2.6} />
      {label}
    </>
  )
  return (
    <div className="relative flex-1">
      {href ? (
        <a href={href} className={cnm(base, skin)}>
          {inner}
        </a>
      ) : (
        <button type="button" className={cnm(base, skin, 'w-full')}>
          {inner}
        </button>
      )}
      <HapticOverlay
        className="absolute inset-0 rounded-full"
        preset={variant === 'primary' ? 'medium' : 'selection'}
        silent
        onTap={act}
      />
    </div>
  )
}

// The shared shell: centered dead device, title/subtitle, an optional recessed detail card, actions.
function FaultShell({
  code,
  tone,
  title,
  subtitle,
  detail,
  actions,
}: {
  code: string
  tone: Tone
  title: string
  subtitle: string
  detail?: ReactNode
  actions: ReactNode
}) {
  return (
    <div
      className="flex min-h-[100dvh] w-full flex-col items-center justify-center bg-black px-6"
      style={{
        paddingTop: 'calc(env(safe-area-inset-top) + 2rem)',
        paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)',
      }}
    >
      <div className="flex w-full max-w-[360px] flex-col">
        <DeadDevice code={code} tone={tone} />
        <div className="mt-7 text-center">
          <h1 className="text-[26px] font-black leading-tight text-text">{title}</h1>
          <p className="mx-auto mt-2 max-w-[300px] text-sm leading-relaxed text-text-2">
            {subtitle}
          </p>
        </div>
        {detail}
        <div className="mt-7 flex items-center gap-3">{actions}</div>
      </div>
    </div>
  )
}

// A recessed skeuo strip: a mono micro-label over a value, with a copy button on the right.
function DetailStrip({
  label,
  value,
  onCopy,
  copied,
  children,
}: {
  label: string
  value: string
  onCopy: () => void
  copied: boolean
  children?: ReactNode
}) {
  return (
    <div className="surface-skeuo mt-6 overflow-hidden rounded-card">
      <div className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
            {label}
          </p>
          <p className="break-words font-mono text-xs leading-relaxed text-down">{value}</p>
        </div>
        <div className="relative h-8 w-8 shrink-0">
          <button
            type="button"
            aria-label="Copy details"
            className="pointer-events-none flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-white/[0.03] text-text-3 transition active:scale-90"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-up" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
          <HapticOverlay className="absolute inset-0 rounded-lg" preset="selection" silent onTap={onCopy} />
        </div>
      </div>
      {children}
    </div>
  )
}

export function NotFoundPage() {
  const [copied, setCopied] = useState(false)
  const path = typeof window !== 'undefined' ? window.location.pathname : ''

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`404 Not Found: ${window.location.href}`)
      setCopied(true)
      toast.success('Copied', { id: 'nf-copy' })
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Copy failed', { id: 'nf-copy' })
    }
  }

  return (
    <FaultShell
      code="404"
      tone="lost"
      title="This screen went dark"
      subtitle="We couldn't find that page. It moved, expired, or never existed. Let's get you back on the device."
      detail={
        path ? (
          <DetailStrip label="Requested path" value={path} onCopy={copy} copied={copied} />
        ) : undefined
      }
      actions={
        <>
          <ActionButton label="Games" icon={Gamepad2} variant="primary" href="/games" />
          <ActionButton label="Home" icon={Home} variant="ghost" href="/" />
        </>
      }
    />
  )
}

export function ErrorPage({ error, reset }: { error?: Error; reset?: () => void }) {
  const [copied, setCopied] = useState(false)
  const [showStack, setShowStack] = useState(false)

  const message = error?.message || 'Unknown error'
  const stack = error?.stack

  const retry = () => {
    haptic('medium')
    // reset() re-renders the boundary in place; without it a hard reload is the surest reset.
    if (reset) reset()
    else window.location.reload()
  }

  const copy = async () => {
    try {
      const parts = [
        `Error: ${message}`,
        `URL: ${window.location.href}`,
        `Time: ${new Date().toISOString()}`,
      ]
      if (stack) parts.push(`\nStack:\n${stack}`)
      await navigator.clipboard.writeText(parts.join('\n'))
      setCopied(true)
      toast.success('Error copied', { id: 'err-copy' })
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Copy failed', { id: 'err-copy' })
    }
  }

  return (
    <FaultShell
      code="ERR"
      tone="fault"
      title="Something broke"
      subtitle="An unexpected error knocked the console over. Try again, or head back home."
      detail={
        <DetailStrip label="Error" value={message} onCopy={copy} copied={copied}>
          {stack && (
            <>
              <div className="relative border-t border-line">
                <button
                  type="button"
                  className="pointer-events-none flex w-full items-center gap-1.5 px-4 py-2.5 text-[10px] font-bold uppercase tracking-[0.14em] text-text-3"
                >
                  <ChevronDown
                    className={cnm('h-3 w-3 transition-transform', showStack && 'rotate-180')}
                  />
                  Stack trace
                </button>
                <HapticOverlay
                  className="absolute inset-0"
                  preset="selection"
                  silent
                  onTap={() => setShowStack((v) => !v)}
                />
              </div>
              {showStack && (
                <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words border-t border-line px-4 py-3 font-mono text-[11px] leading-relaxed text-text-3">
                  {stack}
                </pre>
              )}
            </>
          )}
        </DetailStrip>
      }
      actions={
        <>
          <ActionButton label="Try again" icon={RotateCw} variant="primary" onPress={retry} />
          <ActionButton label="Home" icon={Home} variant="ghost" href="/" />
        </>
      }
    />
  )
}
