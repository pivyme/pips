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

// Copy here MUST match the backend catalog (backend/src/services/achievements.ts) word for word: the
// sticker's promise is exactly the condition the server checks, never a softer paraphrase of a harder rule.
// legacySlug is kept only where the old backend condition was identical, so a not-yet-migrated backend
// can't show new copy over an old, different threshold.
export const ACHIEVEMENTS: Array<CatalogAchievement> = [
  { slug: 'first_try', legacySlug: 'first_play', name: 'First Try', description: 'Complete your first play.' },
  { slug: 'getting_warm', name: 'Getting Warm', description: 'Play 3 times.' },
  { slug: 'high_five', name: 'High Five', description: 'Play 5 times.' },
  { slug: 'ten_club', name: 'Ten Club', description: 'Win 10 plays.' },
  { slug: 'tiny_bet', name: 'Tiny Play', description: 'Make a play of $2 or less.' },
  { slug: 'back_again', name: 'Back Again', description: 'Play 2 days in a row.' },
  { slug: 'daily_play', name: 'Daily Play', description: 'Complete 5 plays in one day.' },
  { slug: 'night_shift', name: 'Night Shift', description: 'Play after 10 PM.' },
  { slug: 'early_signal', name: 'Early Signal', description: 'Play before 9 AM.' },
  { slug: 'first_win', name: 'First Win', description: 'Win your first play.' },
  { slug: 'close_call', name: 'Close Call', description: 'Finish a play with a tiny margin.' },
  { slug: 'quick_tap', name: 'Quick Tap', description: 'Cash out within 30 seconds of opening a play.' },
  { slug: 'calm_click', name: 'Calm Click', description: 'Hold 3 plays to the buzzer and win.' },
  { slug: 'double_play', name: 'Double Play', description: 'Complete 2 plays within 10 minutes.' },
  { slug: 'mini_streak', name: 'Mini Streak', description: 'Win 2 plays in a row.' },
  { slug: 'market_hopper', legacySlug: 'all_games', name: 'Sampler', description: 'Play two different games.' },
  { slug: 'dollar_rookie', name: 'Dollar Rookie', description: 'Play a total of $25.' },
  { slug: 'bigger_move', name: 'Bigger Move', description: 'Play a total of $100.' },
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
