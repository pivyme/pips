// The page you open when something breaks. Grouped list on the left, one bug's detail on the right, and
// a Copy AI brief button that is the whole reason this system is in-house.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bug, CheckCircle2, ClipboardCopy, MousePointerClick } from 'lucide-react'
import { useState } from 'react'

import { TimeSeriesChart } from './components/charts'
import {
  EmptyState,
  ErrorState,
  LevelBadge,
  LoadingState,
  Panel,
  PageHeader,
  Segmented,
  StatusBadge,
  TableScroll,
  Trend,
  When,
} from './components/primitives'
import { errorDetailQuery, errorsQuery, fetchBrief, setErrorStatus, type ErrorFilters } from './queries'
import type { ErrorStatus } from './types'

const STATUSES = ['open', 'ack', 'resolved', 'ignored', 'all'].map((v) => ({ value: v, label: v }))
const LEVELS = ['', 'fatal', 'error', 'warn']
const KINDS = ['', 'http', 'worker', 'chain', 'client', 'job']

export function ErrorsPage() {
  const [filters, setFilters] = useState<ErrorFilters>({ status: 'open', level: '', kind: '' })
  const [selected, setSelected] = useState<string | null>(null)
  const list = useQuery(errorsQuery(filters))

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Errors" sub="Grouped by fingerprint, so a hundred occurrences of one bug are one row.">
        <Segmented value={filters.status} options={STATUSES} onChange={(status) => setFilters((f) => ({ ...f, status }))} label="Status" />
        <Select label="Level" value={filters.level} options={LEVELS} onChange={(level) => setFilters((f) => ({ ...f, level }))} />
        <Select label="Kind" value={filters.kind} options={KINDS} onChange={(kind) => setFilters((f) => ({ ...f, kind }))} />
      </PageHeader>

      {/* items-start: a three-row list next to a long detail should not stretch into 800px of empty panel. */}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,560px)]">
        <Panel title="Groups" icon={Bug} note={list.data ? `${list.data.groups.length} in view` : undefined}>
          {list.isPending ? (
            <LoadingState label="Loading error groups" rows={6} />
          ) : list.isError ? (
            <ErrorState message="Could not load error groups" onRetry={() => void list.refetch()} />
          ) : !list.data.groups.length ? (
            <EmptyState
              icon={CheckCircle2}
              title={filters.status === 'open' ? 'Nothing open' : `No ${filters.status} groups`}
              hint={
                filters.status === 'open'
                  ? `Every captured bug is acknowledged, resolved, or ignored. ${resolvedCopy(list.data.resolvedThisWeek)}`
                  : 'Try a different status filter.'
              }
            />
          ) : (
            <GroupTable groups={list.data.groups} selected={selected} onSelect={setSelected} />
          )}
        </Panel>

        <Detail fingerprint={selected} />
      </div>
    </div>
  )
}

// An empty list should prove the pipeline is alive, not just report an absence: "nothing open" reads the
// same whether the product is healthy or capture stopped working a week ago.
function resolvedCopy(n: number): string {
  if (!n) return 'Nothing resolved in the last 7 days either, so check that capture is still reporting.'
  return `${n} group${n === 1 ? '' : 's'} resolved in the last 7 days.`
}

function GroupTable({
  groups,
  selected,
  onSelect,
}: {
  groups: Array<import('./types').ErrorGroupRow>
  selected: string | null
  onSelect: (fp: string) => void
}) {
  return (
    <TableScroll minWidth={720}>
      <table className="a-table">
        <thead>
          <tr>
            <th>Title</th>
            <th className="hidden md:table-cell">Kind</th>
            <th>Level</th>
            <th className="a-num">Count</th>
            <th className="a-num hidden md:table-cell">Users</th>
            <th className="hidden sm:table-cell">Last seen</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr
              key={g.fingerprint}
              className="a-row"
              aria-selected={selected === g.fingerprint}
              onClick={() => onSelect(g.fingerprint)}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(g.fingerprint)
                }
              }}
            >
              {/* Truncate, not line-clamp: a title is often one unbroken token (`module::function::code`),
                  and line-clamp has nothing to wrap on, so it collapses to the first word. */}
              <td className="a-key a-cell-fill" style={{ paddingTop: 6, paddingBottom: 6 }} title={g.title}>
                <span className="block truncate">{g.title}</span>
                <span className="a-mono block truncate" style={{ color: 'var(--a-text-muted)' }}>
                  {g.fingerprint}
                </span>
              </td>
              <td className="hidden md:table-cell">{g.kind}</td>
              <td>
                <LevelBadge level={g.level} />
              </td>
              <td className="a-num">{g.count.toLocaleString()}</td>
              <td className="a-num hidden md:table-cell">{g.usersAffected.toLocaleString()}</td>
              <td className="hidden sm:table-cell">
                <When iso={g.lastSeen} />
              </td>
              <td className="a-num">
                <Trend trend={g.trend} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  )
}

