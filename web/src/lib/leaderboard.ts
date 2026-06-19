// Local arcade leaderboard. No backend, no chain: top scores live in localStorage so a casual
// minigame works offline and in demo mode. Generic over a game key so future minigames reuse it.

export interface ScoreEntry {
  name: string
  score: number
  at: number // epoch ms; tie-break (earliest wins) + "is this run me" detection
  you?: boolean // marks the most recent local submission, for the highlight row
}

export interface SubmitResult {
  scores: ScoreEntry[]
  rank: number // 1-based where the run landed; 0 if it did not make the top board
  isBest: boolean // beat the previous #1
  prevBest: number
}

const MAX = 10
const storeKey = (game: string) => `pips_arcade_lb_${game}`

// Seed bots so the board is never empty on a first run. A believable spread: beatable with a
// strong run, not trivially. Earliest `at` so a real score ties ahead of a bot at equal points.
const SEEDS: Record<string, Array<[string, number]>> = {
  'line-rider': [
    ['KZ', 3800],
    ['AX', 2650],
    ['VOID', 1850],
    ['NEO', 1240],
    ['PIP', 820],
    ['LUX', 520],
    ['RAY', 310],
    ['MOE', 160],
  ],
  'candle-hop': [
    ['KZ', 52],
    ['AX', 38],
    ['VOID', 27],
    ['NEO', 19],
    ['PIP', 13],
    ['LUX', 8],
    ['RAY', 5],
    ['MOE', 2],
  ],
}

function seed(game: string): ScoreEntry[] {
  return (SEEDS[game] ?? []).map(([name, score], i) => ({ name, score, at: i }))
}

export function getScores(game: string): ScoreEntry[] {
  if (typeof window === 'undefined') return seed(game)
  try {
    const raw = window.localStorage.getItem(storeKey(game))
    if (raw) {
      const parsed = JSON.parse(raw) as ScoreEntry[]
      if (Array.isArray(parsed) && parsed.length) return parsed.slice(0, MAX)
    }
  } catch {
    // storage blocked / corrupt: fall back to the seed board
  }
  return seed(game)
}

export function bestScore(game: string): number {
  return getScores(game)[0]?.score ?? 0
}

// Records a finished run. Clears any prior `you` flag, inserts the new entry, sorts, trims, and
// reports where it landed for the result screen.
export function submitScore(game: string, name: string, score: number): SubmitResult {
  const prev = getScores(game).map((e) => ({ ...e, you: false }))
  const prevBest = prev[0]?.score ?? 0
  const entry: ScoreEntry = { name: name || 'You', score, at: Date.now(), you: true }
  const merged = [...prev, entry]
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, MAX)
  const rank = merged.findIndex((e) => e.you) + 1 // 0 if trimmed off the board
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(storeKey(game), JSON.stringify(merged))
    } catch {
      // best effort; the run still shows its rank this session
    }
  }
  return { scores: merged, rank, isBest: rank === 1 && score > prevBest, prevBest }
}
