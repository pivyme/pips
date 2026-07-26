// The handful of shapes every admin page repeats. Plain HTML plus the component classes in admin.css:
// no HeroUI (themed for the product surface), no chart library (a sparkline is 20 lines of SVG), no
// motion library. Everything here renders text, never HTML: an error message can carry attacker-controlled
// input and this dashboard is where it gets displayed.

import type { ReactNode } from 'react'

import { cnm } from '@/utils/style'

export function Panel({ title, action, children, className }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cnm('a-panel-flush', className)}>
      {(title || action) && (
        <header className="flex h-8 items-center justify-between border-b border-[var(--a-border)] px-3">
          <span className="a-label">{title}</span>
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

export function Badge({ children, tone }: { children: ReactNode; tone: 'critical' | 'warn' | 'ok' | 'info' | 'neutral' }) {
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

// Every page's four states get real copy. "No data" tells a reader nothing about whether the system is
// healthy or the query is broken, which is the difference that matters at 3am.
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-14 text-center">
      <p style={{ color: 'var(--a-text-2)' }}>{title}</p>
      {hint && <p style={{ color: 'var(--a-text-3)', fontSize: 12 }}>{hint}</p>}
    </div>
  )
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="px-4 py-14 text-center" style={{ color: 'var(--a-text-3)' }}>
      {label}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-14 text-center">
      <p style={{ color: 'var(--a-critical)' }}>{message}</p>
      {onRetry && (
        <button type="button" className="a-btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}

// Hand-rolled bar chart, zero dependencies. Bars carry a count, so they stay neutral: colour is reserved
// for severity everywhere on this surface.
export function BarChart({ data, height = 56 }: { data: Array<{ t: number; n: number }>; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.n))
  const w = 100 / Math.max(1, data.length)
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ width: '100%', height }} role="img" aria-label="Occurrences per hour over the last 24 hours">
      {data.map((d, i) => {
        const h = d.n === 0 ? 0 : Math.max(1.5, (d.n / max) * (height - 2))
        return <rect key={d.t} x={i * w + w * 0.15} y={height - h} width={w * 0.7} height={h} fill="var(--a-text-3)" />
      })}
    </svg>
  )
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

// Under ~1024px the dense tables stop being readable. Say so plainly rather than shipping a squeeze.
export function DesktopOnlyNotice({ page }: { page: string }) {
  return (
    <div className="lg:hidden">
      <div className="a-panel">
        <p className="a-section-title">Open this on a desktop</p>
        <p className="mt-1" style={{ color: 'var(--a-text-2)' }}>
          {page} is a dense table view built for 1280px and up. Errors is the one page that works from a phone.
        </p>
      </div>
    </div>
  )
}