function Detail({ fingerprint }: { fingerprint: string | null }) {
  const qc = useQueryClient()
  const q = useQuery(errorDetailQuery(fingerprint))
  const [copied, setCopied] = useState(false)

  const status = useMutation({
    mutationFn: ({ fp, next }: { fp: string; next: ErrorStatus }) => setErrorStatus(fp, next),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'errors'] })
      void qc.invalidateQueries({ queryKey: ['admin', 'error', fingerprint] })
    },
  })

  const brief = useMutation({
    mutationFn: (fp: string) => fetchBrief(fp),
    onSuccess: async (text) => {
      try {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      } catch {
        // Clipboard needs a secure context and a user gesture; open the raw markdown so it is never lost.
        window.open(URL.createObjectURL(new Blob([text], { type: 'text/markdown' })), '_blank')
      }
    },
  })

  if (!fingerprint) {
    return (
      <Panel title="Detail" icon={MousePointerClick}>
        <EmptyState icon={MousePointerClick} title="Select a group" hint="Its stack, samples, affected users, and AI brief show up here." />
      </Panel>
    )
  }
  if (q.isPending) {
    return (
      <Panel title="Detail" icon={Bug}>
        <LoadingState label="Loading occurrence detail" rows={7} />
      </Panel>
    )
  }
  if (q.isError) {
    return (
      <Panel title="Detail" icon={Bug}>
        <ErrorState message="Could not load this group" onRetry={() => void q.refetch()} />
      </Panel>
    )
  }

  const { group, samples, occurrences, users, plays } = q.data
  const newest = samples[0]

  return (
    <Panel
      title="Detail"
      icon={Bug}
      action={
        <button
          type="button"
          className="a-btn a-btn-primary"
          disabled={brief.isPending}
          onClick={() => brief.mutate(group.fingerprint)}
        >
          <ClipboardCopy size={13} strokeWidth={2.5} />
          {copied ? 'Copied' : brief.isPending ? 'Building' : 'Copy AI brief'}
        </button>
      }
    >
      <div className="flex flex-col gap-4 p-4">
        <div>
          <h2 className="a-section-title">{group.title}</h2>
          <p className="a-mono mt-1" style={{ color: 'var(--a-text-muted)' }}>
            {group.fingerprint}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={group.status} />
          <LevelBadge level={group.level} />
          <span className="a-badge a-badge-neutral">{group.kind}</span>
          <span className="flex-1" />
          {(['ack', 'resolved', 'ignored'] as ErrorStatus[]).map((next) => (
            <button
              key={next}
              type="button"
              className="a-btn"
              disabled={status.isPending || group.status === next}
              onClick={() => status.mutate({ fp: group.fingerprint, next })}
              title={next === 'ignored' ? 'Suppresses alerts until unignored' : undefined}
            >
              {next === 'ack' ? 'Ack' : next === 'resolved' ? 'Resolve' : 'Ignore'}
            </button>
          ))}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Field label="Occurrences" value={group.count.toLocaleString()} />
          <Field label="Users affected" value={group.usersAffected.toLocaleString()} />
          <Field label="Network" value={newest?.network ?? 'unknown'} />
          <Field label="First release" value={group.firstRelease ?? 'unknown'} />
          <Field label="Last release" value={group.lastRelease ?? 'unknown'} />
          <Field label="Culprit" value={group.culprit ?? 'unknown'} />
        </dl>

        <div>
          <p className="a-label mb-2">Occurrences, last 24h (retained samples)</p>
          <TimeSeriesChart
            series={[{ name: 'Occurrences', tone: 'neutral', points: occurrences.map((o) => ({ t: o.t, v: o.n })) }]}
            kind="bar"
            unit="hour"
            height={110}
            label={`Occurrences per hour over the last 24 hours, ${occurrences.reduce((sum, o) => sum + o.n, 0)} retained samples`}
          />
        </div>

        <div>
          <p className="a-label mb-2">Message</p>
          <p className="a-pre">{newest?.message ?? group.title}</p>
        </div>

        {newest?.stack && (
          <div>
            <p className="a-label mb-2">Stack, own-code frames marked</p>
            <StackView stack={newest.stack} />
          </div>
        )}

        {!!users.length && (
          <div>
            <p className="a-label mb-2">Affected users</p>
            <p style={{ color: 'var(--a-text-2)' }}>{users.map((u) => (u.username ? `@${u.username}` : u.id)).join(', ')}</p>
          </div>
        )}

        {!!plays.length && (
          <div>
            <p className="a-label mb-2">Affected plays</p>
            <p className="a-pre">{plays.map((p) => `${p.game} ${p.id} (${p.status})`).join('\n')}</p>
          </div>
        )}
      </div>
    </Panel>
  )
}

// Own-code frames carry full contrast, vendor frames recede. Rendered as text, never as HTML.
function StackView({ stack }: { stack: string }) {
  const lines = stack.split('\n').slice(0, 14)
  return (
    <div className="a-pre a-well">
      {lines.map((line, i) => {
        const own = line.trim().startsWith('at ') && !line.includes('node_modules') && !line.includes('node:internal')
        return (
          <div key={i} style={{ color: own ? 'var(--a-text)' : 'var(--a-text-muted)' }}>
            {own ? '> ' : '  '}
            {line.trim()}
          </div>
        )
      })}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="a-label">{label}</dt>
      <dd className="truncate" style={{ color: 'var(--a-text)', fontWeight: 600 }} title={value}>
        {value}
      </dd>
    </div>
  )
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="a-label">{label}</span>
      <select className="a-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o || 'any'} value={o}>
            {o || 'any'}
          </option>
        ))}
      </select>
    </label>
  )
}
