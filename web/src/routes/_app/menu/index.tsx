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
import { useTour } from '@/components/console/tour'
import { StatsCard, StatsCardSkeleton } from '@/components/menu/StatsCard'
import { Avatar } from '@/components/Avatar'
import { SocialFooter } from '@/components/SocialFooter'
import { Button } from '@/ui/Button'
import { Illo } from '@/ui/Illo'
import { achievementImage, mergeCatalog } from '@/lib/achievements'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { haptic } from '@/lib/haptics'
import { HapticOverlay } from '@/components/HapticOverlay'
import { displayHandle, formatCompactMoney } from '@/utils/format'
import { cnm } from '@/utils/style'

// The menu home, rendered inside the bottom drawer: the trader card (pen opens the handle editor) up top,
// then the balance hero, a 3x2 nav tile grid, the achievements rail, and Log out.
export const Route = createFileRoute('/_app/menu/')({ component: MenuHome })

function MenuHome() {
  const { signOut } = useAuth()

  return (
    <div className="relative min-h-full bg-black px-4 pb-8">
      <MenuHeader title="Menu" showBack={false} />
      <div className="relative z-0 -mt-1 flex flex-col gap-6 pt-5">
        <StatsSection />
        <img
          src="/proud-badge.webp"
          alt="We think this is something Sui would be proud to have in the ecosystem."
          className="-my-3 w-full select-none"
          draggable={false}
        />
        <BalanceHero />
        <NavGrid />
        <AchievementsSection />
        <div className="flex flex-col gap-1.5">
          <HowItWorksRow />
          <AboutRow />
        </div>
        <div className="relative mt-16 w-full">
          <Button
            variant="danger"
            onClick={() => {
              haptic('rigid')
              signOut()
            }}
            className="pointer-events-none h-14 w-full rounded-card text-sm"
          >
            <LogOut className="h-5 w-5" strokeWidth={2.4} />
            Log out
          </Button>
          <HapticOverlay className="absolute inset-0 rounded-card" preset="rigid" silent onTap={signOut} />
        </div>
        <MenuFooter />
      </div>
    </div>
  )
}

// The drawer's foot: same compact one-row cluster as the landing door (X + DeepBook credit on one
// line, the no-token warning beneath).
function MenuFooter() {
  return <SocialFooter dense large className="mt-2 border-t border-line pt-7" />
}

// Replays the first-run console tour: close the drawer back to the device, then start the tour a beat
// later so the spotlight lands on a fully-revealed console, not the sliding drawer.
function HowItWorksRow() {
  const { start } = useTour()
  const drawer = useMenuDrawer()
  const run = () => {
    haptic('selection')
    drawer?.closeTo('/games')
    start({ force: true, delayMs: 460 })
  }
  return (
    <div className="relative">
      <button
        type="button"
        className="pointer-events-none surface-skeuo flex w-full items-center gap-3 rounded-card p-4 text-left transition-transform active:scale-[0.99]"
      >
        <img
          src="/assets/icons/icon-howitworks.webp"
          alt=""
          className="h-12 w-12 shrink-0 object-contain"
          draggable={false}
        />
        <span className="flex-1 text-[17px] font-bold">How it works</span>
        <span className="text-2xl text-text-3">›</span>
      </button>
      <HapticOverlay className="absolute inset-0 rounded-card" preset="selection" silent onTap={run} />
    </div>
  )
}

// About PIPS: credits + links on its own menu sub-page, pushed in with the drawer transition.
function AboutRow() {
  const navigate = useNavigate()
  const go = () => {
    prepareMenuTransition('forward')
    void navigate({ to: '/menu/about', viewTransition: true })
  }
  return (
    <div className="relative">
      <Link
        to="/menu/about"
        viewTransition
        onClick={() => {
          prepareMenuTransition('forward')
          haptic('selection')
        }}
        className="pointer-events-none surface-skeuo flex w-full items-center gap-3 rounded-card p-4 text-left transition-transform active:scale-[0.99]"
      >
        <img
          src="/assets/icons/icon-about.webp"
          alt=""
          className="h-12 w-12 shrink-0 object-contain"
          draggable={false}
        />
        <span className="flex-1 text-[17px] font-bold">About PIPS</span>
        <span className="text-2xl text-text-3">›</span>
      </Link>
      <HapticOverlay className="absolute inset-0 rounded-card" preset="selection" silent onTap={go} />
    </div>
  )
}

// The money card: balance on the left, Deposit and Withdraw right beside it so the card stays
// compact. Both push to their own screens with the native menu transition.
function BalanceHero() {
  const { user } = useAuth()
  const balance = formatCompactMoney(user?.balance ?? '0')

  return (
    <div className="card-neo rounded-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">My Balance</span>
        <span className="rounded-full bg-white/[0.06] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-text-2">
          DUSDC
        </span>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <img
            src="/assets/icons/dusdc-logo.webp"
            alt=""
            className="h-10 w-10 shrink-0 rounded-full"
            draggable={false}
          />
          <div className="flex min-w-0 items-baseline gap-0.5">
            <span className="text-xl font-black text-text-3">$</span>
            <span className="tnum truncate text-[34px] font-black leading-none text-text">{balance}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <MoneyButton to="/menu/deposit" icon={ArrowDownToLine} label="Deposit" primary />
          <MoneyButton to="/menu/withdraw" icon={ArrowUpFromLine} label="Send" />
        </div>
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
          'pointer-events-none flex h-11 items-center gap-1 rounded-xl px-2.5 text-[11px] font-extrabold uppercase tracking-wide',
          primary ? 'btn-primary' : 'border border-white/10 bg-white/[0.05] text-text',
        )}
      >
        <Icon className="h-[14px] w-[14px]" strokeWidth={2.6} />
        {label}
      </Link>
      <HapticOverlay className="absolute inset-0 rounded-xl" preset="selection" silent onTap={go} />
    </div>
  )
}

