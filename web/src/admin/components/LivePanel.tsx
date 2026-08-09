// Who is in the app right now, at the top of Overview. Every other number on this page is a 7-day
// average; this one answers "is anyone here", which is the question you actually open the tab for.
//
// Two tiers on purpose. LIVE means an open connection, which is exact but in-memory, so a deploy wipes it.
// The rest are people who played in the last 30 minutes, read from Postgres, which is what keeps the panel
// from reading "0 online" thirty seconds after a restart while people are mid-round.

import { useQuery } from '@tanstack/react-query'
import { Radio } from 'lucide-react'

import { Avatar } from '@/components/Avatar'
import { liveQuery } from '../queries'
import type { LiveReport, LiveRow } from '../types'
import { TimeSeriesChart } from './charts'
import { Badge, EmptyState, ErrorState, LoadingState, Panel, TableScroll } from './primitives'

const usd = (n: number): string => `$${n.toFixed(2)}`
const plain = (n: number): string => String(Math.round(n))

const MINUTE = 60_000

function ago(ms: number, now: number): string {
  const d = Math.max(0, now - ms)
  if (d < MINUTE) return 'just now'
  const mins = Math.floor(d / MINUTE)
  if (mins < 60) return `${mins}m ago`
  return `${Math.floor(mins / 60)}h ago`
}

function held(since: number, now: number): string {
  const mins = Math.floor(Math.max(0, now - since) / MINUTE)
  if (mins < 1) return 'just arrived'
  if (mins < 60) return `here ${mins}m`
  return `here ${Math.floor(mins / 60)}h`
}

export function LivePanel() {
  const { data, isPending, error, refetch } = useQuery(liveQuery())

  const note = data ? `last ${data.windowMin} min · refreshes every 5s` : 'last 30 min'

  return (
    <Panel
      title="Live"
      icon={Radio}
      note={note}
      action={
        data ? (
          <span className="a-dot" style={{ background: 'var(--a-ok)', color: 'var(--a-ok)' }} aria-hidden />
        ) : null
      }
    >
      {isPending ? (
        <LoadingState label="Reading who is online" rows={4} />
      ) : error || !data ? (
        // A blank panel reads as "nobody is playing", which is the worst thing it could say when the read
        // itself is what failed.
        <ErrorState message="Could not read who is online" onRetry={() => void refetch()} />
      ) : (
        <Body data={data} />
      )}
    </Panel>
  )
}

function Body({ data }: { data: LiveReport }) {
  const now = Date.parse(data.generatedAt)
  const { online, window: w } = data

  return (
    <>
      {/* 340px, not 280: three money tiles in a narrower column truncate "$25.75" to "$25...". */}
      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3">
          <div className="a-well flex flex-col gap-1.5 p-3">
            <span className="a-label">Online now</span>
            <span className="a-metric" style={{ color: online.users ? 'var(--a-ok)' : 'var(--a-text-3)' }}>
              {online.users}
            </span>
            <span style={{ color: 'var(--a-text-3)', fontSize: 12 }}>
              {online.users === 0
                ? 'nobody has the app open'
                : `${online.users} ${online.users === 1 ? 'person' : 'people'} across ${online.sessions} open ${online.sessions === 1 ? 'session' : 'sessions'}`}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <MiniStat label="Players" value={String(w.players)} hint={`in ${data.windowMin}m`} />
            <MiniStat label="Plays" value={String(w.plays)} hint={`in ${data.windowMin}m`} />
            <MiniStat label="Staked" value={usd(w.staked)} hint="DUSDC" />
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <span className="a-label">Plays per minute</span>
          <TimeSeriesChart
            series={[{ name: 'Plays', tone: 'accent', points: data.playsPerMinute.map((p) => ({ t: p.t, v: p.n })) }]}
            kind="bar"
            unit="minute"
            height={132}
            format={plain}
            label={`Plays per minute over the last ${data.windowMin} minutes, ${w.plays} in total`}
          />
        </div>
      </div>

      {data.rows.length === 0 ? (
        <EmptyState
          title="No one in the app right now"
          hint={`Nobody has an open session, and nobody has played in the last ${data.windowMin} minutes. That is a real zero, not a failed read.`}
        />
      ) : (
        <>
          <TableScroll minWidth={720}>
            <table className="a-table">
              <thead>
                <tr>
                  <th className="a-cell-fill">Player</th>
                  <th>Status</th>
                  <th>Doing</th>
                  <th className="a-num">Plays</th>
                  <th className="a-num">Staked</th>
                  <th className="a-num">P&amp;L</th>
                  <th>Device</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <Row key={r.id} row={r} now={now} />
                ))}
              </tbody>
            </table>
          </TableScroll>
          <p className="px-4 py-2.5" style={{ color: 'var(--a-text-3)', fontSize: 12 }}>
            {data.truncated > 0 ? `Showing ${data.rows.length} of ${data.rows.length + data.truncated}. ` : ''}
            LIVE is an open app session. The rest played in the last {data.windowMin} minutes.
            <span className="a-scroll-hint"> Scroll the table sideways for the numbers.</span>
          </p>
        </>
      )}
    </>
  )
}

function MiniStat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="a-well flex min-w-0 flex-col gap-1 p-2.5">
      <span className="a-label truncate">{label}</span>
      <span className="a-metric-sm truncate">{value}</span>
      <span className="truncate" style={{ color: 'var(--a-text-muted)', fontSize: 11 }}>
        {hint}
      </span>
    </div>
  )
}

function Row({ row, now }: { row: LiveRow; now: number }) {
  const name = row.username ?? row.displayName
  const pnlColor = row.pnl > 0 ? 'var(--a-ok)' : row.pnl < 0 ? 'var(--a-critical)' : undefined

  return (
    <tr>
      <td className="a-cell-fill">
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={name} src={row.avatarUrl} size={24} />
          <span className="a-key truncate">{name}</span>
        </span>
      </td>
      <td>
        {row.live ? (
          <span className="flex items-center gap-2">
            <Badge tone="ok">Live</Badge>
            <span style={{ color: 'var(--a-text-3)', fontSize: 11, whiteSpace: 'nowrap' }}>
              {row.since != null ? held(row.since, now) : ''}
              {row.sessions > 1 ? ` · ${row.sessions} tabs` : ''}
            </span>
          </span>
        ) : (
          <span style={{ color: 'var(--a-text-3)', whiteSpace: 'nowrap' }}>{ago(row.lastSeenAt, now)}</span>
        )}
      </td>
      <td>
        <span className="a-mono" style={{ whiteSpace: 'nowrap' }}>
          {row.doing}
        </span>
      </td>
      <td className="a-num">{row.plays}</td>
      <td className="a-num">{row.staked ? usd(row.staked) : '—'}</td>
      <td className="a-num" style={pnlColor ? { color: pnlColor } : undefined}>
        {row.plays ? usd(row.pnl) : '—'}
      </td>
      <td style={{ color: 'var(--a-text-3)', whiteSpace: 'nowrap' }}>{row.platform ?? 'unknown'}</td>
    </tr>
  )
}
