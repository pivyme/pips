import toast from 'react-hot-toast'
import type { AchievementDTO } from '@/lib/api'

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

// Canonical achievement catalog: the source of truth for names, copy, and sticker art, shared by
// the menu home rail and the full Achievements grid so the two never drift. The backend may still
// hand back legacy slugs, so each entry can carry a legacySlug to merge old rows onto current art.

export type CatalogAchievement = {
  slug: string
  legacySlug?: string
  name: string
  description: string
}

export type DisplayAchievement = CatalogAchievement & {
  unlocked: boolean
  unlockedAt?: string
  progress?: AchievementDTO['progress']
}

export const ACHIEVEMENTS: Array<CatalogAchievement> = [
  { slug: 'first_try', legacySlug: 'first_play', name: 'First Try', description: 'Complete your first play.' },
  { slug: 'getting_warm', name: 'Getting Warm', description: 'Play 3 times.' },
  { slug: 'high_five', name: 'High Five', description: 'Play 5 times.' },
  { slug: 'ten_club', name: 'Ten Club', description: 'Make one play above $10.' },
  { slug: 'tiny_bet', name: 'Tiny Bet', description: 'Make one play under $5.' },
  { slug: 'back_again', name: 'Back Again', description: 'Open the app 2 days in a row.' },
  { slug: 'daily_play', name: 'Daily Play', description: 'Complete one play in a day.' },
  { slug: 'night_shift', name: 'Night Shift', description: 'Play after 10 PM.' },
  { slug: 'early_signal', name: 'Early Signal', description: 'Play before 9 AM.' },
  { slug: 'first_win', name: 'First Win', description: 'Win your first play.' },
  { slug: 'close_call', name: 'Close Call', description: 'Finish a play with a tiny margin.' },
  { slug: 'quick_tap', legacySlug: 'cashout_10', name: 'Quick Tap', description: 'Complete a play in under 30 seconds.' },
  { slug: 'calm_click', name: 'Calm Click', description: 'Submit a play without changing your choice.' },
  { slug: 'double_play', name: 'Double Play', description: 'Complete 2 plays in one session.' },
  { slug: 'mini_streak', legacySlug: 'win_streak_5', name: 'Mini Streak', description: 'Win 2 plays in a row.' },
  { slug: 'market_hopper', legacySlug: 'all_games', name: 'Sampler', description: 'Play both Lucky and Range.' },
  { slug: 'dollar_rookie', legacySlug: 'volume_1000', name: 'Dollar Rookie', description: 'Play a total of $25.' },
  { slug: 'bigger_move', legacySlug: 'big_multiplier', name: 'Bigger Move', description: 'Make one play above $25.' },
  { slug: 'comeback', name: 'Comeback', description: 'Win after your previous play was a loss.' },
  { slug: 'pips_regular', name: 'Pips Regular', description: 'Complete 10 total plays.' },
]

// Sticker art lives at /assets/achievements, named by the canonical slug.
export const achievementImage = (slug: string): string =>
  `/assets/achievements/achievement-${slug.replaceAll('_', '-')}.png`

// Merge backend rows (which may use legacy slugs) onto the canonical catalog.
export function mergeCatalog(apiAchievements: Array<AchievementDTO>): Array<DisplayAchievement> {
  const bySlug = new Map(apiAchievements.map((a) => [a.slug, a]))

  return ACHIEVEMENTS.map((cat) => {
    const api = bySlug.get(cat.slug) ?? (cat.legacySlug ? bySlug.get(cat.legacySlug) : undefined)
    return {
      ...cat,
      unlocked: api?.unlocked ?? false,
      unlockedAt: api?.unlockedAt,
      progress: api?.progress,
    }
  })
}
