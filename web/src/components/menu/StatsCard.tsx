import type { ReactNode } from 'react'
import type { UserStatsDTO } from '@/lib/api'
import { cnm } from '@/utils/style'

// The shareable trader card. ID-card layout on a neumorphic card: handle, the hero win rate, the
// record. Shown right away on the menu home (tap to open the share detail) and on the Stats screen
// (where a Share button renders the same card to a PNG). Presentational, no data fetching.

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
    <div className="surface-skeuo overflow-hidden rounded-card p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <img src="/assets/logos/pips-512.png" alt="" className="h-6 w-6" />
          <span className="text-xs font-extrabold uppercase tracking-[0.16em] text-brand-500">Pips</span>
        </div>
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-text-3">Trader card</span>
      </div>

      <div className="mt-4">
        <div className="text-xl font-extrabold leading-tight">{displayName}</div>
        {address && <div className="tnum mt-0.5 text-xs text-text-3">{shortAddr(address)}</div>}
      </div>

      <div className="mt-5 flex items-end justify-between border-t border-line pt-5">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-text-3">Win rate</div>
          <div className="text-5xl font-extrabold leading-none text-brand-500">{winPct}%</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-text-3">Net P&L</div>
          <div className={cnm('tnum text-2xl font-extrabold leading-none', net >= 0 ? 'text-up' : 'text-down')}>
            {net >= 0 ? '+' : '-'}${commas(Math.abs(net))}
          </div>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <Cell label="Games played" value={commas(stats.gamesPlayed)} />
        <Cell label="Volume" value={`$${commas(parseFloat(stats.totalVolume))}`} />
        <Cell label="Current streak" value={commas(stats.currentStreak)} />
        <Cell label="Best streak" value={commas(stats.maxStreak)} />
      </div>
    </div>
  )
}

function Cell({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="rounded-md bg-white/[0.04] p-3">
      <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-text-3">{label}</div>
      <div className="tnum mt-1 text-xl font-extrabold">{value}</div>
    </div>
  )
}

export function StatsCardSkeleton() {
  return (
    <div className="surface-skeuo rounded-card p-5">
      <div className="shimmer h-6 w-24 rounded-full" />
      <div className="shimmer mt-4 h-7 w-40 rounded-lg" />
      <div className="mt-6 flex justify-between">
        <div className="shimmer h-12 w-28 rounded-lg" />
        <div className="shimmer h-12 w-24 rounded-lg" />
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="shimmer h-16 rounded-md" />
        ))}
      </div>
    </div>
  )
}
