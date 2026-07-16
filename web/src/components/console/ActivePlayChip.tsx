import { useMatchRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import toast from 'react-hot-toast'
import type { Game, PlayStatus } from '@/lib/api'
import { PLAY_TERMINAL, useActivePlay } from '@/lib/activePlay'
import { haptic } from '@/lib/haptics'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { cnm } from '@/utils/style'

const GAME_LABEL: Record<Game, string> = { lucky: 'Lucky', range: 'Range', moonshot: 'Moonshot' }

const STATUS_LABEL: Partial<Record<PlayStatus, string>> = {
  pending: 'Opening',
  open: 'Live',
  won: 'Won',
  lost: 'Lost',
  cashed_out: 'Cashed out',
}

// A floating "you have a play resolving elsewhere" pill, chrome around the device (App Surface
// language, not the screen), so it renders identically whether you're on Home, in the Menu drawer, or
// on a different game. Hidden while you're actually looking at the game it belongs to, that screen
// already has its own rich live/settling UI. Also owns the off-screen settle notification: the one
// moment worth interrupting you for is the instant a play you walked away from resolves.
export function ActivePlayChip() {
  const { active } = useActivePlay()
  const matchRoute = useMatchRoute()
  const navigate = useNavigate()
  const reduced = useReducedMotion()
  const onOwnRoute = active != null && Boolean(matchRoute({ to: `/games/${active.game}` }))
  const notifiedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!active?.status || onOwnRoute || active.status === 'error') return
    if (!PLAY_TERMINAL.has(active.status)) return
    const key = `${active.id}:${active.status}`
    if (notifiedRef.current === key) return
    notifiedRef.current = key
    const pnl = active.pnl != null ? parseFloat(active.pnl) : 0
    const label = GAME_LABEL[active.game]
    const sign = pnl >= 0 ? '+' : '-'
    const msg = `${label} settled — ${sign}$${Math.abs(pnl).toFixed(2)}`
    haptic(active.status === 'lost' ? 'error' : 'success')
    if (active.status === 'lost') toast(msg, { id: 'activeplay-settle' })
    else toast.success(msg, { id: 'activeplay-settle' })
  }, [active?.id, active?.status, active?.pnl, active?.game, onOwnRoute])

  if (!active || onOwnRoute) return null

  const label = GAME_LABEL[active.game]
  const status = active.status
  const statusLabel = status ? (STATUS_LABEL[status] ?? 'Live') : 'Live'
  const pnl = active.pnl != null ? parseFloat(active.pnl) : null
  const terminal = status != null && PLAY_TERMINAL.has(status) && status !== 'error'

  return (
    <button
      type="button"
      onClick={() => {
        haptic('selection')
        void navigate({ to: `/games/${active.game}` })
      }}
      className="absolute left-1/2 top-[max(10px,env(safe-area-inset-top))] z-[60] flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-surface/95 px-3.5 py-2 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.8)] backdrop-blur-sm transition-transform active:scale-[0.97]"
    >
      <span
        className={cnm(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          !reduced && !terminal && 'motion-safe:animate-pulse',
          terminal ? (pnl != null && pnl < 0 ? 'bg-down' : 'bg-up') : 'bg-brand-500',
        )}
      />
      <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-text">{label}</span>
      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-2">{statusLabel}</span>
      {pnl != null && (
        <span className={cnm('tnum text-[12px] font-extrabold', pnl >= 0 ? 'text-up' : 'text-down')}>
          {pnl >= 0 ? '+' : '-'}${Math.abs(pnl).toFixed(2)}
        </span>
      )}
    </button>
  )
}
