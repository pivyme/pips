// Settings is a drawer, not a fifth page.
//
// Rendered entirely from what GET /admin/settings returns, so adding a knob is one line in the backend's
// SETTINGS const and never a UI edit. That is the whole point: the form cannot offer a key that does not
// exist, and it cannot forget one that does.

import { useQueryClient, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { saveSetting, settingsQuery } from '../queries'
import type { SettingRow } from '../types'
import { Badge, ErrorState, LoadingState } from './primitives'

export function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const q = useQuery(settingsQuery())
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    panel.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const rows = q.data?.settings ?? []
  const product = rows.filter((r) => !r.label)
  const thresholds = rows.filter((r) => r.label)

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Settings">
      <button type="button" className="absolute inset-0 cursor-default" style={{ background: 'rgb(0 0 0 / 0.6)' }} onClick={onClose} aria-label="Close settings" />
      <div
        ref={panel}
        tabIndex={-1}
        className="a-overlay relative flex w-full max-w-[520px] flex-col overflow-hidden"
        style={{ borderRadius: 0, borderRight: 'none', borderTop: 'none', borderBottom: 'none' }}
      >
        <header className="flex h-11 shrink-0 items-center justify-between border-b px-4" style={{ borderColor: 'var(--a-border)' }}>
          <span className="a-section-title">Settings</span>
          <button type="button" className="a-btn" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {q.isPending && <LoadingState label="Reading the settings schema" />}
          {q.isError && <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />}
          {q.data && (
            <>
              <Group title="Product" rows={product} />
              <Group title="Detector thresholds" rows={thresholds} />
            </>
          )}
        </div>

        <footer className="shrink-0 border-t px-4 py-2.5" style={{ borderColor: 'var(--a-border)', color: 'var(--a-text-3)', fontSize: 12 }}>
          Stored in the database, applied within 30 seconds on every instance. No redeploy.
        </footer>
      </div>
    </div>
  )
}

function Group({ title, rows }: { title: string; rows: SettingRow[] }) {
  if (!rows.length) return null
  return (
    <section className="flex flex-col">
      <div className="sticky top-0 border-b px-4 py-2" style={{ background: 'var(--a-overlay)', borderColor: 'var(--a-border)' }}>
        <span className="a-label">{title}</span>
      </div>
      {rows.map((row) => (
        <SettingField key={row.key} row={row} />
      ))}
    </section>
  )
}

function SettingField({ row }: { row: SettingRow }) {
  const client = useQueryClient()
  const [draft, setDraft] = useState(String(row.value))
  const [state, setState] = useState<{ kind: 'idle' | 'saving' | 'saved' | 'error'; message?: string }>({ kind: 'idle' })

  // The server is the source of truth, so a refetch (or another admin's change) wins over a stale draft.
  useEffect(() => {
    setDraft(String(row.value))
  }, [row.value])

  const apply = async (value: boolean | number) => {
    setState({ kind: 'saving' })
    try {
      await saveSetting(row.key, value)
      setState({ kind: 'saved' })
      await client.invalidateQueries({ queryKey: ['admin', 'settings'] })
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : 'Could not save' })
      setDraft(String(row.value))
    }
  }

  const onBlur = () => {
    const next = Number(draft)
    if (!Number.isFinite(next) || next === row.value) {
      setDraft(String(row.value))
      return
    }
    void apply(next)
  }

  const range = row.min != null && row.max != null ? `${row.min} to ${row.max}` : null
  const changed = row.value !== row.def

  return (
    <div className="flex items-start gap-3 border-b px-4 py-2.5" style={{ borderColor: 'var(--a-border)' }}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span style={{ color: 'var(--a-text)' }}>{row.label ?? row.key}</span>
          {row.destructive && <Badge tone="warn">deletes rows</Badge>}
        </div>
        <span style={{ color: 'var(--a-text-3)', fontSize: 12 }}>
          {row.label ? row.key : null}
          {row.label && ' · '}
          default {String(row.def)}
          {range && ` · ${range}`}
        </span>
        {state.kind === 'error' && (
          <span style={{ color: 'var(--a-critical)', fontSize: 12 }} role="alert">
            {state.message}
          </span>
        )}
        {row.destructive && state.kind !== 'error' && (
          <span style={{ color: 'var(--a-text-3)', fontSize: 12 }}>Lowering this deletes rows, so it needs a typed confirmation.</span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {changed && (
          <button type="button" className="a-btn" onClick={() => void apply(row.def)} disabled={state.kind === 'saving'} title={`Reset to ${String(row.def)}`}>
            Reset
          </button>
        )}
        {row.type === 'bool' ? (
          <button
            type="button"
            className={`a-btn ${row.value ? 'a-btn-primary' : ''}`}
            onClick={() => void apply(!row.value)}
            disabled={state.kind === 'saving'}
            aria-pressed={row.value === true}
          >
            {row.value ? 'On' : 'Off'}
          </button>
        ) : (
          <input
            className="a-input w-[104px] text-right"
            inputMode="numeric"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={onBlur}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            disabled={state.kind === 'saving' || row.destructive}
            aria-label={row.key}
          />
        )}
      </div>
    </div>
  )
}
