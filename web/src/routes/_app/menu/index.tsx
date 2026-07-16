import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowDownToLine, ArrowUpFromLine, LogOut, Pencil } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { DisplayAchievement } from '@/lib/achievements'
import { MenuHeader, prepareMenuTransition } from '@/components/menu/shared'
import {
  cardPressClass,
  openFromCard,
  useAchievementDetail,
} from '@/components/menu/AchievementDetail'
import { useMenuDrawer } from '@/components/console/MenuDrawer'
import { StatsCard, StatsCardSkeleton } from '@/components/menu/StatsCard'
import { Illo } from '@/ui/Illo'
import { achievementImage, mergeCatalog } from '@/lib/achievements'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { haptic } from '@/lib/haptics'
import { HapticOverlay } from '@/components/HapticOverlay'
import { displayHandle, formatStringToNumericDecimals } from '@/utils/format'
import { cnm } from '@/utils/style'

// The menu home, rendered inside the bottom drawer. Built to read in one glance, no long scroll:
// the trader card and a slim balance strip up top, then every destination as a 3x2 tile grid (the
// six full-width rows collapsed into two compact rows), then an achievements peek, and a light
// footer with the proud badge + Log out. All the actionable stuff sits above the fold.
export const Route = createFileRoute('/_app/menu/')({ component: MenuHome })

function MenuHome() {
  return (
    <div className="relative min-h-full bg-black px-4 pb-8">
      <MenuHeader title="Menu" showBack={false} />
      <div className="relative z-0 -mt-1 flex flex-col gap-5 pt-5">
        <StatsSection />
        <BalanceStrip />
        <NavGrid />
        <AchievementsPeek />
        <Footer />
      </div>
    </div>
  )
}

// The money strip: balance on the left, the two things you do with it on the right. Compact by
// design, one clean row instead of a tall card. Deposit + Withdraw push to their own screens with
// the native menu transition.
function BalanceStrip() {
  const { user } = useAuth()
  const balance = formatStringToNumericDecimals(user?.balance ?? '0', 2)

  return (
    <div className="card-neo flex items-center justify-between gap-3 rounded-card p-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-text-3">Balance</span>
          <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] text-text-2">
            DUSDC
          </span>
        </div>
        <div className="mt-1 flex items-baseline gap-0.5">
          <span className="text-base font-black text-text-3">$</span>
          <span className="tnum truncate text-[28px] font-black leading-none text-text">{balance}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <MoneyButton to="/menu/deposit" icon={ArrowDownToLine} label="Deposit" primary />
        <MoneyButton to="/menu/withdraw" icon={ArrowUpFromLine} label="Withdraw" />
      </div>
    </div>
  )
}

function MoneyButton({
  to,
  icon: Icon,
  label,
  primary = false,
}: {
  to: string
  icon: LucideIcon
  label: string
  primary?: boolean
}) {
  const navigate = useNavigate()
  const go = () => {
    prepareMenuTransition('forward')
    void navigate({ to, viewTransition: true })
  }
  return (
    <div className="relative h-11">
      <Link
        to={to}
        viewTransition
        onClick={() => {
          prepareMenuTransition('forward')
          haptic('selection')
        }}
        className={cnm(
          'pointer-events-none flex h-11 items-center gap-1.5 rounded-full px-3.5 text-[12px] font-extrabold uppercase tracking-wide',
          primary ? 'btn-primary' : 'border border-white/10 bg-white/[0.05] text-text',
        )}
      >
        <Icon className="h-4 w-4" strokeWidth={2.6} />
        {label}
      </Link>
      <HapticOverlay className="absolute inset-0 rounded-full" preset="selection" silent onTap={go} />
    </div>
  )
}

