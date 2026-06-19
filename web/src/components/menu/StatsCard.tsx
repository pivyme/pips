import type { ReactNode } from 'react'
import type { UserStatsDTO } from '@/lib/api'
import { cnm } from '@/utils/style'

// The shareable trader card, styled as a little Pips handheld: a bright amber bezel with a
// branded screen window sunk into it. Shown on the menu home (tap to open the share detail) and
// on the Stats screen (where Share renders the same card to a PNG via shareCard.ts). Keep this and
// the canvas renderer in sync. Presentational, no data fetching.

const commas = (n: number): string => Math.round(n).toLocaleString('en-US')
const shortAddr = (a: string): string => (a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a)

const INK = '#1a1200' // pressed-amber ink, same as the commit button face

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

        <div className="mt-4 flex items-end justify-between border-t border-white/10 pt-4">
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

        <div className="mt-4 grid grid-cols-4 gap-2">
          <Cell label="Plays" value={commas(stats.gamesPlayed)} />
          <Cell label="Volume" value={`$${commas(parseFloat(stats.totalVolume))}`} />
          <Cell label="Streak" value={commas(stats.currentStreak)} />
          <Cell label="Best" value={commas(stats.maxStreak)} />
        </div>
      </div>
    </div>
  )
}

function CardHeader() {
  return (
    <div className="flex items-center justify-between px-1.5 pb-2.5 pt-1">
      <div className="flex items-center gap-2">
        <span
          className="flex h-6 w-6 items-center justify-center rounded-[7px]"
          style={{ background: INK, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.14)' }}
        >
          <img src="/assets/logos/pips-512.png" alt="" className="h-[18px] w-[18px]" />
        </span>
        <span className="text-[15px] font-extrabold tracking-tight" style={{ color: INK }}>
          PIPS
        </span>
      </div>
      <span
        className="text-[10px] font-extrabold uppercase tracking-[0.18em]"
        style={{ color: 'rgba(46,30,0,0.58)', textShadow: '0 1px 0 rgba(255,255,255,0.28)' }}
      >
        Trader Card
      </span>
    </div>
  )
}

function Label({ children }: { children: ReactNode }) {
  return <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-white/55">{children}</div>
}

function Cell({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="rounded-lg border border-white/[0.07] bg-black/40 p-2.5">
      <div className="text-[9px] font-bold uppercase tracking-[0.06em] text-white/55">{label}</div>
      <div className="tnum mt-1 text-sm font-extrabold text-white">{value}</div>
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
        <div className="mt-4 flex justify-between border-t border-white/10 pt-4">
          <div className="shimmer h-12 w-28 rounded-lg" />
          <div className="shimmer h-9 w-24 rounded-lg" />
        </div>
        <div className="mt-4 grid grid-cols-4 gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="shimmer h-14 rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  )
}
