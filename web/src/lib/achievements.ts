import toast from 'react-hot-toast'

// Slug -> display name, mirrors the seeded catalog (08-DEMO-FLOW.md). Confirm/cashout return the
// slugs that just unlocked; we surface each with the verbatim toast from 07-DESIGN-SYSTEM.md.
const NAMES: Record<string, string> = {
  first_play: 'First Play',
  first_win: "Beginner's Luck",
  win_streak_5: 'On Fire',
  big_multiplier: 'Moonshot',
  volume_1000: 'High Roller',
  all_games: 'Sampler',
  cashout_10: 'Quick Hands',
  comeback: 'Comeback',
}

export function notifyUnlocks(slugs: string[]): void {
  for (const slug of slugs) {
    toast.success(`Achievement unlocked: ${NAMES[slug] ?? 'New achievement'}`)
  }
}