function StatsSection() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const q = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() })
  // Shares the Leaderboard screen's cache; feeds the card's "#4 TOP REKT" rank chip.
  const lbq = useQuery({ queryKey: ['leaderboard'], queryFn: () => api.leaderboard() })
  const stats = q.data?.stats
  const rank = lbq.data?.leaderboard.global.you ?? null

  // The pen opens the handle editor: a plain menu sub-page with an input, pushed in with the drawer
  // transition (same as History / Settings).
  const editHandle = () => {
    prepareMenuTransition('forward')
    haptic('selection')
    void navigate({ to: '/menu/username', viewTransition: true })
  }

  // Share opens the share screen (preview + what-to-show controls), pushed like any other menu sub-page.
  const openShare = () => {
    prepareMenuTransition('forward')
    haptic('medium')
    void navigate({ to: '/menu/share', viewTransition: true })
  }

  if (q.isLoading) return <StatsCardSkeleton />
  if (!stats || stats.gamesPlayed === 0) {
    // No card yet (no plays). Keep the first-play nudge; the handle sits next to a pen to change it.
    return (
      <div className="surface-skeuo flex items-center gap-3 rounded-card p-4">
        <Avatar name={displayHandle(user)} src={user?.avatarUrl} size={48} className="ring-1 ring-white/10" />
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
    <StatsCard
      stats={stats}
      displayName={displayHandle(user)}
      avatarUrl={user?.avatarUrl}
      twitter={user?.twitter}
      rank={rank}
      onEdit={editHandle}
      onShare={openShare}
    />
  )
}

// Every destination as a compact 3x2 tile grid: the six stacked rows folded into two rows so the
// whole menu reads without scrolling. A big icon over a one-line label, no subtitle at this size.
function NavGrid() {
  return (
    <div className="grid grid-cols-3 gap-3">
      {/* Row 1: your play world (your plays, your rank, your crew). */}
      <NavTile to="/menu/history" icon="/assets/icons/icon-history.webp" label="History" />
      <NavTile to="/menu/leaderboard" icon="/assets/icons/leaderboard-icon.webp" label="Leaderboard" />
      <NavTile to="/menu/referrals" icon="/assets/icons/icon-referrals.webp" label="Referrals" />
      {/* Row 2: make it yours + manage (skin, preferences, account). */}
      <NavTile to="/menu/customize" icon="/assets/icons/icon-customize.webp" label="Customize" launch />
      <NavTile to="/menu/settings" icon="/assets/icons/icon-settings.webp" label="Settings" />
      <NavTile to="/menu/account" icon="/assets/icons/icon-account-settings.webp" label="Account" />
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
        className="pointer-events-none surface-skeuo flex flex-col items-center justify-center gap-1.5 rounded-card px-1 pb-2.5 pt-2 transition-transform active:scale-[0.97]"
      >
        {illo ? (
          <Illo name={illo} size={68} />
        ) : (
          <img src={icon} alt="" className="h-[74px] w-[74px] object-contain" draggable={false} />
        )}
        <span className="mt-1 text-base font-bold leading-none">{label}</span>
      </Link>
      <HapticOverlay className="absolute inset-0 rounded-card" preset="selection" silent onTap={activate} />
    </div>
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
      <AllAchievementsRow />
    </section>
  )
}

function AllAchievementsRow() {
  const navigate = useNavigate()
  return (
    <div className="relative">
      <Link
        to="/menu/achievements"
        viewTransition
        onClick={() => {
          prepareMenuTransition('forward')
          haptic('selection')
        }}
        className="pointer-events-none block"
      >
        <div className="surface-skeuo flex items-center justify-between rounded-card p-4 transition-transform active:scale-[0.99]">
          <span className="text-[15px] font-bold">All Achievements</span>
          <span className="text-lg text-text-3">›</span>
        </div>
      </Link>
      <HapticOverlay
        className="absolute inset-0 rounded-card"
        preset="selection"
        silent
        onTap={() => {
          prepareMenuTransition('forward')
          void navigate({ to: '/menu/achievements', viewTransition: true })
        }}
      />
    </div>
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
  const { open } = useAchievementDetail()
  return (
    <button
      type="button"
      aria-label={`${a.name}, ${a.unlocked ? 'unlocked' : `${Math.round(p * 100)}% complete`}`}
      onClick={(e) => openFromCard(open, a, e)}
      className={cnm(
        'surface-skeuo flex w-[160px] shrink-0 flex-col gap-3 rounded-card p-4 text-left',
        cardPressClass,
      )}
    >
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
    </button>
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
