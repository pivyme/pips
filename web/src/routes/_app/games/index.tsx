import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Illo } from '@/ui/Illo'
import { api } from '@/lib/api'

export const Route = createFileRoute('/_app/games/')({ component: GamesHub })

const GAMES = [
  { to: '/games/lucky', illo: 'dice', title: 'I Feel Lucky', sub: 'Spin. Ride it. Cash out.' },
  { to: '/games/range', illo: 'target', title: 'Range', sub: 'Call the zone. Tighter pays more.' },
  { to: '/games/tap', illo: 'bolt', title: 'Tap', sub: 'Tap the chart. Catch the move.' },
] as const

function Row({ illo, title, sub }: { illo: string; title: string; sub: string }): ReactNode {
  return (
    <div className="card-neo flex items-center gap-3 p-3 transition-transform active:scale-[0.99]">
      <Illo name={illo} size={56} />
      <div className="min-w-0 flex-1">
        <span className="text-[17px] font-bold">{title}</span>
        <div className="text-sm text-text-2">{sub}</div>
      </div>
      <span className="text-lg text-text-3">›</span>
    </div>
  )
}

// Markets status under the header: the games stay navigable either way, this just tells the
// player whether there is a live oracle to mint against right now.
function MarketsStatus() {
  const q = useQuery({ queryKey: ['markets'], queryFn: () => api.markets(), refetchInterval: 10_000 })

  if (q.isLoading) return <div className="shimmer h-4 w-28 rounded-full" />

  if (q.isError) {
    return (
      <button type="button" onClick={() => void q.refetch()} className="flex items-center gap-1.5 text-xs font-semibold text-text-3">
        <span className="h-1.5 w-1.5 rounded-full bg-down" />
        Markets offline. Retry
      </button>
    )
  }

  const liveCount = (q.data?.markets ?? []).filter((m) => m.live).length
  return (
    <div className="flex items-center gap-1.5 text-xs font-semibold text-text-3">
      <span className={liveCount > 0 ? 'h-1.5 w-1.5 rounded-full bg-up' : 'h-1.5 w-1.5 rounded-full bg-text-3'} />
      {liveCount > 0 ? `${liveCount} live now` : 'Warming up markets'}
    </div>
  )
}

function GamesHub() {
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-baseline justify-between px-1 pt-2">
        <h1 className="text-2xl font-extrabold tracking-tight">Games</h1>
        <MarketsStatus />
      </div>

      {GAMES.map((g) => (
        <Link key={g.to} to={g.to}>
          <Row illo={g.illo} title={g.title} sub={g.sub} />
        </Link>
      ))}
    </div>
  )
}
