import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { MenuScreen, ScreenError } from '@/components/menu/shared'
import { Illo } from '@/ui/Illo'
import { api, type AchievementDTO } from '@/lib/api'
import { cnm } from '@/utils/style'

// The sticker set. A lit preview row of what's unlocked, then the full catalog grid where locked
// tiles dim and show progress toward the threshold. Catalog is always present, so no empty state.
export const Route = createFileRoute('/_app/menu/achievements')({ component: AchievementsScreen })

function AchievementsScreen() {
  const q = useQuery({ queryKey: ['achievements'], queryFn: () => api.achievements() })

  if (q.isLoading) return <MenuScreen title="Achievements"><GridSkeleton /></MenuScreen>
  if (q.isError) {
    return (
      <MenuScreen title="Achievements">
        <ScreenError message="Could not load achievements" onRetry={() => void q.refetch()} />
      </MenuScreen>
    )
  }

  const all = q.data?.achievements ?? []
  const unlocked = all.filter((a) => a.unlocked)

  return (
    <MenuScreen title="Achievements">
      <div className="mb-3 text-sm font-semibold text-text-2">
        {unlocked.length} of {all.length} unlocked
      </div>

      {unlocked.length > 0 ? (
        <div className="mb-5 flex gap-3 overflow-x-auto pb-1">
          {unlocked.map((a) => (
            <div key={a.slug} className="flex w-16 shrink-0 flex-col items-center gap-1 text-center">
              <Illo name={a.illo} size={52} />
              <span className="text-[10px] font-semibold leading-tight text-text-2">{a.name}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="mb-5 text-sm text-text-3">Nothing unlocked yet. Play to earn your first.</p>
      )}

      <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-text-3">All achievements</div>
      <div className="grid grid-cols-3 gap-2.5">
        {all.map((a) => (
          <Tile key={a.slug} a={a} />
        ))}
      </div>
    </MenuScreen>
  )
}

function Tile({ a }: { a: AchievementDTO }): ReactNode {
  const pct = a.progress && a.progress.target > 0 ? Math.min(1, a.progress.current / a.progress.target) : 0
  return (
    <div
      className={cnm(
        'card-neo flex flex-col items-center gap-1.5 p-3 text-center',
        !a.unlocked && 'opacity-45',
      )}
    >
      <Illo name={a.illo} size={46} className={a.unlocked ? undefined : 'grayscale'} />
      <div className="text-[11px] font-bold leading-tight">{a.name}</div>
      {a.unlocked ? (
        <div className="text-[9px] font-bold uppercase tracking-wide text-up">Unlocked</div>
      ) : (
        <div className="w-full">
          <div className="text-[9px] font-bold uppercase tracking-wide text-text-3">
            {a.progress && a.progress.target > 1 ? `${a.progress.current}/${a.progress.target}` : 'Locked'}
          </div>
          {a.progress && a.progress.target > 1 && (
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-black/40">
              <div className="h-full rounded-full bg-brand-500/70" style={{ width: `${pct * 100}%` }} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function GridSkeleton() {
  return (
    <>
      <div className="shimmer mb-3 h-4 w-32 rounded-full" />
      <div className="mb-5 flex gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="shimmer h-14 w-14 rounded-2xl" />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="shimmer h-28 rounded-card" />
        ))}
      </div>
    </>
  )
}
