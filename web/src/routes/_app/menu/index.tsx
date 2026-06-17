import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { AchievementDTO } from '@/lib/api'
import { StatsCard, StatsCardSkeleton } from '@/components/menu/StatsCard'
import { Illo } from '@/ui/Illo'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { haptic } from '@/lib/haptics'

// The menu home, rendered inside the bottom drawer. The trader card sits right at the top (tap to
// share), then the achievements rail in the !Camera layout: the closest in-progress badge leads,
// earned badges follow, all on one scroll, with the full catalog one tap away. Customize and
// Settings round it out.
export const Route = createFileRoute('/_app/menu/')({ component: MenuHome })

function MenuHome() {
  return (
    <div className="flex flex-col gap-6 px-4 pb-8 pt-1">
      <h1 className="px-1 text-3xl font-extrabold tracking-tight">Menu</h1>
      <StatsSection />
      <div className="flex flex-col gap-3">
        <MenuRow to="/menu/customize" illo="gem" title="Customize" sub="Make it yours" />
        <MenuRow to="/menu/settings" illo="gear" title="Settings" sub="Sound, haptics, motion" />
      </div>
      <AchievementsSection />
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
      <div className="card-neo flex items-center gap-3 p-4">
        <Illo name="vault" size={48} />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-bold">No plays yet</div>
          <div className="text-sm text-text-3">Make your first play to fill in your card.</div>
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
    <Link to="/menu/stats" onClick={() => haptic('selection')} className="block transition-transform active:scale-[0.99]">
      <StatsCard stats={stats} displayName={user?.displayName ?? 'Player'} address={user?.address ?? ''} />
    </Link>
  )
}

function AchievementsSection() {
  const q = useQuery({ queryKey: ['achievements'], queryFn: () => api.achievements() })

  if (q.isLoading) {
    return (
      <section className="flex flex-col gap-3">
        <SectionLabel />
        <div className="-mx-4 flex gap-3 overflow-hidden px-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="shimmer h-[208px] w-[160px] shrink-0 rounded-card" />
          ))}
        </div>
      </section>
    )
  }

  const all = q.data?.achievements ?? []
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
      <Link to="/menu/achievements" onClick={() => haptic('selection')}>
        <div className="card-neo flex items-center justify-between p-4 transition-transform active:scale-[0.99]">
          <span className="text-[15px] font-bold">All Achievements</span>
          <span className="text-lg text-text-3">›</span>
        </div>
      </Link>
    </section>
  )
}

function SectionLabel() {
  return <div className="px-1 text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">Achievements</div>
}

const pct = (a: AchievementDTO): number =>
  a.progress && a.progress.target > 0 ? Math.min(1, a.progress.current / a.progress.target) : 0

function AchievementCard({ a }: { a: AchievementDTO }): ReactNode {
  const p = pct(a)
  return (
    <div className="card-neo flex w-[160px] shrink-0 flex-col gap-3 p-4">
      <div className="relative mx-auto flex h-[116px] w-[116px] items-center justify-center">
        {a.unlocked ? (
          <Illo name={a.illo} size={104} />
        ) : (
          <>
            <ProgressRing value={p} />
            <span className="tnum absolute text-[26px] font-extrabold leading-none">{Math.round(p * 100)}%</span>
          </>
        )}
      </div>
      <div>
        <div className="text-[15px] font-bold leading-tight">{a.name}</div>
        <div className="mt-1 line-clamp-2 text-[13px] leading-snug text-text-2">{a.description}</div>
      </div>
    </div>
  )
}

function ProgressRing({ value }: { value: number }) {
  const r = 50
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
      <circle cx={60} cy={60} r={r} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth={10} />
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

function MenuRow({ to, illo, title, sub }: { to: string; illo: string; title: string; sub: string }): ReactNode {
  return (
    <Link to={to} onClick={() => haptic('selection')}>
      <div className="card-neo flex items-center gap-3 p-3 transition-transform active:scale-[0.99]">
        <Illo name={illo} size={56} />
        <div className="min-w-0 flex-1">
          <span className="text-[17px] font-bold">{title}</span>
          <div className="text-sm text-text-2">{sub}</div>
        </div>
        <span className="text-lg text-text-3">›</span>
      </div>
    </Link>
  )
}
