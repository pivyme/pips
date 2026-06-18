import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { LogOut } from 'lucide-react'
import type { ReactNode } from 'react'
import type { DisplayAchievement } from '@/lib/achievements'
import { MenuHeader, prepareMenuTransition } from '@/components/menu/shared'
import { useMenuDrawer } from '@/components/console/MenuDrawer'
import { StatsCard, StatsCardSkeleton } from '@/components/menu/StatsCard'
import { Button } from '@/ui/Button'
import { Illo } from '@/ui/Illo'
import { achievementImage, mergeCatalog } from '@/lib/achievements'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { haptic } from '@/lib/haptics'

// The menu home, rendered inside the bottom drawer. The trader card sits right at the top (tap to
// share), then the achievements rail in the !Camera layout: the closest in-progress badge leads,
// earned badges follow, all on one scroll, with the full catalog one tap away. Customize and
// Settings round it out.
export const Route = createFileRoute('/_app/menu/')({ component: MenuHome })

function MenuHome() {
  const { signOut } = useAuth()

  return (
    <div className="relative min-h-full bg-black px-4 pb-8">
      <MenuHeader title="Menu" showBack={false} />
      <div className="relative z-0 -mt-1 flex flex-col gap-6 pt-5">
        <StatsSection />
        <div className="flex flex-col gap-3">
          <MenuRow
            to="/menu/customize"
            icon="/assets/icons/icon-customize.png"
            title="Customize"
            sub="Make it yours"
            launch
          />
          <MenuRow
            to="/menu/settings"
            icon="/assets/icons/icon-settings.png"
            title="Settings"
            sub="Sound, haptics, motion"
          />
        </div>
        <AchievementsSection />
        <Button
          variant="danger"
          onClick={() => {
            haptic('rigid')
            signOut()
          }}
          className="mt-16 h-14 w-full rounded-card text-sm"
        >
          <LogOut className="h-5 w-5" strokeWidth={2.4} />
          Log out
        </Button>
      </div>
    </div>
  )
}

function StatsSection() {
  const { user } = useAuth()
  const q = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() })
  const stats = q.data?.stats

  if (q.isLoading) return <StatsCardSkeleton />
  if (!stats || stats.gamesPlayed === 0) {
    return (
      <div className="surface-skeuo flex items-center gap-3 rounded-card p-4">
        <Illo name="vault" size={48} />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-bold">No plays yet</div>
          <div className="text-sm text-text-3">
            Make your first play to fill in your card.
          </div>
        </div>
        <Link
          to="/games"
          onClick={() => haptic('medium')}
          className="btn-primary rounded-full px-4 py-2 text-xs font-extrabold uppercase tracking-wide"
        >
          Play
        </Link>
      </div>
    )
  }

  return (
    <Link
      to="/menu/stats"
      viewTransition
      onClick={() => {
        prepareMenuTransition('forward')
        haptic('selection')
      }}
      className="block transition-transform active:scale-[0.99]"
    >
      <StatsCard
        stats={stats}
        displayName={user?.displayName ?? 'Player'}
        address={user?.address ?? ''}
      />
    </Link>
  )
}

function AchievementsSection() {
  const q = useQuery({
    queryKey: ['achievements'],
    queryFn: () => api.achievements(),
  })

  if (q.isLoading) {
    return (
      <section className="flex flex-col gap-3">
        <SectionLabel />
        <div className="-mx-4 flex gap-3 overflow-hidden px-4">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="shimmer h-[208px] w-[160px] shrink-0 rounded-card"
            />
          ))}
        </div>
      </section>
    )
  }

  const all = mergeCatalog(q.data?.achievements ?? [])
  // The closest in-progress badge leads (most motivating), earned badges follow.
  const inProgress = all
    .filter((a) => !a.unlocked && a.progress && a.progress.target > 0)
    .sort((a, b) => pct(b) - pct(a))
  const unlocked = all.filter((a) => a.unlocked)
  const rail = [...inProgress, ...unlocked]

  return (
    <section className="flex flex-col gap-3">
      <SectionLabel />
      <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {rail.map((a) => (
          <AchievementCard key={a.slug} a={a} />
        ))}
      </div>
      <Link
        to="/menu/achievements"
        viewTransition
        onClick={() => {
          prepareMenuTransition('forward')
          haptic('selection')
        }}
      >
        <div className="surface-skeuo flex items-center justify-between rounded-card p-4 transition-transform active:scale-[0.99]">
          <span className="text-[15px] font-bold">All Achievements</span>
          <span className="text-lg text-text-3">›</span>
        </div>
      </Link>
    </section>
  )
}

