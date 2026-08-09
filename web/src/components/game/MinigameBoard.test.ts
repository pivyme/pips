import { describe, expect, it } from 'vitest'
import { minigameOutcomePattern } from './MinigameBoard'
import type { MinigameSubmit } from '@/lib/api'

// The shared decision behind Flappy Piper and Line Rider's outcome haptic (HAPTICS.md 6.6, the B9
// double-buzz fix): exactly one pattern per run, `achievement` on a genuine new best, `lose` otherwise.
// `isBest` is server-computed ("beats your own best AND is now rank #1 globally", see
// backend/src/services/leaderboard.ts), which is why the caller must wait for it rather than guess.
function result(overrides: Partial<MinigameSubmit>): MinigameSubmit {
  return { entries: [], rank: 5, best: 100, isBest: false, prevBest: 90, ...overrides }
}

describe('minigameOutcomePattern', () => {
  it('picks achievement for a new best', () => {
    expect(minigameOutcomePattern(result({ isBest: true }))).toBe('achievement')
  })

  it('picks lose for an ordinary run', () => {
    expect(minigameOutcomePattern(result({ isBest: false }))).toBe('lose')
  })

  it('never returns win, the pattern the old code fired for a best', () => {
    expect(minigameOutcomePattern(result({ isBest: true }))).not.toBe('win')
    expect(minigameOutcomePattern(result({ isBest: false }))).not.toBe('win')
  })
})
