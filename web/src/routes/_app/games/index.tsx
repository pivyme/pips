import { createFileRoute, Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Illo } from '@/ui/Illo'

export const Route = createFileRoute('/_app/games/')({ component: GamesHub })

function Row({
  illo,
  title,
  sub,
  soon,
}: {
  illo: string
  title: string
  sub: string
  soon?: boolean
}): ReactNode {
  return (
    <div className="card-neo flex items-center gap-3 p-3 transition-transform active:scale-[0.99]">
      <Illo name={illo} size={56} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[17px] font-bold">{title}</span>
          {soon && (
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-3">
              Soon
            </span>
          )}
        </div>
        <div className="text-sm text-text-2">{sub}</div>
      </div>
      <span className="text-lg text-text-3">›</span>
    </div>
  )
}

function GamesHub() {
  return (
    <div className="flex flex-col gap-3 p-4">
      <h1 className="px-1 pt-2 text-2xl font-extrabold tracking-tight">Games</h1>

      <Link to="/games/lucky">
        <Row illo="dice" title="I Feel Lucky" sub="Spin a leveraged play. Cash out anytime." />
      </Link>
      <Link to="/games/range">
        <Row illo="target" title="Range" sub="Tighten the band, win bigger." soon />
      </Link>
      <Link to="/games/tap">
        <Row illo="bolt" title="Tap" sub="Tap the boxes the price will hit." soon />
      </Link>
    </div>
  )
}
