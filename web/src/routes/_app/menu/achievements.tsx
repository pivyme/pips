import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import type { AchievementDTO } from '@/lib/api'
import { ScreenError } from '@/components/menu/shared'
import { api } from '@/lib/api'
import { haptic } from '@/lib/haptics'
import { cnm } from '@/utils/style'

// The docs catalog is the visual source of truth for this page. API data is merged in when the
// backend has a matching achievement; missing entries render locked with the same sticker art as
// a black silhouette.
export const Route = createFileRoute('/_app/menu/achievements')({ component: AchievementsScreen })

type CatalogAchievement = {
  slug: string
  legacySlug?: string
  name: string
  description: string
}

type DisplayAchievement = CatalogAchievement & {
  unlocked: boolean
  unlockedAt?: string
  progress?: AchievementDTO['progress']
}

const CATALOG: Array<CatalogAchievement> = [
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
  { slug: 'market_hopper', legacySlug: 'all_games', name: 'Market Hopper', description: 'Try 3 different markets.' },
  { slug: 'dollar_rookie', legacySlug: 'volume_1000', name: 'Dollar Rookie', description: 'Play a total of $25.' },
  { slug: 'bigger_move', legacySlug: 'big_multiplier', name: 'Bigger Move', description: 'Make one play above $25.' },
  { slug: 'comeback', name: 'Comeback', description: 'Win after your previous play was a loss.' },
  { slug: 'pips_regular', name: 'Pips Regular', description: 'Complete 10 total plays.' },
]

function AchievementsScreen() {
  const q = useQuery({ queryKey: ['achievements'], queryFn: () => api.achievements() })

  if (q.isLoading) {
    return (
      <AchievementsFrame>
        <GridSkeleton />
      </AchievementsFrame>
    )
  }

  if (q.isError) {
    return (
      <AchievementsFrame>
        <ScreenError message="Could not load achievements" onRetry={() => void q.refetch()} />
      </AchievementsFrame>
    )
  }

  const achievements = mergeCatalog(q.data?.achievements ?? [])
  const unlocked = achievements.filter((a) => a.unlocked)

  return (
    <AchievementsFrame>
      <p className="sr-only">
        {unlocked.length} of {achievements.length} unlocked. Locked achievements show black silhouettes.
      </p>
      <div className="grid grid-cols-2 gap-3">
        {achievements.map((achievement) => (
          <AchievementCard key={achievement.slug} achievement={achievement} />
        ))}
      </div>
    </AchievementsFrame>
  )
}

function AchievementsFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-full bg-black px-4 pb-8">
      <header className="sticky top-0 z-30 -mx-4 h-[76px] bg-[linear-gradient(180deg,#000_0%,#000_52%,rgba(0,0,0,0.72)_72%,rgba(0,0,0,0)_100%)]">
        <Link
          to="/menu"
          onClick={() => haptic('selection')}
          aria-label="Back to menu"
          className="absolute left-4 top-1 flex h-12 w-12 items-center justify-center rounded-full border border-white/[0.09] bg-white/[0.12] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_10px_28px_-14px_rgba(0,0,0,1)] backdrop-blur-sm transition-transform active:scale-95"
        >
          <ChevronLeft className="h-7 w-7" strokeWidth={3} />
        </Link>
        <h1 className="absolute inset-x-16 top-[16px] text-center text-[24px] font-black leading-none text-white">
          All Achievements
        </h1>
      </header>
      <div className="relative z-0 -mt-1 pt-5">{children}</div>
    </div>
  )
}

function AchievementCard({ achievement }: { achievement: DisplayAchievement }): ReactNode {
  return (
    <article
      aria-label={`${achievement.name}, ${achievement.unlocked ? 'unlocked' : 'locked'}`}
      className="relative flex min-h-[274px] flex-col overflow-hidden rounded-[24px] border border-white/[0.075] bg-[#1b1b1b] px-4 pb-5 pt-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.075),inset_0_-1px_0_rgba(0,0,0,0.8),0_1px_0_rgba(255,255,255,0.03)]"
    >
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.035)_0%,rgba(255,255,255,0)_38%,rgba(0,0,0,0.16)_100%)]" />
      <div className="relative flex min-h-[150px] flex-1 items-center justify-center pb-3">
        <img
          src={`/assets/achievements/achievement-${achievement.slug.replaceAll('_', '-')}.png`}
          alt={`${achievement.name} ${achievement.unlocked ? 'illustration' : 'silhouette'}`}
          className={cnm(
            'h-[148px] w-[148px] max-w-full object-contain transition-transform duration-200',
            achievement.unlocked
              ? 'drop-shadow-[0_14px_22px_rgba(0,0,0,0.34)]'
              : 'brightness-0 contrast-200 drop-shadow-[0_1px_0_rgba(255,255,255,0.025)]',
          )}
          draggable={false}
        />
      </div>
      <div className="relative">
        <h2 className="text-[17px] font-semibold leading-[1.08] text-white">{achievement.name}</h2>
        <p className="mt-1.5 line-clamp-2 h-[2.4em] text-[14px] font-semibold leading-[1.2] text-[#9a9a9a]">
          {achievement.description}
        </p>
      </div>
    </article>
  )
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="shimmer min-h-[274px] rounded-[24px] border border-white/[0.06] bg-[#1b1b1b]"
        />
      ))}
    </div>
  )
}

function mergeCatalog(apiAchievements: Array<AchievementDTO>): Array<DisplayAchievement> {
  const bySlug = new Map(apiAchievements.map((achievement) => [achievement.slug, achievement]))

  return CATALOG.map((catalogAchievement) => {
    const apiAchievement =
      bySlug.get(catalogAchievement.slug) ??
      (catalogAchievement.legacySlug ? bySlug.get(catalogAchievement.legacySlug) : undefined)

    return {
      ...catalogAchievement,
      unlocked: apiAchievement?.unlocked ?? false,
      unlockedAt: apiAchievement?.unlockedAt,
      progress: apiAchievement?.progress,
    }
  })
}
