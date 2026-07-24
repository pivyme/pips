// The money-modal controller: which money surface (activity / deposit / send) is open as a centered modal.
// Dependency-free (like chipGrantBus / depositBus) so the balance card + the chip-grant fallback can open it
// without pulling the modal's heavy body imports into their chunks. The host component subscribes + renders.

export type MoneyView = 'activity' | 'deposit' | 'send'

let current: MoneyView | null = null
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const l of listeners) l()
}

export function openMoneyModal(view: MoneyView): void {
  current = view
  emit()
}

export function closeMoneyModal(): void {
  if (current === null) return
  current = null
  emit()
}

export function subscribeMoneyModal(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function getMoneyModalView(): MoneyView | null {
  return current
}
