// Usage: the page that answers "what do people actually use". The ordering is the whole point, event
// counts ASCENDING, so the features nobody touches sit at the top instead of being buried under the ones
// that obviously work.
//
// The never-fired events are pulled out of the table into a chip grid. Forty rows of "0" is a scroll,
// forty chips is a glance, and that list is the one you are actually here to read.
//
// Hand-rolled SVG bars, no chart library. Colour carries meaning only: amber is the reading, neutral is
// scale, and red is reserved for a step people genuinely fell out of.

import { useQuery } from '@tanstack/react-query'
import { Activity, CircleSlash, Compass, Filter, Gamepad2, ListTree, Users } from 'lucide-react'
import { useState } from 'react'

import { GameIcon } from '@/components/GameIcon'
import { Bar, EmptyState, ErrorState, LoadingState, Metric, PageHeader, Panel, Segmented, TableScroll } from './components/primitives'
import { usageQuery } from './queries'
import type { UsageReport } from './types'

const WINDOWS = [
  { value: 7, label: '7d' },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' },
]

const pct = (n: number): string => `${Math.round(n)}%`

export function UsagePage() {
  const [days, setDays] = useState(30)
  const { data, isPending, error, refetch } = useQuery(usageQuery(days))

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Usage" sub="What people actually touch, least used first. A feature with no events looks exactly like one nobody wants.">
        <Segmented value={days} options={WINDOWS} onChange={setDays} label="Window in days" />
      </PageHeader>


      {isPending && (
        <Panel title="Counting events" icon={Activity}>
          <LoadingState label="Counting events" rows={6} />
        </Panel>
      )}
      {error && (
        <Panel title="Usage" icon={Activity}>
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
      <Panel title="Events" icon={Activity}>
        <EmptyState
          icon={CircleSlash}
          title={`No events in the last ${days} days`}
          hint="Either nobody has used the app in this window, or analytics is switched off in Settings. Worth knowing which."
        />
      </Panel>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Summary report={report} days={days} />
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <Funnel report={report} />
        <Games report={report} />
      </div>
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <Cohorts report={report} />
        <MenuSections report={report} />
      </div>
      <Events report={report} days={days} />
    </div>
  )
}

// The four numbers worth knowing before any table: volume, catalog coverage, and the two conversions
// that describe the whole product, landed to first play, and opened a game to tapped play.
function Summary({ report, days }: { report: UsageReport; days: number }) {
  const fired = report.events.filter((e) => e.count > 0).length
  const first = report.funnel[0]
  const last = report.funnel[report.funnel.length - 1]
  const signIn = first && last && first.subjects > 0 ? (last.subjects / first.subjects) * 100 : null

  const opens = report.games.reduce((sum, g) => sum + g.opens, 0)
  const plays = report.games.reduce((sum, g) => sum + g.plays, 0)
  const playRate = opens > 0 ? (plays / opens) * 100 : null

  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <Metric icon={Activity} label="Events" value={report.totalEvents.toLocaleString()} hint={`tracked in ${days} days`} />
      <Metric
        icon={ListTree}
        label="Catalog in use"
        value={`${fired}/${report.events.length}`}
        tone={fired === 0 ? 'critical' : undefined}
        hint={`${report.events.length - fired} names never fired`}
      />
      <Metric
        icon={Users}
        label="Landed to first play"
        value={signIn == null ? '--' : pct(signIn)}
        tone={signIn != null && signIn < 20 ? 'warn' : undefined}
        hint={first ? `${first.subjects.toLocaleString()} landed, ${last?.subjects.toLocaleString()} played` : 'no funnel data'}
      />
      <Metric
        icon={Gamepad2}
        label="Open to play"
        value={playRate == null ? '--' : pct(playRate)}
        hint={opens > 0 ? `${opens.toLocaleString()} opens, ${plays.toLocaleString()} taps` : 'no game opens yet'}
      />
    </div>
  )
}

// The step counts are a sequential subset, so a drop-off can never be negative and never exceed 100.
// Drawn as a real funnel: the bar is the share of the top step, and the drop is called out on the row
// it happened at, not in a column you have to correlate.
function Funnel({ report }: { report: UsageReport }) {
  const top = report.funnel[0]?.subjects ?? 0

  return (
    <Panel title="Sign-in funnel" icon={Filter} note={`from ${top.toLocaleString()} landed`}>
      <div className="flex flex-col gap-3.5 p-4">
        {report.funnel.map((step, i) => {
          const share = top ? step.subjects / top : 0
          const bad = !step.skipped && step.dropPct >= 50
          return (
            <div key={step.key} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="a-label" style={{ width: 16 }}>
                    {i + 1}
                  </span>
                  <span className="truncate" style={{ color: 'var(--a-text)', fontWeight: 600 }}>
                    {step.label}
                  </span>
                </span>
                <span className="flex shrink-0 items-baseline gap-2.5">
                  {step.skipped ? (
                    <span className="a-badge a-badge-neutral">not active</span>
                  ) : i > 0 && step.dropPct > 0 ? (
                    <span className={`a-badge ${bad ? 'a-badge-critical' : 'a-badge-neutral'}`}>-{pct(step.dropPct)}</span>
                  ) : null}
                  <span className="a-metric-sm">{step.subjects.toLocaleString()}</span>
                </span>
              </div>
              <Bar fraction={share} tone={step.skipped ? 'muted' : 'accent'} height={8} />
            </div>
          )
        })}
      </div>
    </Panel>
  )
}