function SectionLabel() {
  return (
    <div className="px-1 text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">
      Achievements
    </div>
  )
}

const pct = (a: DisplayAchievement): number =>
  a.progress && a.progress.target > 0
    ? Math.min(1, a.progress.current / a.progress.target)
    : 0

function AchievementCard({ a }: { a: DisplayAchievement }): ReactNode {
  const p = pct(a)
  return (
    <div className="surface-skeuo flex w-[160px] shrink-0 flex-col gap-3 rounded-card p-4">
      <div className="relative mx-auto flex h-[116px] w-[116px] items-center justify-center">
        {a.unlocked ? (
          <img
            src={achievementImage(a.slug)}
            alt=""
            className="h-[104px] w-[104px] object-contain drop-shadow-[0_12px_20px_rgba(0,0,0,0.34)]"
            draggable={false}
          />
        ) : (
          <>
            {/* Locked badge as a black silhouette, with the progress ring + percent on top. */}
            <img
              src={achievementImage(a.slug)}
              alt=""
              className="absolute h-[80px] w-[80px] object-contain brightness-0 contrast-200 drop-shadow-[0_1px_0_rgba(255,255,255,0.04)]"
              draggable={false}
            />
            <ProgressRing value={p} />
            <span className="tnum absolute text-[26px] font-extrabold leading-none">
              {Math.round(p * 100)}%
            </span>
          </>
        )}
      </div>
      <div>
        <div className="text-[15px] font-bold leading-tight">{a.name}</div>
        <div className="mt-1 line-clamp-2 text-[13px] leading-snug text-text-2">
          {a.description}
        </div>
      </div>
    </div>
  )
}

function ProgressRing({ value }: { value: number }) {
  const r = 50
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
      <circle
        cx={60}
        cy={60}
        r={r}
        fill="none"
        stroke="rgba(255,255,255,0.10)"
        strokeWidth={10}
      />
      <circle
        cx={60}
        cy={60}
        r={r}
        fill="none"
        style={{ stroke: 'var(--color-brand-500)' }}
        strokeWidth={10}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - value)}
      />
    </svg>
  )
}

function MenuRow({
  to,
  icon,
  title,
  sub,
  launch = false,
}: {
  to: string
  icon: string
  title: string
  sub: string
  // `launch` rows hand off to a full takeover (the Customize studio): the drawer slides itself away
  // first, then routes, so it never just pops out from under the studio.
  launch?: boolean
}): ReactNode {
  const drawer = useMenuDrawer()
  return (
    <Link
      to={to}
      viewTransition={!launch}
      onClick={(e) => {
        if (launch && drawer) {
          e.preventDefault()
          drawer.closeTo(to)
          return
        }
        prepareMenuTransition('forward')
        haptic('selection')
      }}
      className="surface-skeuo flex min-h-24 items-center gap-3 rounded-card px-3 py-1 transition-transform active:scale-[0.99]"
    >
      <img
        src={icon}
        alt=""
        className="h-20 w-20 shrink-0 object-contain"
        draggable={false}
      />
      <div className="ml-1 min-w-0 flex-1">
        <span className="text-xl font-bold">{title}</span>
        <div className="text-[15px] text-text-2">{sub}</div>
      </div>
      <span className="pr-2 text-3xl text-text-3">›</span>
    </Link>
  )
}
