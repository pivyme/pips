// Settings is a drawer, not a fifth page.
//
// Rendered entirely from what GET /admin/settings returns, so adding a knob is one line in the backend's
// SETTINGS const and never a UI edit. That is the whole point: the form cannot offer a key that does not
// exist, and it cannot forget one that does.

import { useQueryClient, useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Hw3DToggle } from '@/ui/Hardware3D'
import { previewSetting, saveSetting, settingsQuery } from '../queries'
import type { RetentionPreview, SettingRow } from '../types'
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
      <button type="button" className="absolute inset-0 cursor-default" style={{ background: 'var(--a-scrim)' }} onClick={onClose} aria-label="Close settings" />
      <div
        ref={panel}
        tabIndex={-1}
        className="a-overlay relative flex w-full max-w-[520px] flex-col overflow-hidden"
        style={{
          borderRadius: 0,
          borderRight: 'none',
          borderTop: 'none',
          borderBottom: 'none',
          // Full-height panel: its header owns the viewport top, so it carries the notch inset itself.
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        <header className="flex h-14 shrink-0 items-center justify-between border-b px-4" style={{ borderColor: 'var(--a-border)' }}>
          <div className="flex flex-col">
            <span className="a-section-title">Settings</span>
            <span style={{ color: 'var(--a-text-3)', fontSize: 12 }}>Live tunables, no redeploy</span>
          </div>
          <button type="button" className="a-btn" onClick={onClose} aria-label="Close settings">
            <X size={14} strokeWidth={2.6} />
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

  const [pending, setPending] = useState<{ value: number; preview: RetentionPreview } | null>(null)

  const apply = async (value: boolean | number, confirm?: string) => {
    setState({ kind: 'saving' })
    try {
      await saveSetting(row.key, value, confirm)
      setState({ kind: 'saved' })
      setPending(null)
      await client.invalidateQueries({ queryKey: ['admin', 'settings'] })
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : 'Could not save' })
      setDraft(String(row.value))
    }
  }

  // A destructive key never saves on blur. It previews first, and the modal makes you type the exact
  // string the server issued. That is UX; the server recheck is the actual control.
  const onBlur = () => {
    const next = Number(draft)
    if (!Number.isFinite(next) || next === row.value) {
      setDraft(String(row.value))
      return
    }
    if (!row.destructive) {
      void apply(next)
      return
    }
    setState({ kind: 'saving' })
    previewSetting(row.key, next)
      .then((preview) => {
        setState({ kind: 'idle' })
        if (preview.widening) return apply(next)
        setPending({ value: next, preview })
      })
      .catch((e: unknown) => setState({ kind: 'error', message: e instanceof Error ? e.message : 'Could not preview' }))
  }

  const range = row.min != null && row.max != null ? `${row.min} to ${row.max}` : null
  const changed = row.value !== row.def

  return (
    <div className="flex items-start gap-3 border-b px-4 py-2.5" style={{ borderColor: 'var(--a-border)' }}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span style={{ color: 'var(--a-text)', fontWeight: 600 }}>{row.label ?? row.key}</span>
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
        {pending && <ConfirmDelete preview={pending.preview} onCancel={() => setPending(null)} onConfirm={(c) => void apply(pending.value, c)} />}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {changed && (
          <button type="button" className="a-btn" onClick={() => void apply(row.def)} disabled={state.kind === 'saving'} title={`Reset to ${String(row.def)}`}>
            Reset
          </button>
        )}
        {row.type === 'bool' ? (
          <Hw3DToggle
            label={row.label ?? row.key}
            isSelected={row.value === true}
            isDisabled={state.kind === 'saving'}
            onChange={(next) => void apply(next)}
          />
        ) : (
          <input
            className="a-input w-[104px] text-right"
            inputMode="numeric"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={onBlur}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            disabled={state.kind === 'saving'}
            aria-label={row.key}
          />
        )}
      </div>
    </div>
  )
}

// The type-to-confirm box. It shows what is about to go, how far back it reaches, and refuses to enable
// the button until the string matches character for character.
function ConfirmDelete({ preview, onCancel, onConfirm }: { preview: RetentionPreview; onCancel: () => void; onConfirm: (confirm: string) => void }) {
  const [typed, setTyped] = useState('')
  const expected = preview.confirm ?? ''
  const matches = typed.trim() === expected

  return (
    <div className="a-callout-critical mt-2 flex flex-col gap-2">
      <span style={{ color: 'var(--a-critical)', fontWeight: 600 }}>
        {preview.current} to {preview.next} deletes {preview.deletes.toLocaleString('en-US')} {preview.noun}
      </span>
      {preview.oldest && (
        <span style={{ color: 'var(--a-text-3)', fontSize: 12 }}>
          spanning {new Date(preview.oldest).toISOString().slice(0, 10)} to {new Date(preview.newest ?? preview.oldest).toISOString().slice(0, 10)}. This cannot be undone.
        </span>
      )}
      <label className="flex flex-col gap-1" style={{ fontSize: 12, color: 'var(--a-text-2)' }}>
        Type <span style={{ color: 'var(--a-text)', fontFamily: 'ui-monospace, monospace' }}>{expected}</span>
        <input className="a-input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={expected} autoComplete="off" spellCheck={false} />
      </label>
      <div className="flex gap-2">
        <button type="button" className="a-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="a-btn a-btn-primary" disabled={!matches} onClick={() => onConfirm(expected)}>
          Delete {preview.deletes.toLocaleString('en-US')} {preview.noun}
        </button>
      </div>
    </div>
  )
}
