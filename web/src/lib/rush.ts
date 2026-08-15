// RUSH's dials and the AUTO policy. Design: docs/games-ideation/CONCEPTS.md §11.
//
// AUTO spends chips without a press, so the rule that decides whether it fires lives here as a pure
// function rather than tangled in the screen's effects, and is unit tested. Every clause below is a way
// AUTO must stop: the round filled up, a mint failed, the chips ran out, the buzzer is too close.

/** The knob: the minimum multiple the machine may deal. Mirrors RUSH_APPETITES in backend/src/services/games-real.ts. */
export const APPETITES = [1.5, 2, 2.5, 3.5, 5, 8]

/** Live takes a round may hold, and the AUTO cap. One number, shown on screen as four slots. */
export const AUTO_MAX_TAKES = 4

export type AutoInput = {
  auto: boolean
  /** Takes already riding this round. */
  takes: number
  hasOffer: boolean
  busy: boolean
  canAfford: boolean
  /** False once the buzzer is close enough that a mint may not land. */
  armed: boolean
}

export function autoShouldTake(s: AutoInput): boolean {
  return s.auto && s.armed && s.hasOffer && !s.busy && s.canAfford && s.takes < AUTO_MAX_TAKES
}
