// The chips-granted event bus, kept dependency-free so any layer (auth, the TOP UP hook, the overlay) can
// emit or listen without an import cycle. Login, the TOP UP button, and the auto top-up all push the granted
// DUSDC amount here; ChipGrantCelebration listens and blooms the "here's N DUSDC to play with" popup.

type Listener = (amount: number) => void
const listeners = new Set<Listener>()

export function emitChipGrant(amount: number): void {
  if (!(amount > 0)) return
  for (const l of listeners) l(amount)
}

export function subscribeChipGrant(l: Listener): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
