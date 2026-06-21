// Shared arcade leaderboard for the minigames (Line Rider, Flappy Piper). The board is global and
// keyed to the player's account, so every row shows a username, never an address. One hook owns the
// fetch + submit; the list UI is the flat Teenage Engineering scoreboard both minigames render.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type LeaderboardScoreEntry, type Minigame, type MinigameSubmit } from '@/lib/api'
import { cnm } from '@/utils/style'
import { displayHandle } from '@/utils/format'

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US')
const lbKey = (game: Minigame) => ['minigame-lb', game] as const

// Fetch the board + submit a finished run. Submit returns where the run landed (for the result
// screen) and seeds the board cache so the title screen reflects the new score immediately.
export function useMinigameLeaderboard(game: Minigame): {
  board: LeaderboardScoreEntry[]
  best: number
  loading: boolean
  submit: (score: number) => Promise<MinigameSubmit>
} {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: lbKey(game), queryFn: () => api.minigameLeaderboard(game) })
  const m = useMutation({
    mutationFn: (score: number) => api.submitMinigameScore(game, score),
    onSuccess: ({ result }) => qc.setQueryData(lbKey(game), { leaderboard: { entries: result.entries, best: result.best } }),
  })
  return {
    board: q.data?.leaderboard.entries ?? [],
    best: q.data?.leaderboard.best ?? 0,
    loading: q.isLoading,
    submit: async (score) => (await m.mutateAsync(score)).result,
  }
}

export function MinigameBoard({ rows }: { rows: LeaderboardScoreEntry[] }) {
  if (rows.length === 0) {
    return <div className="font-mono text-[13px] uppercase tracking-[0.14em] text-text-3">No scores yet. Set the first.</div>
  }
  return (
    <div className="flex w-full flex-col font-mono">
      {rows.map((r) => (
        <div
          key={`${r.rank}-${r.username ?? r.displayName}`}
          className={cnm('flex items-center gap-3 py-1.5 text-[16px] tracking-[0.04em]', r.isYou ? 'text-brand-500' : 'text-text-2')}
        >
          <span className="tnum w-6 text-text-3">{r.rank}</span>
          <span className="flex-1 truncate font-bold">{displayHandle(r)}</span>
          <span className="tnum font-bold">{fmt(r.score)}</span>
          {r.isYou && <span className="text-brand-500">◀</span>}
        </div>
      ))}
    </div>
  )
}
