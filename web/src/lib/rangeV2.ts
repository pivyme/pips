// Range V2 persists its stacked board under this key. Range V1 and Range V2 both mint `range` plays, so
// reading V2's still-live ids is how the hub + Range V1 tell the two apart: a V2 position must never restore
// into V1's single-round screen, nor light V1's hub row. Single source for the key + the reader.
export const RV2_POSITIONS_KEY = 'pips_rv2_positions'

export function rv2LivePlayIds(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(RV2_POSITIONS_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as Array<{ playId?: string; status?: string }>
    return new Set(
      arr
        .filter((p) => p.playId && (p.status === 'open' || p.status === 'pending'))
        .map((p) => p.playId as string),
    )
  } catch {
    return new Set()
  }
}
