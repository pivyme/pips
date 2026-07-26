// The page you open when something breaks. Grouped list on the left, one bug's detail on the right, and
// a Copy AI brief button that is the whole reason this system is in-house.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { BarChart, EmptyState, ErrorState, LevelBadge, LoadingState, Panel, StatusBadge, Trend, When } from './components/primitives'
import { errorDetailQuery, errorsQuery, fetchBrief, setErrorStatus, type ErrorFilters } from './queries'
import type { ErrorStatus } from './types'

const STATUSES = ['open', 'ack', 'resolved', 'ignored', 'all']
const LEVELS = ['', 'fatal', 'error', 'warn']
const KINDS = ['', 'http', 'worker', 'chain', 'client', 'job']

export function ErrorsPage() {
  const [filters, setFilters] = useState<ErrorFilters>({ status: 'open', level: '', kind: '' })
  const [selected, setSelected] = useState<string | null>(null)
  const list = useQuery(errorsQuery(filters))

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="a-page-title">Errors</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Select label="Status" value={filters.status} options={STATUSES} onChange={(status) => setFilters((f) => ({ ...f, status }))} />
          <Select label="Level" value={filters.level} options={LEVELS} onChange={(level) => setFilters((f) => ({ ...f, level }))} />
          <Select label="Kind" value={filters.kind} options={KINDS} onChange={(kind) => setFilters((f) => ({ ...f, kind }))} />
        </div>
      </header>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,520px)]">
        <Panel title={`${list.data?.groups.length ?? 0} groups`}>
          {list.isPending ? (
            <LoadingState label="Loading error groups" />
          ) : list.isError ? (
            <ErrorState message="Could not load error groups" onRetry={() => void list.refetch()} />
          ) : !list.data.groups.length ? (
            <EmptyState
              title={filters.status === 'open' ? 'Nothing open' : `No ${filters.status} groups`}
              hint={filters.status === 'open' ? 'Every captured bug is acknowledged, resolved, or ignored.' : 'Try a different status filter.'}
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
    <div className="overflow-x-auto">
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
              <td style={{ color: 'var(--a-text)' }}>
                <span className="line-clamp-1">{g.title}</span>
                <span className="block text-[11px]" style={{ color: 'var(--a-text-3)' }}>
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
    </div>
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
      <Panel title="Detail">
        <EmptyState title="Select a group" hint="Its stack, samples, affected users, and AI brief show up here." />
      </Panel>
    )
  }
  if (q.isPending) {
    return (
      <Panel title="Detail">
        <LoadingState label="Loading occurrence detail" />
      </Panel>
    )
  }
  if (q.isError) {
    return (
      <Panel title="Detail">
        <ErrorState message="Could not load this group" onRetry={() => void q.refetch()} />
      </Panel>
    )
  }

  const { group, samples, occurrences, users, plays } = q.data
  const newest = samples[0]

  return (
    <Panel
      title="Detail"
      action={
        <button type="button" className="a-btn a-btn-primary" disabled={brief.isPending} onClick={() => brief.mutate(group.fingerprint)}>
          {copied ? 'Copied' : brief.isPending ? 'Building' : 'Copy AI brief'}
        </button>
      }
    >
      <div className="flex flex-col gap-4 p-4">
        <div>
          <h2 className="a-section-title">{group.title}</h2>
          <p className="mt-1 text-[11px]" style={{ color: 'var(--a-text-3)' }}>
            {group.fingerprint}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={group.status} />
          <LevelBadge level={group.level} />
          <span className="a-badge a-badge-neutral">{group.kind}</span>
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

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
          <Field label="Occurrences" value={group.count.toLocaleString()} />
          <Field label="Users affected" value={group.usersAffected.toLocaleString()} />
          <Field label="First release" value={group.firstRelease ?? 'unknown'} />
          <Field label="Last release" value={group.lastRelease ?? 'unknown'} />
          <Field label="Culprit" value={group.culprit ?? 'unknown'} />
          <Field label="Network" value={newest?.network ?? 'unknown'} />
        </dl>

        <div>
          <p className="a-label mb-1.5">Occurrences, last 24h (retained samples)</p>
          <BarChart data={occurrences} />
        </div>

        <div>
          <p className="a-label mb-1.5">Message</p>
          <p className="a-pre">{newest?.message ?? group.title}</p>
        </div>

        {newest?.stack && (
          <div>
            <p className="a-label mb-1.5">Stack, own-code frames marked</p>
            <StackView stack={newest.stack} />
          </div>
        )}

        {!!users.length && (
          <div>
            <p className="a-label mb-1.5">Affected users</p>
            <p style={{ color: 'var(--a-text-2)' }}>{users.map((u) => (u.username ? `@${u.username}` : u.id)).join(', ')}</p>
          </div>
        )}

        {!!plays.length && (
          <div>
            <p className="a-label mb-1.5">Affected plays</p>
            <p className="a-pre">{plays.map((p) => `${p.game} ${p.id} (${p.status})`).join('\n')}</p>
          </div>
        )}
      </div>
    </Panel>
  )
}

// Own-code frames carry the accent, vendor frames recede. Rendered as text, never as HTML.
function StackView({ stack }: { stack: string }) {
  const lines = stack.split('\n').slice(0, 14)
  return (
    <div className="a-pre">
      {lines.map((line, i) => {
        const own = line.trim().startsWith('at ') && !line.includes('node_modules') && !line.includes('node:internal')
        return (
          <div key={i} style={{ color: own ? 'var(--a-text)' : 'var(--a-text-3)' }}>
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
      <dd className="truncate" style={{ color: 'var(--a-text)' }} title={value}>
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
