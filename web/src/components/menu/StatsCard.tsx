import { Pencil } from 'lucide-react'
import type { ReactNode } from 'react'
import type { UserStatsDTO } from '@/lib/api'
import { Avatar } from '@/components/Avatar'
import { cnm } from '@/utils/style'
import { formatCompactCount, formatCompactMoney } from '@/utils/format'

// The shareable trader card, styled as a little PIPS handheld: a bright amber bezel with a
// branded screen window sunk into it. Shown on the menu home (tap to open the share detail) and
// on the Stats screen (where Share renders the same card to a PNG via shareCard.ts). Keep this and
// the canvas renderer in sync. Presentational, no data fetching.

export function StatsCard({
  stats,
  displayName,
  avatarUrl,
  onEdit,
}: {
  stats: UserStatsDTO
  displayName: string
  // The effective avatar (custom or DiceBear default); a letter chip renders when absent.
  avatarUrl?: string | null
  // When set, a pen sits next to the handle so it can be changed. Omitted on the shareable card.
  onEdit?: () => void
}) {
  const net = parseFloat(stats.netPnl)
  const winPct = Math.round(stats.winRate * 100)

  return (
    // @container: the card sizes its text + padding off its OWN width (cqi), not the viewport, so it
    // shrinks gracefully in a narrow drawer instead of the big win-rate + P&L numbers colliding. The
    // clamp maxes match the original sizes, so at a normal width it looks exactly as before.
    <div className="trader-bezel @container overflow-hidden rounded-[26px] p-2.5">
      <CardHeader />
      <div className="trader-screen relative overflow-hidden rounded-[18px] p-[clamp(13px,5cqi,20px)]">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-[clamp(8px,3cqi,12px)]">
            <Avatar
              name={displayName}
              src={avatarUrl}
              size={44}
              className="shrink-0 ring-1 ring-white/15"
            />
            <div className="min-w-0 truncate text-[clamp(17px,6cqi,24px)] font-extrabold leading-tight text-white">{displayName}</div>
          </div>
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              aria-label="Change your handle"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.1] text-white/80 transition active:scale-90"
            >
              <Pencil className="h-[18px] w-[18px]" strokeWidth={2.4} />
            </button>
          )}
        </div>

        <div className="mt-[clamp(12px,5cqi,20px)] flex items-end justify-between gap-3">
          <div className="min-w-0">
            <Label>Win rate</Label>
            <div className="text-[clamp(32px,13cqi,52px)] font-extrabold leading-none text-brand-400">{winPct}%</div>
          </div>
          <div className="min-w-0 text-right">
            <Label>Net P&L</Label>
            <div className={cnm('tnum truncate text-[clamp(18px,7.5cqi,30px)] font-extrabold leading-none', net >= 0 ? 'text-up' : 'text-down')}>
              {net >= 0 ? '+' : '-'}${formatCompactMoney(stats.netPnl)}
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 divide-x divide-white/[0.08] overflow-hidden rounded-xl border border-white/[0.07] bg-black/40">
          <Cell label="Plays" value={formatCompactCount(stats.gamesPlayed)} />
          <Cell label="Volume" value={`$${formatCompactMoney(stats.totalVolume)}`} />
          <Cell label="Streak" value={formatCompactCount(Math.max(0, stats.currentStreak))} />
        </div>
      </div>
    </div>
  )
}

function CardHeader() {
  return (
    <div className="flex items-center justify-between px-1.5 pb-2.5 pt-1">
      <img src="/assets/logos/pips-horizontal-black.svg" alt="PIPS" className="h-6 w-auto" />
      <span
        className="text-[10px] font-extrabold uppercase tracking-[0.18em]"
        style={{ color: 'rgba(46,30,0,0.58)', textShadow: '0 1px 0 rgba(255,255,255,0.28)' }}
      >
        Player Card
      </span>
    </div>
  )
}

function Label({ children }: { children: ReactNode }) {
  return <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-white/55">{children}</div>
}

function Cell({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="min-w-0 px-[clamp(8px,3cqi,12px)] py-2.5">
      <div className="text-[10px] font-bold uppercase tracking-[0.06em] text-white/55">{label}</div>
      <div className="tnum mt-1 truncate text-[clamp(13px,4.3cqi,17px)] font-extrabold text-white">{value}</div>
    </div>
  )
}

export function StatsCardSkeleton() {
  return (
    <div className="trader-bezel overflow-hidden rounded-[26px] p-2.5">
      <CardHeader />
      <div className="trader-screen rounded-[18px] p-5">
        <div className="shimmer h-7 w-40 rounded-lg" />
        <div className="shimmer mt-2 h-4 w-28 rounded-md" />
        <div className="mt-5 flex justify-between">
          <div className="shimmer h-12 w-28 rounded-lg" />
          <div className="shimmer h-9 w-24 rounded-lg" />
        </div>
        <div className="shimmer mt-4 h-[60px] rounded-xl" />
      </div>
    </div>
  )
}
