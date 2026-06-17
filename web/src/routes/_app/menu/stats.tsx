import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { MenuScreen, ScreenEmpty, ScreenError } from '@/components/menu/shared'
import { Button } from '@/ui/Button'
import { api, type UserStatsDTO } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { shareStatsCard } from '@/lib/shareCard'
import { haptic } from '@/lib/haptics'
import { cnm } from '@/utils/style'

// The shareable trader card. ID-card layout on the recessed screen: handle, the hero win rate,
// and the record. "Share card" renders the same card to a PNG and opens the native share sheet.
export const Route = createFileRoute('/_app/menu/stats')({ component: StatsScreen })

const commas = (n: number): string => Math.round(n).toLocaleString('en-US')
const shortAddr = (a: string): string => (a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a)

function StatsScreen() {
  const { user } = useAuth()
  const q = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() })
  const [sharing, setSharing] = useState(false)

  const stats = q.data?.stats

  const onShare = async () => {
    if (!stats || !user) return
    haptic('medium')
    setSharing(true)
    try {
      await shareStatsCard(stats, { displayName: user.displayName, address: user.address })
      haptic('success')
    } catch {
      const { default: toast } = await import('react-hot-toast')
      toast.error('Could not make your card. Try again.')
    } finally {
      setSharing(false)
    }
  }

  return (
    <MenuScreen title="Stats">
      {q.isLoading ? (
        <CardSkeleton />
      ) : q.isError ? (
        <ScreenError message="Could not load stats" onRetry={() => void q.refetch()} />
      ) : !stats || stats.gamesPlayed === 0 ? (
        <ScreenEmpty illo="vault" title="No plays yet" sub="Make your first play to fill this in.">
          <Link
            to="/games"
            onClick={() => haptic('medium')}
            className="btn-primary rounded-full px-5 py-2.5 text-sm font-extrabold uppercase tracking-wide"
          >
            Play now
          </Link>
        </ScreenEmpty>
      ) : (
        <div className="flex flex-col gap-4">
          <StatsCard stats={stats} displayName={user?.displayName ?? 'Player'} address={user?.address ?? ''} />
          <Button disabled={sharing} onClick={() => void onShare()} className="w-full">
            {sharing ? 'Making your card...' : 'Share card'}
          </Button>
        </div>
      )}
    </MenuScreen>
  )
}

function StatsCard({ stats, displayName, address }: { stats: UserStatsDTO; displayName: string; address: string }) {
  const net = parseFloat(stats.netPnl)
  const winPct = Math.round(stats.winRate * 100)

  return (
    <div className="card-neo overflow-hidden rounded-card p-5">
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
    <div className="rounded-md bg-black/30 p-3">
      <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-text-3">{label}</div>
      <div className="tnum mt-1 text-xl font-extrabold">{value}</div>
    </div>
  )
}

function CardSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="card-neo rounded-card p-5">
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
      <div className="shimmer h-12 rounded-2xl" />
    </div>
  )
}
