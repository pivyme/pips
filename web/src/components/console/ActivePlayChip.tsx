import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import toast from 'react-hot-toast'
import type { Game, PlayStatus } from '@/lib/api'
import { GameIcon } from '@/components/GameIcon'
import { PLAY_TERMINAL, useActivePlay } from '@/lib/activePlay'
import { haptic, hapticPattern } from '@/lib/haptics'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { cnm } from '@/utils/style'

const GAME_LABEL: Record<Game, string> = {
  lucky: 'Lucky',
  range: 'Range',
  moonshot: 'Moonshot',
  pin: 'Pin',
  snipe: 'Snipe',
  press: 'Press',
  rush: 'Rush',
  breakout: 'Breakout',
}

const STATUS_LABEL: Partial<Record<PlayStatus, string>> = {
  pending: 'Opening',
  open: 'Live',
  won: 'Won',
  lost: 'Lost',
  cashed_out: 'Cashed out',
}

// A floating "play resolving elsewhere" pill, chrome around the device (App Surface language, not the
// screen), shown only on Home or the Menu drawer, never while on a game screen (its own or another
// one, which would just be noise). Still owns the off-screen settle notification everywhere, the one moment worth interrupting for.
export function ActivePlayChip() {
  const { active } = useActivePlay()
  const navigate = useNavigate()
  const reduced = useReducedMotion()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // Compared against the path rather than matchRoute: a lab game may not be in the route tree yet, and a
  // typed `to` would then fail the build for a game that simply is not built.
  const onOwnRoute = active != null && pathname.replace(/\/$/, '') === `/games/${active.game}`
  // Only surface the pill on non-game surfaces (Home hub, menu). While playing any other
  // game, a banner about a different game is just noise, not the one worth interrupting for.
  const onOtherGameRoute = pathname.startsWith('/games/') && !onOwnRoute
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
    hapticPattern(active.status === 'lost' ? 'lose' : active.status === 'cashed_out' ? 'cashOut' : 'win')
    if (active.status === 'lost') toast(msg, { id: 'activeplay-settle' })
    else toast.success(msg, { id: 'activeplay-settle' })
  }, [active?.id, active?.status, active?.pnl, active?.game, onOwnRoute])

  if (!active || onOwnRoute || onOtherGameRoute) return null

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
      <GameIcon game={active.game} size={13} className="text-text" />
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
