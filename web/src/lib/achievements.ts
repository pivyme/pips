import type { AchievementDTO } from '@/lib/api'

// Canonical achievement catalog: source of truth for names, copy, and sticker art, shared by the menu
// home rail and the full grid so they never drift. Entries can carry a legacySlug to merge old backend rows onto current art.

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
  { slug: 'market_hopper', legacySlug: 'all_games', name: 'Sampler', description: 'Play two different games.' },
  { slug: 'dollar_rookie', legacySlug: 'volume_1000', name: 'Dollar Rookie', description: 'Play a total of $25.' },
  { slug: 'bigger_move', legacySlug: 'big_multiplier', name: 'Bigger Move', description: 'Make one play above $25.' },
  { slug: 'comeback', name: 'Comeback', description: 'Win after your previous play was a loss.' },
  { slug: 'pips_regular', name: 'PIPS Regular', description: 'Complete 10 total plays.' },
]

// Sticker art lives at /assets/achievements, named by the canonical slug.
export const achievementImage = (slug: string): string =>
  `/assets/achievements/achievement-${slug.replaceAll('_', '-')}.webp`

// The backend hands back catalog/legacy slugs (e.g. `first_play`); resolve each to its canonical entry so a fresh unlock surfaces with the right sticker art + copy.
const BY_ANY_SLUG = new Map<string, CatalogAchievement>()
for (const a of ACHIEVEMENTS) {
  BY_ANY_SLUG.set(a.slug, a)
  if (a.legacySlug) BY_ANY_SLUG.set(a.legacySlug, a)
}

export type ResolvedAchievement = { slug: string; name: string; description: string; image: string }

export function resolveAchievement(slug: string): ResolvedAchievement {
  const entry = BY_ANY_SLUG.get(slug)
  const canonical = entry?.slug ?? slug
  return {
    slug: canonical,
    name: entry?.name ?? 'New achievement',
    description: entry?.description ?? '',
    image: achievementImage(canonical),
  }
}

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
