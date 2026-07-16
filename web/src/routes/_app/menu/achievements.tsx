import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { DisplayAchievement } from '@/lib/achievements'
import { MenuScreen, ScreenError } from '@/components/menu/shared'
import {
  cardPressClass,
  openFromCard,
  useAchievementDetail,
} from '@/components/menu/AchievementDetail'
import { api } from '@/lib/api'
import { achievementImage, mergeCatalog } from '@/lib/achievements'
import { cnm } from '@/utils/style'

// The docs catalog is the visual source of truth here; API data merges in for matching achievements.
// Missing entries render locked, with the same sticker art as a black silhouette.
export const Route = createFileRoute('/_app/menu/achievements')({
  component: AchievementsScreen,
})

function AchievementsScreen() {
  const q = useQuery({
    queryKey: ['achievements'],
    queryFn: () => api.achievements(),
  })

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
        <ScreenError
          message="Could not load achievements"
          onRetry={() => void q.refetch()}
        />
      </AchievementsFrame>
    )
  }

  const achievements = mergeCatalog(q.data?.achievements ?? [])
  const unlocked = achievements.filter((a) => a.unlocked)

  return (
    <AchievementsFrame>
      <p className="sr-only">
        {unlocked.length} of {achievements.length} unlocked. Locked achievements
        show black silhouettes.
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
  return <MenuScreen title="All Achievements">{children}</MenuScreen>
}

function AchievementCard({
  achievement,
}: {
  achievement: DisplayAchievement
}): ReactNode {
  const { open } = useAchievementDetail()
  return (
    <button
      type="button"
      aria-label={`${achievement.name}, ${achievement.unlocked ? 'unlocked' : 'locked'}`}
      onClick={(e) => openFromCard(open, achievement, e)}
      className={cnm(
        'surface-skeuo relative flex min-h-[274px] flex-col overflow-hidden rounded-card px-4 pb-5 pt-4 text-left',
        cardPressClass,
      )}
    >
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.035)_0%,rgba(255,255,255,0)_38%,rgba(0,0,0,0.16)_100%)]" />
      <div className="relative flex min-h-[150px] flex-1 items-center justify-center pb-3">
        <img
          src={achievementImage(achievement.slug)}
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
        <h2 className="text-[17px] font-semibold leading-[1.08] text-white">
          {achievement.name}
        </h2>
        <p className="mt-1.5 line-clamp-2 h-[2.4em] text-[14px] font-semibold leading-[1.2] text-[#9a9a9a]">
          {achievement.description}
        </p>
      </div>
    </button>
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
