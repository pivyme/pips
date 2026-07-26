// The handful of shapes every admin page repeats. Plain HTML plus the component classes in admin.css,
// borrowing the product's palette, hardware keys and lucide icons so this reads as the same app.
// No chart library: a sparkline is 20 lines of SVG.
//
// Everything here renders text, never HTML: an error message can carry attacker-controlled input and
// this dashboard is where it gets displayed.

import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

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

// Hand-rolled bar chart, zero dependencies. Bars carry a count, so they stay neutral: colour is reserved
// for severity everywhere on this surface.
export function BarChart({ data, height = 56 }: { data: Array<{ t: number; n: number }>; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.n))
  const w = 100 / Math.max(1, data.length)
  return (
    <svg
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height }}
      role="img"
      aria-label="Occurrences per hour over the last 24 hours"
    >
      {data.map((d, i) => {
        const h = d.n === 0 ? 0 : Math.max(1.5, (d.n / max) * (height - 2))
        return <rect key={d.t} x={i * w + w * 0.15} y={height - h} width={w * 0.7} height={h} fill="var(--a-text-3)" />
      })}
    </svg>
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
      {hint != null && (
        <span style={{ color: 'var(--a-text-3)', fontSize: 12 }} className="truncate">
          {hint}
        </span>
      )}
    </div>
  )
}

// 14-day sparkline, ~20 lines of SVG. A soft fill under the line so a flat series still reads as a
// series rather than a stray rule.
export function Sparkline({
  data,
  height = 40,
  tone = 'var(--a-accent)',
}: {
  data: Array<{ t: number; n: number }>
  height?: number
  tone?: string
}) {
  if (data.length < 2) return <div style={{ height, color: 'var(--a-text-muted)', fontSize: 11 }}>not enough history</div>
  const max = Math.max(1, ...data.map((d) => d.n))
  const step = 100 / (data.length - 1)
  const y = (n: number) => height - 1 - (n / max) * (height - 3)
  const points = data.map((d, i) => `${(i * step).toFixed(2)},${y(d.n).toFixed(2)}`).join(' ')
  const label = `${data.reduce((sum, d) => sum + d.n, 0)} over ${data.length} days, peak ${max}`
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ width: '100%', height }} role="img" aria-label={label}>
      <polygon points={`0,${height} ${points} 100,${height}`} fill={tone} opacity={0.1} />
      <polyline points={points} fill="none" stroke={tone} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  )
}

// p50 under p95 over time. Two lines, no legend clutter: p95 is the amber one because it is the number
// that describes what the slowest users actually felt.
export function LatencyChart({
  data,
  height = 96,
}: {
  data: Array<{ t: number; p50: number | null; p95: number | null }>
  height?: number
}) {
  // Two buckets, not two numbers: one bucket carries a p50 and a p95, and a single point draws nothing.
  const filled = data.filter((d) => d.p50 != null || d.p95 != null)
  if (filled.length < 2) return <EmptyState title="Not enough samples to plot" hint="One bucket is a number, not a line. Play again, or widen the window." />
  const values = data.flatMap((d) => [d.p50, d.p95]).filter((v): v is number => v != null)
  const max = Math.max(1, ...values)
  const step = 100 / Math.max(1, data.length - 1)
  const y = (v: number) => height - 2 - (v / max) * (height - 4)

  // A null bucket breaks the line rather than drawing straight through a gap that had no traffic.
  const path = (pick: (d: (typeof data)[number]) => number | null): string =>
    data
      .map((d, i) => {
        const v = pick(d)
        return v == null ? null : `${(i * step).toFixed(2)},${y(v).toFixed(2)}`
      })
      .reduce<string[]>((acc, point, i) => {
        if (point == null) return acc
        const prev = pick(data[i - 1] ?? { p50: null, p95: null })
        acc.push(`${prev == null ? 'M' : 'L'}${point}`)
        return acc
      }, [])
      .join(' ')

  return (
    <svg
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height }}
      role="img"
      aria-label={`p50 and p95 over time, peak ${Math.round(max)}ms`}
    >
      <path d={path((d) => d.p50)} fill="none" stroke="var(--a-text-3)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      <path d={path((d) => d.p95)} fill="none" stroke="var(--a-accent)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
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
