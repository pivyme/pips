// In-device leaderboard for the trading games (Lucky, Range): the top 10 players by banked profit
// for this game. Teenage Engineering language (docs/SCREEN.md): flat black, mono, one amber accent,
// green for the money. Rows show username (or the generated handle), never an address. Tap to close.

import { useQuery } from '@tanstack/react-query'
import { api, type Game, type LeaderboardGameEntry } from '@/lib/api'
import { cnm } from '@/utils/style'

const money = (s: string): string =>
  `+$${Math.abs(parseFloat(s) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const rowName = (r: LeaderboardGameEntry): string => (r.isYou ? 'You' : r.username ? r.username.toUpperCase() : r.displayName)

export function GameLeaderboardOverlay({ game, title, onClose }: { game: Game; title: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['game-lb', game], queryFn: () => api.gameLeaderboard(game) })
  const entries = q.data?.leaderboard.entries ?? []
  return (
    <button
      type="button"
      onClick={onClose}
      className="absolute inset-0 z-20 flex flex-col gap-2.5 bg-black/95 p-[var(--screen-rim,24px)] text-left"
    >
      <div className="flex items-center justify-between">
        <div className="font-mono text-[13px] font-bold uppercase tracking-[0.2em] text-brand-500">{title} · Top 10</div>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-3">Tap to close</span>
      </div>
      <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Top winners by profit</div>
      {q.isLoading ? (
        <div className="flex flex-col gap-3 pt-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="shimmer h-4 w-3/4" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div className="pt-2 text-[14px] text-text-2">No winners yet. Be the first to bank a profit.</div>
      ) : (
        <div className="flex max-w-[92%] flex-col font-mono">
          {entries.map((r) => (
            <div
              key={r.rank}
              className={cnm('flex items-center gap-3 py-1.5 text-[15px] tracking-[0.04em]', r.isYou ? 'text-brand-500' : 'text-text-2')}
            >
              <span className="tnum w-6 text-text-3">{r.rank}</span>
              <span className="flex-1 truncate font-bold uppercase">{rowName(r)}</span>
              <span className="tnum font-bold text-up">{money(r.pnl)}</span>
              {r.isYou && <span className="text-brand-500">◀</span>}
            </div>
          ))}
        </div>
      )}
    </button>
  )
}
