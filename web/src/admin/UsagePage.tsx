// Usage: the page that answers "what do people actually use". Five panels, and the ordering of the first
// one is the whole point: event counts ASCENDING, so the features nobody touches sit at the top instead of
// being buried under the ones that obviously work.
//
// Hand-rolled SVG for the funnel bars, no chart library. Colour carries severity only, so every bar here is
// neutral and only a genuinely bad number (a step nobody cleared) gets a tone.

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { EmptyState, ErrorState, LoadingState, Panel } from './components/primitives'
import { usageQuery } from './queries'
import type { UsageReport } from './types'

const WINDOWS = [7, 30, 90]

export function UsagePage() {
  const [days, setDays] = useState(30)
  const { data, isPending, error, refetch } = useQuery(usageQuery(days))

  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-center justify-between">
        <h1 className="a-page-title">Usage</h1>
        <div className="flex items-center gap-2">
          <span className="a-label">Window</span>
          <select className="a-select" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Window in days">
            {WINDOWS.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="lg:hidden">
        <div className="a-panel">
          <p className="a-section-title">Open this on a desktop</p>
          <p className="mt-1" style={{ color: 'var(--a-text-2)' }}>
            Usage is a dense table view built for 1280px and up. Errors is the one page that works from a phone.
          </p>
        </div>
      </div>

      {isPending && (
        <Panel>
          <LoadingState label="Counting events" />
        </Panel>
      )}
      {error && (
        <Panel>
          <ErrorState message={error instanceof Error ? error.message : 'Could not load usage'} onRetry={() => void refetch()} />
        </Panel>
      )}
      {data && <Report report={data} days={days} />}
    </div>
  )
}

function Report({ report, days }: { report: UsageReport; days: number }) {
  if (report.totalEvents === 0) {
    return (
      <Panel title="Events">
        <EmptyState
          title={`No events in the last ${days} days`}
          hint="Either nobody has used the app in this window, or analytics is switched off in Settings. Both are worth knowing which."
        />
      </Panel>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Funnel report={report} />
        <Games report={report} />
      </div>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Cohorts report={report} />
        <MenuSections report={report} />
      </div>
      <Events report={report} days={days} />
    </div>
  )
}

// The step counts are a sequential subset, so a drop-off can never be negative and never exceed 100.
function Funnel({ report }: { report: UsageReport }) {
  const top = report.funnel[0]?.subjects ?? 0
  return (
    <Panel title="Sign-in funnel">
      <table className="a-table">
        <thead>
          <tr>
            <th>Step</th>
            <th className="a-num">People</th>
            <th className="a-num">Drop-off</th>
            <th style={{ width: '35%' }}>Share</th>
          </tr>
        </thead>
        <tbody>
          {report.funnel.map((step) => (
            <tr key={step.key}>
              <td style={{ color: 'var(--a-text)' }}>{step.label}</td>
              <td className="a-num">{step.subjects.toLocaleString()}</td>
              <td className="a-num" style={{ color: step.dropPct >= 50 ? 'var(--a-critical)' : undefined }}>
                {step.skipped ? 'not active' : `${step.dropPct}%`}
              </td>
              <td>
                <Bar fraction={top ? step.subjects / top : 0} muted={step.skipped} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  )
}

function Bar({ fraction, muted }: { fraction: number; muted?: boolean }) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)))
  return (
    <svg viewBox="0 0 100 8" preserveAspectRatio="none" style={{ width: '100%', height: 8 }} role="img" aria-label={`${pct}% of the first step`}>
      <rect x={0} y={1} width={100} height={6} fill="var(--a-overlay)" />
      {pct > 0 && <rect x={0} y={1} width={pct} height={6} fill={muted ? 'var(--a-text-muted)' : 'var(--a-text-3)'} />}
    </svg>
  )
}

function Games({ report }: { report: UsageReport }) {
  return (
    <Panel title="Per game, open to play">
      <table className="a-table">
        <thead>
          <tr>
            <th>Game</th>
            <th className="a-num">Opens</th>
            <th className="a-num">Play taps</th>
            <th className="a-num">Conversion</th>
          </tr>
        </thead>
        <tbody>
          {report.games.map((g) => (
            <tr key={g.game}>
              <td style={{ color: 'var(--a-text)' }}>{g.game}</td>
              <td className="a-num">{g.opens.toLocaleString()}</td>
              <td className="a-num">{g.plays.toLocaleString()}</td>
              <td className="a-num">{g.opens === 0 ? '-' : `${g.conversionPct}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  )
}

function Cohorts({ report }: { report: UsageReport }) {
  if (!report.cohorts.length) {
    return (
      <Panel title="Retention">
        <EmptyState title="No signups in this window" hint="D1 and D7 are measured per signup day, so a window with no signups has nothing to retain." />
      </Panel>
    )
  }
  return (
    <Panel title="Retention, D1 and D7">
      <div className="max-h-[280px] overflow-y-auto">
        <table className="a-table">
          <thead>
            <tr>
              <th>Signed up</th>
              <th className="a-num">Users</th>
              <th className="a-num">D1</th>
              <th className="a-num">D7</th>
            </tr>
          </thead>
          <tbody>
            {report.cohorts.map((c) => (
              <tr key={c.date}>
                <td style={{ color: 'var(--a-text)' }}>{c.date}</td>
                <td className="a-num">{c.signups}</td>
                <td className="a-num">
                  {c.d1} <span style={{ color: 'var(--a-text-3)' }}>({c.d1Pct}%)</span>
                </td>
                <td className="a-num">
                  {c.d7} <span style={{ color: 'var(--a-text-3)' }}>({c.d7Pct}%)</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function MenuSections({ report }: { report: UsageReport }) {
  if (!report.menu.length) {
    return (
      <Panel title="Menu sections">
        <EmptyState title="No menu navigation recorded yet" hint="One menu.section event fires per screen opened." />
      </Panel>
    )
  }
  return (
    <Panel title="Menu sections, most opened first">
      <div className="max-h-[280px] overflow-y-auto">
        <table className="a-table">
          <thead>
            <tr>
              <th>Section</th>
              <th className="a-num">Opens</th>
            </tr>
          </thead>
          <tbody>
            {report.menu.map((m) => (
              <tr key={m.section}>
                <td style={{ color: 'var(--a-text)' }}>{m.section}</td>
                <td className="a-num">{m.count.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

// Ascending, and every catalog name is here including the zero-count ones. A feature with no events at all
// is the most rarely used thing we ship, so it belongs at the very top, not missing from the list.
function Events({ report, days }: { report: UsageReport; days: number }) {
  const [showAll, setShowAll] = useState(false)
  const unused = report.events.filter((e) => e.count === 0)
  const rows = showAll ? report.events : report.events.slice(0, 25)

  return (
    <Panel
      title={`Events, least used first (${report.totalEvents.toLocaleString()} in ${days} days)`}
      action={
        <button type="button" className="a-btn" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show the 25 least used' : `Show all ${report.events.length}`}
        </button>
      }
    >
      {unused.length > 0 && (
        <p className="border-b border-[var(--a-border)] px-3 py-2" style={{ color: 'var(--a-text-2)', fontSize: 12 }}>
          {unused.length} of {report.events.length} catalog events never fired in this window. Either nobody uses that feature, or it
          shipped without a track() call, and those two look identical from here.
        </p>
      )}
      <table className="a-table">
        <thead>
          <tr>
            <th>Event</th>
            <th className="a-num">Count</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.name}>
              <td style={{ color: e.count === 0 ? 'var(--a-text-3)' : 'var(--a-text)' }}>{e.name}</td>
              <td className="a-num">{e.count.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  )
}
