import type { ReactNode } from 'react'
import type { UserStatsDTO } from '@/lib/api'
import { cnm } from '@/utils/style'

// The shareable trader card, styled as a little Pips handheld: a bright amber bezel with a
// branded screen window sunk into it. Shown on the menu home (tap to open the share detail) and
// on the Stats screen (where Share renders the same card to a PNG via shareCard.ts). Keep this and
// the canvas renderer in sync. Presentational, no data fetching.

const commas = (n: number): string => Math.round(n).toLocaleString('en-US')
const shortAddr = (a: string): string => (a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a)

export function StatsCard({
  stats,
  displayName,
  address,
}: {
  stats: UserStatsDTO
  displayName: string
  address: string
}) {
  const net = parseFloat(stats.netPnl)
  const winPct = Math.round(stats.winRate * 100)

  return (
    <div className="trader-bezel overflow-hidden rounded-[26px] p-2.5">
      <CardHeader />
      <div className="trader-screen relative overflow-hidden rounded-[18px] p-5">
        <div className="text-2xl font-extrabold leading-tight text-white">{displayName}</div>
        {address && <div className="tnum mt-1 text-xs text-white/45">{shortAddr(address)}</div>}

        <div className="mt-5 flex items-end justify-between">
          <div>
            <Label>Win rate</Label>
            <div className="text-[52px] font-extrabold leading-none text-brand-400">{winPct}%</div>
          </div>
          <div className="text-right">
            <Label>Net P&L</Label>
            <div className={cnm('tnum text-3xl font-extrabold leading-none', net >= 0 ? 'text-up' : 'text-down')}>
              {net >= 0 ? '+' : '-'}${commas(Math.abs(net))}
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 divide-x divide-white/[0.08] overflow-hidden rounded-xl border border-white/[0.07] bg-black/40">
          <Cell label="Plays" value={commas(stats.gamesPlayed)} />
          <Cell label="Volume" value={`$${commas(parseFloat(stats.totalVolume))}`} />
          <Cell label="Streak" value={commas(Math.max(0, stats.currentStreak))} />
        </div>
      </div>
    </div>
  )
}

function CardHeader() {
  return (
    <div className="flex items-center justify-between px-1.5 pb-2.5 pt-1">
      <img src="/assets/logos/pips-horizontal-black.svg" alt="Pips" className="h-6 w-auto" />
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
    <div className="px-3 py-2.5">
      <div className="text-[10px] font-bold uppercase tracking-[0.06em] text-white/55">{label}</div>
      <div className="tnum mt-1 text-[17px] font-extrabold text-white">{value}</div>
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