function StatsSection() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const q = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() })
  const stats = q.data?.stats

  // The pen opens the handle editor: a plain menu sub-page with an input, pushed in with the drawer
  // transition (same as History / Settings).
  const editHandle = () => {
    prepareMenuTransition('forward')
    haptic('selection')
    void navigate({ to: '/menu/username', viewTransition: true })
  }

  if (q.isLoading) return <StatsCardSkeleton />
  if (!stats || stats.gamesPlayed === 0) {
    // No card yet (no plays). Keep the first-play nudge; the handle sits next to a pen to change it.
    return (
      <div className="surface-skeuo flex items-center gap-3 rounded-card p-4">
        <Illo name="vault" size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[15px] font-bold">{displayHandle(user)}</span>
            <div className="relative h-[1.375rem] w-[1.375rem] shrink-0">
              <button
                type="button"
                onClick={editHandle}
                aria-label="Change your handle"
                className="pointer-events-none flex h-full w-full items-center justify-center text-text-3 transition active:scale-90"
              >
                <Pencil className="h-3.5 w-3.5" strokeWidth={2.4} />
              </button>
              <HapticOverlay className="absolute inset-0" preset="selection" silent onTap={editHandle} />
            </div>
          </div>
          <div className="text-sm text-text-3">No plays yet. Make your first play.</div>
        </div>
        <div className="relative">
          <Link
            to="/games"
            onClick={() => haptic('medium')}
            className="pointer-events-none btn-primary flex rounded-full px-4 py-2 text-xs font-extrabold uppercase tracking-wide"
          >
            Play
          </Link>
          <HapticOverlay
            className="absolute inset-0 rounded-full"
            preset="medium"
            silent
            onTap={() => void navigate({ to: '/games' })}
          />
        </div>
      </div>
    )
  }

  return (
    <StatsCard stats={stats} displayName={displayHandle(user)} address={user?.address ?? ''} email={user?.email} onEdit={editHandle} />
  )
}

// Every destination as a compact 3x2 tile grid: the six stacked rows folded into two rows so the
// whole menu reads without scrolling. Icon over a one-line label, no subtitle needed at this size.
function NavGrid() {
  return (
    <div className="grid grid-cols-3 gap-3">
      <NavTile to="/menu/customize" icon="/assets/icons/icon-customize.webp" label="Customize" launch />
      <NavTile to="/menu/leaderboard" icon="/assets/icons/leaderboard-icon.webp" label="Leaderboard" />
      <NavTile to="/menu/referrals" icon="/assets/icons/icon-referrals.webp" label="Referrals" />
      <NavTile to="/menu/history" icon="/assets/icons/icon-history.webp" label="History" />
      <NavTile to="/menu/settings" icon="/assets/icons/icon-settings.webp" label="Settings" />
      <NavTile to="/menu/account" illo="vault" label="Account" />
    </div>
  )
}

function NavTile({
  to,
  icon,
  illo,
  label,
  launch = false,
}: {
  to: string
  icon?: string // png icon slot (the existing art)
  illo?: string // or an Illo name (e.g. Account's vault), for tiles without a dedicated png
  label: string
  // `launch` tiles hand off to a full takeover (the Customize studio): the drawer slides itself
  // away first, then routes, so it never just pops out from under the studio.
  launch?: boolean
}): ReactNode {
  const drawer = useMenuDrawer()
  const navigate = useNavigate()
  const activate = () => {
    if (launch && drawer) {
      drawer.closeTo(to)
      return
    }
    prepareMenuTransition('forward')
    haptic('selection')
    void navigate({ to, viewTransition: true })
  }
  return (
    <div className="relative">
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
        className="pointer-events-none surface-skeuo flex aspect-square flex-col items-center justify-center gap-2 rounded-card p-2 transition-transform active:scale-[0.97]"
      >
        {illo ? (
          <Illo name={illo} size={52} />
        ) : (
          <img src={icon} alt="" className="h-14 w-14 object-contain" draggable={false} />
        )}
        <span className="text-[13px] font-bold leading-none">{label}</span>
      </Link>
      <HapticOverlay className="absolute inset-0 rounded-card" preset="selection" silent onTap={activate} />
    </div>
  )
}

