// The handful of shapes every admin page repeats. Plain HTML plus the component classes in admin.css,
// borrowing the product's palette, hardware keys and lucide icons so this reads as the same app.
// Charts live in charts.tsx and are Chart.js: axes, local-timezone dates and hover values are the point.
//
// Everything here renders text, never HTML: an error message can carry attacker-controlled input and
// this dashboard is where it gets displayed.

import { Check, Copy, type LucideIcon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { cnm } from '@/utils/style'

export function Panel({
  title,
  icon: Icon,
  note,
  action,
  children,
  className,
}: {
  title?: string
  icon?: LucideIcon
  note?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cnm('a-panel-flush flex flex-col', className)}>
      {(title || action) && (
        <header className="a-panel-head">
          <span className="flex min-w-0 items-center gap-2">
            {Icon && <Icon size={14} strokeWidth={2.4} style={{ color: 'var(--a-text-muted)' }} />}
            <span className="a-section-title truncate">{title}</span>
            {note && (
              <span className="truncate" style={{ color: 'var(--a-text-3)', fontSize: 12 }}>
                {note}
              </span>
            )}
          </span>
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

const LEVEL_CLASS: Record<string, string> = {
  fatal: 'a-badge-critical',
  error: 'a-badge-critical',
  warn: 'a-badge-warn',
}

const STATUS_CLASS: Record<string, string> = {
  open: 'a-badge-critical',
  ack: 'a-badge-warn',
  resolved: 'a-badge-ok',
  ignored: 'a-badge-neutral',
}

export function Badge({
  children,
  tone,
}: {
  children: ReactNode
  tone: 'critical' | 'warn' | 'ok' | 'info' | 'accent' | 'neutral'
}) {
  return <span className={`a-badge a-badge-${tone}`}>{children}</span>
}

export function LevelBadge({ level }: { level: string }) {
  return <span className={cnm('a-badge', LEVEL_CLASS[level] ?? 'a-badge-neutral')}>{level}</span>
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={cnm('a-badge', STATUS_CLASS[status] ?? 'a-badge-neutral')}>{status}</span>
}

// Direction only. An arrow is not a colour: a rising warn-level count must not read as critical.
export function Trend({ trend }: { trend: 'up' | 'down' | 'flat' }) {
  const glyph = trend === 'up' ? '↑' : trend === 'down' ? '↓' : '·'
  return (
    <span style={{ color: trend === 'up' ? 'var(--a-critical)' : 'var(--a-text-3)' }} title={`Trending ${trend}`}>
      {glyph}
    </span>
  )
}

// The window picker. A segmented control beats a <select> here: three options, always visible, one tap.
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div className="a-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          data-active={o.value === value}
          className="a-seg-item"
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// Every page's four states get real copy. "No data" tells a reader nothing about whether the system is
// healthy or the query is broken, which is the difference that matters at 3am.
export function EmptyState({ title, hint, icon: Icon }: { title: string; hint?: string; icon?: LucideIcon }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      {Icon && (
        <span
          className="mb-1 flex h-11 w-11 items-center justify-center rounded-full"
          style={{ background: 'var(--a-tint)', color: 'var(--a-text-muted)' }}
        >
          <Icon size={19} strokeWidth={2.2} />
        </span>
      )}
      <p style={{ color: 'var(--a-text-2)', fontWeight: 600 }}>{title}</p>
      {hint && (
        <p className="max-w-[52ch]" style={{ color: 'var(--a-text-3)', fontSize: 12 }}>
          {hint}
        </p>
      )}
    </div>
  )
}

// Loading is skeleton rows, not the word "Loading". The layout is already known, so show it settling.
export function LoadingState({ label, rows = 5 }: { label: string; rows?: number }) {
  return (
    <div className="flex flex-col gap-2 p-4" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="a-shimmer" style={{ height: 14, width: `${100 - i * 9}%` }} />
      ))}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <p style={{ color: 'var(--a-critical)', fontWeight: 600 }}>{message}</p>
      {onRetry && (
        <button type="button" className="a-btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}

// The in-table proportion bar. Amber when it carries the reading, neutral when it is only scale.
export function Bar({
  fraction,
  tone = 'neutral',
  height = 6,
}: {
  fraction: number
  tone?: 'accent' | 'neutral' | 'muted'
  height?: number
}) {
  const pct = Math.max(0, Math.min(100, fraction * 100))
  const fill = tone === 'accent' ? 'var(--a-accent)' : tone === 'muted' ? 'var(--a-text-muted)' : 'var(--a-text-3)'
  return (
    <span
      className="block w-full overflow-hidden"
      style={{ height, borderRadius: height / 2, background: 'var(--a-track)' }}
      role="img"
      aria-label={`${Math.round(pct)}%`}
    >
      <span
        className="block h-full"
        style={{
          width: `${pct}%`,
          borderRadius: height / 2,
          background: fill,
          boxShadow: tone === 'accent' ? 'var(--a-accent-glow)' : undefined,
        }}
      />
    </span>
  )
}

// The stat tile. Mono micro-label above, hero number below, one line of context underneath, which is
// where "as of" and "of 412 users" live so a number is never read without its denominator.
export function Metric({
  label,
  value,
  hint,
  tone,
  icon: Icon,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: 'critical' | 'warn' | 'ok' | 'accent'
  icon?: LucideIcon
}) {
  const color = tone ? `var(--a-${tone})` : undefined
  return (
    <div className="a-panel flex min-w-0 flex-col gap-1.5">
      <span className="flex items-center gap-1.5">
        {Icon && <Icon size={12} strokeWidth={2.6} style={{ color: 'var(--a-text-muted)' }} />}
        <span className="a-label truncate">{label}</span>
      </span>
      <span className="a-metric truncate" style={color ? { color } : undefined}>
        {value}
      </span>
      {/* The hint carries the denominator, and it truncates on a narrow tile, so a plain-text one keeps a
          tooltip. Without it "1180 of 1284 wallets read, 104 timed out" reads as "1180 of 1284 wallets read". */}
      {hint != null && (
        <span style={{ color: 'var(--a-text-3)', fontSize: 12 }} className="truncate" title={typeof hint === 'string' ? hint : undefined}>
          {hint}
        </span>
      )}
    </div>
  )
}

// Every address on this dashboard is shortened, and a shortened address you cannot copy is decoration.
// One click copies the FULL value; the middle is elided so the leading and trailing bytes both stay
// readable, which is what you actually eyeball against an explorer.
export function Address({ value, chars = 8 }: { value: string; chars?: number }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(t)
  }, [copied])

  const copy = async () => {
    // Safari over http (and any non-secure context) has no clipboard API, so fall back rather than throw.
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value)
      else legacyCopy(value)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const short = value.length <= chars * 2 + 3 ? value : `${value.slice(0, chars)}...${value.slice(-chars)}`
  return (
    <button type="button" className="a-copy" onClick={copy} title={`${value}\nClick to copy`} aria-label={`Copy ${value}`}>
      <span className="a-mono">{short}</span>
      {copied ? <Check size={12} strokeWidth={2.6} style={{ color: 'var(--a-ok)' }} /> : <Copy size={12} strokeWidth={2.2} className="a-copy-icon" />}
    </button>
  )
}

function legacyCopy(value: string): void {
  const el = document.createElement('textarea')
  el.value = value
  el.setAttribute('readonly', '')
  el.style.cssText = 'position:fixed;top:-1000px;opacity:0'
  document.body.appendChild(el)
  el.select()
  document.execCommand('copy')
  el.remove()
}

// Compact absolute + relative time. Absolute alone makes you do arithmetic, relative alone loses the
// deploy correlation, so both.
export function When({ iso }: { iso: string }) {
  const then = new Date(iso).getTime()
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  return (
    <span title={new Date(iso).toISOString()} style={{ color: 'var(--a-text-3)' }}>
      {relative(secs)}
    </span>
  )
}

function relative(secs: number): string {
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86_400)}d ago`
}

// The page title block. Same shape on all four pages, so the eye lands in the same place every time.
export function PageHeader({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="a-page-title">{title}</h1>
        {sub && (
          <p className="mt-1" style={{ color: 'var(--a-text-3)', fontSize: 12.5 }}>
            {sub}
          </p>
        )}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </header>
  )
}

// Every table goes in one of these. A dense table below its natural width does not compress, it overlaps:
// `.a-cell-fill` collapses to nothing and the numeric columns paint over each other. Scroll instead.
export function TableScroll({ children, minWidth }: { children: ReactNode; minWidth?: number }) {
  return (
    <div className="a-scroll-x" style={minWidth ? ({ '--a-table-min': `${minWidth}px` } as React.CSSProperties) : undefined}>
      {children}
    </div>
  )
}