// One row per game with its cartridge glyph, because "lucky" as bare text next to two numbers is the
// least memorable way to present three products.
function Games({ report }: { report: UsageReport }) {
  const max = Math.max(1, ...report.games.map((g) => g.opens))

  return (
    <Panel title="Per game" icon={Gamepad2} note="open to play tap">
      {report.games.length === 0 ? (
        <EmptyState icon={Gamepad2} title="No game opens in this window" hint="game.open fires once per screen entry." />
      ) : (
        <div className="flex flex-col gap-3.5 p-4">
          {report.games.map((g) => (
            <div key={g.game} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2" style={{ color: 'var(--a-text)' }}>
                  <GameIcon game={g.game} size={15} />
                  <span className="truncate font-semibold capitalize">{g.game.replace(/-/g, ' ')}</span>
                </span>
                <span className="flex shrink-0 items-baseline gap-2.5" style={{ color: 'var(--a-text-3)', fontSize: 12 }}>
                  {g.opens.toLocaleString()} opens
                  {g.opens > 0 && (
                    <span className="a-metric-sm" style={{ color: g.plays === 0 ? 'var(--a-text-3)' : 'var(--a-accent)' }}>
                      {pct(g.conversionPct)}
                    </span>
                  )}
                </span>
              </div>
              <Bar fraction={g.opens ? g.plays / g.opens : 0} tone={g.plays === 0 ? 'muted' : 'accent'} height={8} />
              <span style={{ color: 'var(--a-text-3)', fontSize: 11.5 }}>
                {g.opens === 0
                  ? 'nobody opened it in this window'
                  : `${g.plays.toLocaleString()} play taps · ${Math.round((g.opens / max) * 100)}% of the most-opened game`}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

function Cohorts({ report }: { report: UsageReport }) {
  if (!report.cohorts.length) {
    return (
      <Panel title="Retention" icon={Users}>
        <EmptyState
          icon={Users}
          title="No signups in this window"
          hint="D1 and D7 are measured per signup day, so a window with no signups has nothing to retain."
        />
      </Panel>
    )
  }
  return (
    <Panel title="Retention" icon={Users} note="D1 and D7 by signup day">
      <div className="a-scroll-x max-h-[300px] overflow-y-auto">
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
                <td className="a-key">{c.date}</td>
                <td className="a-num">{c.signups}</td>
                <td className="a-num" style={{ color: c.d1 === 0 ? 'var(--a-text-3)' : 'var(--a-ok)' }}>
                  {c.d1} <span style={{ color: 'var(--a-text-muted)', fontWeight: 500 }}>({c.d1Pct}%)</span>
                </td>
                <td className="a-num" style={{ color: c.d7 === 0 ? 'var(--a-text-3)' : 'var(--a-ok)' }}>
                  {c.d7} <span style={{ color: 'var(--a-text-muted)', fontWeight: 500 }}>({c.d7Pct}%)</span>
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
      <Panel title="Menu sections" icon={Compass}>
        <EmptyState icon={Compass} title="No menu navigation recorded yet" hint="One menu.section event fires per screen opened." />
      </Panel>
    )
  }
  const max = Math.max(1, ...report.menu.map((m) => m.count))
  return (
    <Panel title="Menu sections" icon={Compass} note="most opened first">
      <div className="a-scroll-x max-h-[300px] overflow-y-auto">
        <table className="a-table">
          <thead>
            <tr>
              <th>Section</th>
              <th style={{ width: '45%' }}>Share</th>
              <th className="a-num">Opens</th>
            </tr>
          </thead>
          <tbody>
            {report.menu.map((m) => (
              <tr key={m.section}>
                <td className="a-key a-mono">{m.section}</td>
                <td>
                  <Bar fraction={m.count / max} />
                </td>
                <td className="a-num">{m.count.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

// Ascending, and every catalog name is accounted for including the zero-count ones. A feature with no
// events at all is the most rarely used thing we ship, so it leads, but as a chip grid: it is a list of
// names, and rendering it as forty table rows whose only number is 0 buries the ones that did fire.
function Events({ report, days }: { report: UsageReport; days: number }) {
  const [showAll, setShowAll] = useState(false)
  const unused = report.events.filter((e) => e.count === 0)
  const used = report.events.filter((e) => e.count > 0)
  const rows = showAll ? used : used.slice(0, 20)
  const max = Math.max(1, ...used.map((e) => e.count))

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Panel
        title="Events in use"
        icon={Activity}
        note={`least used first · ${report.totalEvents.toLocaleString()} in ${days} days`}
        action={
          used.length > 20 && (
            <button type="button" className="a-btn" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show 20' : `Show all ${used.length}`}
            </button>
          )
        }
      >
        <TableScroll minWidth={520}>
        <table className="a-table">
          <thead>
            <tr>
              <th>Event</th>
              <th style={{ width: '38%' }}>Share</th>
              <th className="a-num">Count</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.name}>
                <td className="a-key a-mono">{e.name}</td>
                <td>
                  <Bar fraction={e.count / max} />
                </td>
                <td className="a-num">{e.count.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </TableScroll>
      </Panel>

      <Panel title="Never fired" icon={CircleSlash} note={`${unused.length} of ${report.events.length} catalog names`}>
        {unused.length === 0 ? (
          <EmptyState icon={Activity} title="Every catalog event fired at least once" hint="Nothing shipped dark in this window." />
        ) : (
          <>
            <p className="border-b px-4 py-2.5" style={{ borderColor: 'var(--a-border)', color: 'var(--a-text-2)', fontSize: 12 }}>
              Either nobody uses that feature, or it shipped without a <span className="a-mono">track()</span> call. Those two look
              identical from here, so check the call site before you cut anything.
            </p>
            <div className="flex flex-wrap gap-1.5 p-4">
              {unused.map((e) => (
                <span key={e.name} className="a-badge a-badge-neutral a-mono" style={{ textTransform: 'none', letterSpacing: 0 }}>
                  {e.name}
                </span>
              ))}
            </div>
          </>
        )}
      </Panel>
    </div>
  )
}