// A compact peek at the badges: a tappable header carrying the unlocked/total count that opens the
// full grid, over a slim rail of badge chips. The full-size cards live on /menu/achievements.
function AchievementsPeek() {
  const navigate = useNavigate()
  const q = useQuery({
    queryKey: ['achievements'],
    queryFn: () => api.achievements(),
  })

  const goToAll = () => {
    prepareMenuTransition('forward')
    void navigate({ to: '/menu/achievements', viewTransition: true })
  }

  if (q.isLoading) {
    return (
      <section className="flex flex-col gap-3">
        <PeekHeader onTap={goToAll} />
        <div className="-mx-4 flex gap-2.5 overflow-hidden px-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="shimmer h-16 w-16 shrink-0 rounded-2xl" />
          ))}
        </div>
      </section>
    )
  }

  const all = mergeCatalog(q.data?.achievements ?? [])
  const total = all.length
  const unlockedCount = all.filter((a) => a.unlocked).length
  // Lead with earned badges (the reward), then the closest in-progress ones (the motivation).
  const unlocked = all.filter((a) => a.unlocked)
  const inProgress = all
    .filter((a) => !a.unlocked && a.progress && a.progress.target > 0)
    .sort((a, b) => pct(b) - pct(a))
  const rail = [...unlocked, ...inProgress]

  return (
    <section className="flex flex-col gap-3">
      <PeekHeader onTap={goToAll} count={`${unlockedCount}/${total}`} />
      <div className="-mx-4 flex gap-2.5 overflow-x-auto px-4 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {rail.map((a) => (
          <BadgeThumb key={a.slug} a={a} />
        ))}
      </div>
    </section>
  )
}

function PeekHeader({ onTap, count }: { onTap: () => void; count?: string }) {
  return (
    <div className="relative">
      <Link
        to="/menu/achievements"
        viewTransition
        onClick={() => {
          prepareMenuTransition('forward')
          haptic('selection')
        }}
        className="pointer-events-none flex items-center justify-between px-1"
      >
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">Achievements</span>
        <span className="flex items-center gap-1 text-[13px] font-bold text-text-2">
          {count && <span className="tnum">{count}</span>}
          <span className="text-lg text-text-3">›</span>
        </span>
      </Link>
      <HapticOverlay className="absolute inset-0" preset="selection" silent onTap={onTap} />
    </div>
  )
}

// One badge as a small chip: full art when earned, a silhouette under a progress ring when not.
function BadgeThumb({ a }: { a: DisplayAchievement }): ReactNode {
  const p = pct(a)
  const { open } = useAchievementDetail()
  return (
    <button
      type="button"
      aria-label={`${a.name}, ${a.unlocked ? 'unlocked' : `${Math.round(p * 100)}% complete`}`}
      onClick={(e) => openFromCard(open, a, e)}
      className={cnm(
        'surface-skeuo relative flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl',
        cardPressClass,
      )}
    >
      {a.unlocked ? (
        <img
          src={achievementImage(a.slug)}
          alt=""
          className="h-11 w-11 object-contain drop-shadow-[0_6px_10px_rgba(0,0,0,0.4)]"
          draggable={false}
        />
      ) : (
        <>
          <img
            src={achievementImage(a.slug)}
            alt=""
            className="absolute h-8 w-8 object-contain brightness-0 contrast-200"
            draggable={false}
          />
          <ProgressRing value={p} />
        </>
      )}
    </button>
  )
}

// The sign-off: the proud badge as a slim footer signature, then a light Log out.
function Footer() {
  const { signOut } = useAuth()
  const doSignOut = () => {
    haptic('rigid')
    signOut()
  }
  return (
    <div className="mt-2 flex flex-col items-center gap-5 pt-2">
      <img
        src="/proud-badge.webp"
        alt="We think this is something Sui would be proud to have in the ecosystem."
        className="w-full select-none"
        draggable={false}
      />
      <div className="relative">
        <button
          type="button"
          className="pointer-events-none flex items-center gap-2 rounded-full border border-down/25 bg-down/[0.06] px-6 py-2.5 text-[13px] font-bold uppercase tracking-wide text-down/90 transition-transform active:scale-[0.97]"
        >
          <LogOut className="h-4 w-4" strokeWidth={2.4} />
          Log out
        </button>
        <HapticOverlay className="absolute inset-0 rounded-full" preset="rigid" silent onTap={doSignOut} />
      </div>
    </div>
  )
}

const pct = (a: DisplayAchievement): number =>
  a.progress && a.progress.target > 0
    ? Math.min(1, a.progress.current / a.progress.target)
    : 0

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
