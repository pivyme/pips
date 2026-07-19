// Lucky (multiplay) persists its stacked board under this key. Lucky is the only screen that mints `lucky`
// plays, so this exists only so the global active-play chip + the hub can tell a Lucky hand is being managed
// by its own board (don't double-track it, don't let the shell chip fight the strip). Single source for the key + reader.
export const LUCKY_HANDS_KEY = 'pips_lucky_hands'

export function luckyLivePlayIds(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(LUCKY_HANDS_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as Array<{ playId?: string; status?: string }>
    return new Set(
      arr
        .filter((h) => h.playId && (h.status === 'open' || h.status === 'pending'))
        .map((h) => h.playId as string),
    )
  } catch {
    return new Set()
  }
}
