// Every chart on the dashboard. One component, because they only differ by mark, bucket size and unit.
//
// Two rules shape the implementation. A canvas cannot resolve `var()`, and check:admin bans a literal
// colour anywhere under src/admin, so every colour is read off the live CSS custom properties at mount.
// And a null bucket breaks the line rather than being interpolated through: a gap with no traffic is not
// a straight line down and back up.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  TimeScale,
  Tooltip,
} from 'chart.js'
import { Chart } from 'react-chartjs-2'
import 'chartjs-adapter-date-fns'

import { EmptyState } from './primitives'

ChartJS.register(BarController, BarElement, CategoryScale, Filler, LineController, LineElement, LinearScale, PointElement, TimeScale, Tooltip)

export type ChartTone = 'accent' | 'neutral' | 'critical' | 'ok'

export interface ChartPoint {
  t: number
  /** null is a real gap: no data for that bucket, not a zero. */
  v: number | null
}

export interface ChartSeries {
  name: string
  tone: ChartTone
  points: ChartPoint[]
}

const TONE_TOKEN: Record<ChartTone, string> = {
  accent: '--a-accent',
  neutral: '--a-text-3',
  critical: '--a-critical',
  ok: '--a-ok',
}

const TONE_FILL: Record<ChartTone, string> = {
  accent: '--a-accent-soft',
  neutral: '--a-tint',
  critical: '--a-critical-soft',
  ok: '--a-ok-soft',
}

export type ChartUnit = 'minute' | 'hour' | 'day'

// Buckets carry their own width, so the axis is told what it is looking at instead of guessing from range.
const AXIS: Record<ChartUnit, { display: string; tooltip: string }> = {
  minute: { display: 'HH:mm', tooltip: 'HH:mm' },
  hour: { display: 'HH:mm', tooltip: 'EEE d MMM, HH:mm' },
  day: { display: 'd MMM', tooltip: 'EEE d MMM yyyy' },
}

function readTokens(el: HTMLElement): (name: string) => string {
  const style = getComputedStyle(el)
  return (name: string) => style.getPropertyValue(name).trim()
}

export function TimeSeriesChart({
  series,
  kind = 'line',
  unit,
  height = 160,
  format = (n: number) => String(n),
  label,
}: {
  series: ChartSeries[]
  kind?: 'line' | 'bar'
  unit: ChartUnit
  height?: number
  format?: (n: number) => string
  /** Read aloud by a screen reader, so it carries an actual reading and not just a title. */
  label: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  // The dashboard is SSR'd. A canvas has nothing to draw against on the server, so mount it after hydration.
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])

  const reduced = useMemo(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    [],
  )

  const filled = series.reduce((n, s) => n + s.points.filter((p) => p.v != null).length, 0)
  const buckets = series[0]?.points.length ?? 0

  const config = useMemo(() => {
    // Tokens are read off the live element, so this cannot run until after the first paint.
    if (!ready || !hostRef.current) return null
    const token = readTokens(hostRef.current)

    return {
      data: {
        datasets: series.map((s) => ({
          label: s.name,
          data: s.points.map((p) => ({ x: p.t, y: p.v })),
          borderColor: token(TONE_TOKEN[s.tone]),
          backgroundColor: kind === 'bar' ? token(TONE_TOKEN[s.tone]) : token(TONE_FILL[s.tone]),
          borderWidth: kind === 'bar' ? 0 : 1.5,
          fill: kind === 'line' && series.length === 1,
          tension: 0,
          pointRadius: 0,
          pointHoverRadius: 3,
          pointHoverBorderWidth: 0,
          pointHoverBackgroundColor: token(TONE_TOKEN[s.tone]),
          // A bucket with no data breaks the line. Interpolating through it is lying with a chart.
          spanGaps: false,
          borderJoinStyle: 'round' as const,
          maxBarThickness: 22,
        })),
      },
      options: {
        maintainAspectRatio: false,
        responsive: true,
        animation: reduced ? (false as const) : { duration: 160 },
        // Hover anywhere in the column, not just on the 1.5px line.
        interaction: { mode: 'index' as const, intersect: false },
        layout: { padding: { top: 4 } },
        scales: {
          x: {
            type: 'time' as const,
            // No timeZone option: the adapter formats in the browser's own zone, which is the reader's.
            time: { unit, tooltipFormat: AXIS[unit].tooltip, displayFormats: { [unit]: AXIS[unit].display } },
            grid: { display: false },
            border: { color: token('--a-border') },
            ticks: {
              color: token('--a-text-muted'),
              maxRotation: 0,
              autoSkipPadding: 16,
              font: { size: 10 },
            },
          },
          y: {
            beginAtZero: true,
            grid: { color: token('--a-border'), tickBorderDash: [2, 3] },
            border: { display: false },
            ticks: {
              color: token('--a-text-muted'),
              maxTicksLimit: 4,
              font: { size: 10 },
              callback: (value: string | number) => format(Number(value)),
            },
          },
        },
        plugins: {
          legend: { display: false as const },
          tooltip: {
            backgroundColor: token('--a-overlay'),
            borderColor: token('--a-border-strong'),
            borderWidth: 1,
            titleColor: token('--a-text-2'),
            bodyColor: token('--a-text'),
            titleFont: { size: 11, weight: 500 as const },
            bodyFont: { size: 12, weight: 600 as const },
            padding: 8,
            cornerRadius: 7,
            displayColors: series.length > 1,
            callbacks: {
              label: (ctx: { dataset: { label?: string }; parsed: { y: number | null } }) =>
                `${series.length > 1 ? `${ctx.dataset.label}  ` : ''}${ctx.parsed.y == null ? 'no data' : format(ctx.parsed.y)}`,
            },
          },
        },
      },
    }
  }, [series, kind, unit, format, reduced, ready])

  // One bucket is a number, not a line. Say so rather than drawing an invisible path that reads as zero.
  if (buckets > 0 && filled < 2) {
    return <EmptyState title="Not enough history to plot" hint={`${filled} of ${buckets} buckets have data. One bucket is a number, not a line.`} />
  }
  if (buckets === 0) return <EmptyState title="No data in this window" hint="Nothing has been recorded yet, which is not the same as zero." />

  return (
    <div ref={hostRef} style={{ height }} role="img" aria-label={label}>
      {ready && config ? <Chart type={kind} data={config.data} options={config.options} aria-label={label} /> : null}
    </div>
  )
}
