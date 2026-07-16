// In-device leaderboard for the trading games: top GAINERS over top REKT, TE language (docs/SCREEN.md).
// Rows show a username (or generated handle), never an address. Screen isn't clickable, this is a pure readout toggled open/closed by the physical LEADERS button.

import { useQuery } from '@tanstack/react-query'
import { api, type Game, type LeaderboardGameEntry } from '@/lib/api'
import { cnm } from '@/utils/style'
import { displayHandle } from '@/utils/format'

// The screen can't be scrolled by touch, so cap each side to fit both boards at once without spilling off the device.
const PER_BOARD = 4

const signedMoney = (s: string): string => {
  const n = parseFloat(s) || 0
  return `${n < 0 ? '-' : '+'}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
export function GameLeaderboardOverlay({ game, title }: { game: Game; title: string }) {
  const q = useQuery({ queryKey: ['game-lb', game], queryFn: () => api.gameLeaderboard(game) })
  const board = q.data?.leaderboard
  const gainers = (board?.entries ?? []).slice(0, PER_BOARD)
  const rekt = (board?.rekt ?? []).slice(0, PER_BOARD)

  return (
    // pb clears the rim AND the occluded bottom-right body (--screen-notch). No inner overflow-hidden so
    // the auto-fit (ConsoleCanvas recomputeScreenFit) can measure both boards and shrink the panel to fit, instead of lower rows clipping off the bottom.
    <div data-screen-overlay className="absolute inset-0 z-20 flex flex-col gap-3 bg-black/95 px-[var(--screen-rim,24px)] pb-[calc(var(--screen-rim,24px)+var(--screen-notch,0px))] pt-[calc(var(--screen-rim,24px)+2.25rem)] text-left">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[19px] font-bold uppercase tracking-[0.16em] text-brand-500">{title}</div>
          <div className="mt-1 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-text-3">Leaderboard</div>
        </div>
        <span className="mt-1 shrink-0 text-right font-mono text-[10px] uppercase tracking-[0.12em] text-text-3">Press again to close</span>
      </div>
      {q.isLoading ? (
        <div className="flex flex-col gap-3 pt-1">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="shimmer h-4 w-3/4" />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Board label="Top Gainers" tone="up" rows={gainers} empty="No winners yet. Bank a profit to take #1." />
          <Board label="Top Rekt" tone="down" rows={rekt} empty="Nobody's down yet. Keep it that way." />
        </div>
      )}
    </div>
  )
}

function Board({ label, tone, rows, empty }: { label: string; tone: 'up' | 'down'; rows: LeaderboardGameEntry[]; empty: string }) {
  const amount = tone === 'up' ? 'text-up' : 'text-down'
  return (
    <div className="flex max-w-[92%] flex-col">
      <div className="mb-1.5 flex items-center gap-2 border-b border-line-strong pb-1.5">
        <span className={cnm('h-2.5 w-2.5', tone === 'up' ? 'bg-up' : 'bg-down')} />
        <span className="font-mono text-[13px] font-bold uppercase tracking-[0.16em] text-text-2">{label}</span>
      </div>
      {rows.length === 0 ? (
        <div className="py-1 text-[13px] leading-snug text-text-3">{empty}</div>
      ) : (
        <div className="flex flex-col font-mono">
          {rows.map((r) => (
            <div
              key={r.rank}
              className={cnm('flex items-center gap-3 py-1 text-[14px] tracking-[0.04em]', r.isYou ? 'text-brand-500' : 'text-text-2')}
            >
              <span className="tnum w-6 text-text-3">{r.rank}</span>
              <span className="flex-1 truncate font-bold">{displayHandle(r)}</span>
              <span className={cnm('tnum font-bold', r.isYou ? 'text-brand-500' : amount)}>{signedMoney(r.pnl)}</span>
              {r.isYou && <span className="text-brand-500">◀</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
