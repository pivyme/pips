import { Link, createFileRoute } from '@tanstack/react-router'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  History,
  LogOut,
  MoreHorizontal,
  Share2,
  Sparkles,
  Vibrate,
  Volume2,
  X,
} from 'lucide-react'
import { useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { UserStatsDTO } from '@/lib/api'
import { StatsCard, StatsCardSkeleton } from '@/components/menu/StatsCard'
import { ScreenEmpty, ScreenError } from '@/components/menu/shared'
import { Avatar } from '@/components/Avatar'
import { XGlyph } from '@/components/menu/BrandGlyphs'
import { Modal, useOverlayState } from '@/ui/Modal'
import { Switch } from '@/ui/Switch'
import { Button } from '@/ui/Button'
import { formatCompactMoney } from '@/utils/format'
import { cnm } from '@/utils/style'

// The App-Surface design system: the real menu-drawer vocabulary (docs/DESIGN.md), nothing from the
// in-device TE screen. Everything here is a faithful twin of what /menu/* actually renders, driven by
// mock data so it needs no auth, backend, or providers. StatsCard/Avatar/Modal/Switch/Button are the real
// components; the leaderboard/referral/history pieces mirror their route-inline originals class-for-class.
// The live /dev/design-system stays the full instrument reference; this is the trimmed App-Surface one.
export const Route = createFileRoute('/dev/design-system-v2')({ component: DesignSystemV2 })

// ── Mock data ────────────────────────────────────────────────────────────────

const MOCK_STATS: UserStatsDTO = {
  gamesPlayed: 342,
  wins: 198,
  losses: 144,
  winRate: 0.58,
  currentStreak: 4,
  maxStreak: 11,
  bestMultiplier: 47.3,
  totalVolume: '4820.50',
  netPnl: '1284.20',
}

interface LbEntry {
  rank: number
  username: string | null
  avatarUrl?: string | null
  twitterHandle?: string | null
  netPnl: string
  isYou?: boolean
}

const GAINERS: LbEntry[] = [
  { rank: 1, username: 'satoshimoon', twitterHandle: 'satoshimoon', netPnl: '8420.00' },
  { rank: 2, username: 'you', netPnl: '1284.20', isYou: true },
  { rank: 3, username: 'degenqueen', netPnl: '940.50' },
  { rank: 4, username: 'pipsniper', twitterHandle: 'pipsniper', netPnl: '612.00' },
  { rank: 5, username: null, netPnl: '318.75' },
  { rank: 6, username: 'longonly', netPnl: '204.10' },
]

// ── Page ─────────────────────────────────────────────────────────────────────

function DesignSystemV2() {
  return (
    <div className="min-h-dvh bg-canvas text-text">
      <header className="sticky top-0 z-30 border-b border-line bg-black/86 px-5 py-4 backdrop-blur-xl">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
          <Link
            to="/dev"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-surface text-text transition-transform active:scale-95"
            aria-label="Back to dev hub"
          >
            <ChevronLeft size={20} strokeWidth={2.2} />
          </Link>
          <div className="min-w-0 text-center">
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">App Surface</p>
            <h1 className="truncate text-lg font-extrabold tracking-tight sm:text-xl">Menu Design System</h1>
          </div>
          <div className="h-10 w-10" />
        </div>
      </header>

      <main className="mx-auto flex max-w-3xl flex-col gap-14 px-5 py-10">
        <p className="max-w-xl text-sm leading-6 text-text-2">
          The real drawer kit: rounded skeuo cards, warm amber accents, the exact components{' '}
          <span className="font-semibold text-text">/menu</span> renders. Everything below is on mock data,
          shown at true drawer width.
        </p>

        <Section eyebrow="Materials" title="Surfaces">
          <MaterialsShowcase />
        </Section>

        <Section eyebrow="Player card" title="Trader Card">
          <PlayerCardShowcase />
        </Section>

        <Section eyebrow="Balance" title="Money Card">
          <Frame>
            <BalanceCardDemo />
          </Frame>
        </Section>

        <Section eyebrow="Navigation" title="Menu Tiles">
          <Frame>
            <NavGridDemo />
          </Frame>
        </Section>

        <Section eyebrow="Rows" title="List Rows & Toggles">
          <Frame>
            <RowsShowcase />
          </Frame>
        </Section>

        <Section eyebrow="Leaderboard" title="Podium & Ranks">
          <Frame>
            <LeaderboardShowcase />
          </Frame>
        </Section>

        <Section eyebrow="Referrals" title="Earnings & Invite">
          <Frame>
            <ReferralsShowcase />
          </Frame>
        </Section>

        <Section eyebrow="History" title="Week Strip & Plays">
          <Frame>
            <HistoryShowcase />
          </Frame>
        </Section>

        <Section eyebrow="Buttons" title="Actions & Pills">
          <Frame>
            <ButtonsShowcase />
          </Frame>
        </Section>

        <Section eyebrow="States" title="Empty, Error, Loading">
          <Frame>
            <StatesShowcase />
          </Frame>
        </Section>
      </main>
    </div>
  )
}

// ── Layout ───────────────────────────────────────────────────────────────────

function Section({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-brand-500">{eyebrow}</p>
        <h2 className="mt-1.5 text-2xl font-extrabold tracking-tight">{title}</h2>
      </div>
      {children}
    </section>
  )
}

// The drawer is phone width on a black bg; render every showcase there so it reads exactly as it will in /menu.
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[430px] rounded-2xl border border-line-strong bg-black px-4 py-5">
      {children}
    </div>
  )
}

function Caption({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-center text-[11px] font-medium text-text-3">{children}</p>
}

// ── Materials ──────────────────────────────────────────────────────────────

function MaterialsShowcase() {
  const swatches: Array<{ cls: string; name: string; note: string }> = [
    { cls: 'surface-skeuo', name: 'surface-skeuo', note: 'Default row / tile' },
    { cls: 'card-neo', name: 'card-neo', note: 'Grouped container' },
    { cls: 'card-neo-active rounded-card', name: 'card-neo-active', note: 'Selected state' },
  ]
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {swatches.map((s) => (
        <div key={s.name} className="rounded-xl border border-line-strong bg-black p-3">
          <div className={cnm('h-16 rounded-card', s.cls)} />
          <div className="mt-3 font-mono text-[11px] text-text">{s.name}</div>
          <div className="text-[11px] text-text-3">{s.note}</div>
        </div>
      ))}
    </div>
  )
}

// ── Player card (real StatsCard) ─────────────────────────────────────────────

function PlayerCardShowcase() {
  return (
    <div className="flex flex-col gap-4">
      <Frame>
        <StatsCard
          stats={MOCK_STATS}
          displayName="@you"
          twitter={{ username: 'youonx' }}
          rank={{ gainerRank: 2, rektRank: null }}
          onEdit={() => {}}
          onShare={() => {}}
        />
        <Caption>StatsCard, menu-home variant (pen + share, rank chip)</Caption>
      </Frame>
      <Frame>
        <StatsCardSkeleton />
        <Caption>Loading skeleton</Caption>
      </Frame>
    </div>
  )
}

// ── Balance card (mirrors components/menu/BalanceCard) ────────────────────────

function BalanceCardDemo() {
  return (
    <div className="card-neo rounded-card relative p-4">
      <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">My Balance</span>
      <button
        type="button"
        aria-label="Activity"
        className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.06] text-text-2 transition-transform active:scale-95"
      >
        <History className="h-[17px] w-[17px]" strokeWidth={2.4} />
      </button>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <img src="/assets/icons/dusdc-logo.webp" alt="" className="h-10 w-10 shrink-0 rounded-full" draggable={false} />
          <div className="flex min-w-0 items-baseline gap-0.5">
            <span className="text-xl font-black text-text-3">$</span>
            <span className="tnum truncate text-[34px] font-black leading-none text-text">1,284.20</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <MoneyButton icon={ArrowDownToLine} label="Deposit" primary />
          <MoneyButton icon={ArrowUpFromLine} label="Send" />
        </div>
      </div>
    </div>
  )
}

function MoneyButton({ icon: Icon, label, primary = false }: { icon: LucideIcon; label: string; primary?: boolean }) {
  return (
    <button
      type="button"
      className={cnm(
        'flex h-11 items-center gap-1 rounded-xl px-2.5 text-[11px] font-extrabold uppercase tracking-wide transition-transform active:scale-95',
        primary ? 'btn-primary' : 'border border-white/10 bg-white/[0.05] text-text',
      )}
    >
      <Icon className="h-[14px] w-[14px]" strokeWidth={2.6} />
      {label}
    </button>
  )
}

// ── Nav tiles (mirrors the /menu 3x2 grid) ────────────────────────────────────

function NavGridDemo() {
  const tiles: Array<{ icon: string; label: string }> = [
    { icon: '/assets/icons/icon-history.webp', label: 'History' },
    { icon: '/assets/icons/leaderboard-icon.webp', label: 'Leaderboard' },
    { icon: '/assets/icons/icon-referrals.webp', label: 'Referrals' },
    { icon: '/assets/icons/icon-customize.webp', label: 'Customize' },
    { icon: '/assets/icons/icon-settings.webp', label: 'Settings' },
    { icon: '/assets/icons/icon-account-settings.webp', label: 'Account' },
  ]
  return (
    <div className="grid grid-cols-3 gap-3">
      {tiles.map((t) => (
        <button
          key={t.label}
          type="button"
          className="surface-skeuo flex flex-col items-center justify-center gap-1.5 rounded-card px-1 pb-2.5 pt-2 transition-transform active:scale-[0.97]"
        >
          <img src={t.icon} alt="" className="h-[74px] w-[74px] object-contain" draggable={false} />
          <span className="mt-1 text-base font-bold leading-none">{t.label}</span>
        </button>
      ))}
    </div>
  )
}

// ── List rows & toggles ───────────────────────────────────────────────────────

function RowsShowcase() {
  const [sound, setSound] = useState(true)
  const [haptics, setHaptics] = useState(true)
  const [motion, setMotion] = useState(false)
  return (
    <div className="flex flex-col gap-4">
      {/* Grouped settings rows: one card-neo, hairline dividers, a Switch per row. */}
      <div className="card-neo overflow-hidden rounded-card">
        <ToggleRow icon={Volume2} title="Sound" sub="Beeps and wins" on={sound} onChange={setSound} />
        <Divider />
        <ToggleRow icon={Vibrate} title="Haptics" sub="Buzz on taps and wins" on={haptics} onChange={setHaptics} />
        <Divider />
        <ToggleRow icon={Sparkles} title="Reduced motion" sub="Calmer animations" on={motion} onChange={setMotion} />
      </div>

      {/* Standalone chevron rows (How it works / About / All achievements). */}
      <button
        type="button"
        className="surface-skeuo flex w-full items-center gap-3 rounded-card p-4 text-left transition-transform active:scale-[0.99]"
      >
        <img src="/assets/icons/icon-history.webp" alt="" className="h-12 w-12 shrink-0 object-contain" draggable={false} />
        <span className="flex-1 text-[17px] font-bold">How it works</span>
        <span className="text-2xl text-text-3">›</span>
      </button>
      <button
        type="button"
        className="surface-skeuo flex w-full items-center justify-between rounded-card p-4 transition-transform active:scale-[0.99]"
      >
        <span className="text-[15px] font-bold">All Achievements</span>
        <ChevronRight size={18} className="text-text-3" strokeWidth={2.3} />
      </button>
    </div>
  )
}

function ToggleRow({
  icon: Icon,
  title,
  sub,
  on,
  onChange,
}: {
  icon: LucideIcon
  title: string
  sub: string
  on: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex min-h-16 items-center gap-3 px-4 py-3">
      <Icon size={18} className="shrink-0 text-text-2" strokeWidth={2.1} />
      <div className="min-w-0 flex-1">
        <p className="font-bold">{title}</p>
        <p className="text-sm text-text-2">{sub}</p>
      </div>
      <Switch label={title} isSelected={on} onChange={onChange} />
    </div>
  )
}

function Divider() {
  return <div className="h-px bg-line" />
}

// ── Leaderboard ────────────────────────────────────────────────────────────

type Board = 'gainers' | 'rekt'

const TIER = {
  1: { ink: '#ffd24a', ring: '#ffcf52', dark: '#e79a09', rgb: '255,192,22' },
  2: { ink: '#e6ebf1', ring: '#d4dce4', dark: '#98a4b0', rgb: '203,211,219' },
  3: { ink: '#eeb083', ring: '#dc9057', dark: '#b06a34', rgb: '214,139,84' },
} as const

function lbLabel(e: LbEntry): { display: string; seed: string } {
  const u = e.username?.trim()
  return u ? { display: `@${u.toLowerCase()}`, seed: u } : { display: 'Anon', seed: 'Anon' }
}

function money(net: string, board: Board): string {
  return `${board === 'gainers' ? '+' : '-'}$${formatCompactMoney(net)}`
}

function LeaderboardShowcase() {
  const [board, setBoard] = useState<Board>('gainers')
  const podium = GAINERS.slice(0, 3)
  const rest = GAINERS.slice(3)
  return (
    <div className="flex flex-col gap-4">
      <Segmented board={board} onChange={setBoard} />
      <div className="flex flex-col gap-3">
        {podium.map((e, i) => (
          <PodiumCard key={e.rank} e={e} board={board} tier={(i + 1) as 1 | 2 | 3} />
        ))}
        <div className="card-neo rounded-card px-4 py-1">
          {rest.map((e, i) => (
            <FlatRow key={e.rank} e={e} board={board} first={i === 0} />
          ))}
        </div>
      </div>
      <YourRankFooter board={board} />
    </div>
  )
}

function Segmented({ board, onChange }: { board: Board; onChange: (b: Board) => void }) {
  const segs: Array<{ key: Board; label: string; ink: string }> = [
    { key: 'gainers', label: 'Top Gainers', ink: 'text-up' },
    { key: 'rekt', label: 'Top REKT', ink: 'text-down' },
  ]
  const rgb = board === 'gainers' ? '52,211,153' : '255,90,77'
  return (
    <div className="surface-skeuo relative flex rounded-full p-1">
      <div
        aria-hidden
        className="absolute bottom-1 left-1 top-1 w-[calc((100%-8px)/2)] rounded-full transition-transform duration-300 ease-out-expo"
        style={{
          transform: board === 'rekt' ? 'translateX(100%)' : 'translateX(0)',
          background: `linear-gradient(180deg, rgba(${rgb},0.30), rgba(${rgb},0.13))`,
          boxShadow: `inset 0 1.5px 1.5px rgba(0,0,0,0.55), inset 0 -8px 11px -6px rgba(${rgb},0.75)`,
        }}
      />
      {segs.map((s) => (
        <button
          key={s.key}
          type="button"
          onClick={() => onChange(s.key)}
          className={cnm(
            'relative z-10 h-9 flex-1 rounded-full text-[13px] font-black uppercase tracking-[0.08em] transition-colors',
            board === s.key ? s.ink : 'text-text-3',
          )}
        >
          {s.label}
        </button>
      ))}
    </div>
  )
}

function PodiumCard({ e, board, tier }: { e: LbEntry; board: Board; tier: 1 | 2 | 3 }) {
  const t = TIER[tier]
  const l = lbLabel(e)
  return (
    <div className="card-neo relative overflow-hidden rounded-card">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-card"
        style={{ boxShadow: `inset 0 0 0 1px rgba(${t.rgb},0.18), inset 0 -22px 34px -24px rgba(${t.rgb},0.55)` }}
      />
      <div className="relative flex items-center gap-3.5 px-4 py-3.5">
        <PodiumAvatar name={l.seed} src={e.avatarUrl} tier={tier} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-[17px] font-black leading-tight" style={{ color: t.ink }}>
              {l.display}
            </span>
            {e.isYou && <YouPill />}
          </div>
          {e.twitterHandle && (
            <XHandle handle={e.twitterHandle} className="mt-1.5 max-w-full rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-medium" />
          )}
        </div>
        <span className="tnum shrink-0 text-[19px] font-black" style={{ color: t.ink }}>
          {money(e.netPnl, board)}
        </span>
      </div>
    </div>
  )
}

function PodiumAvatar({ name, src, tier }: { name: string; src?: string | null; tier: 1 | 2 | 3 }) {
  const t = TIER[tier]
  return (
    <div className="relative shrink-0" style={{ width: 52, height: 52 }}>
      <div className="rounded-full" style={{ boxShadow: `0 0 0 3px #0a0a0a, 0 0 0 5.5px ${t.ring}, 0 0 18px -3px rgba(${t.rgb},0.6)` }}>
        <Avatar name={name} src={src} size={52} className="block" />
      </div>
      <span
        className="tnum absolute -bottom-1 -right-1 flex h-[22px] w-[22px] items-center justify-center rounded-full text-[12px] font-black"
        style={{
          background: `linear-gradient(180deg, ${t.ring}, ${t.dark})`,
          color: '#1a1200',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.5), 0 2px 4px rgba(0,0,0,0.55), 0 0 0 2px #0a0a0a',
        }}
      >
        {tier}
      </span>
    </div>
  )
}

function FlatRow({ e, board, first }: { e: LbEntry; board: Board; first: boolean }) {
  const l = lbLabel(e)
  return (
    <div className={cnm('relative flex items-center gap-3 py-2.5', !first && 'border-t border-white/[0.05]')}>
      {e.isYou && (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 h-0 w-0 -translate-x-[11px] -translate-y-1/2 border-y-[5px] border-l-[7px] border-y-transparent border-l-brand-500"
        />
      )}
      <span className="tnum w-6 shrink-0 text-[13px] font-black text-text-3">{e.rank}</span>
      <Avatar name={l.seed} src={e.avatarUrl} size={32} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1.5">
          <span className={cnm('min-w-0 truncate text-[15px] font-bold leading-tight', e.isYou ? 'text-brand-400' : 'text-text')}>
            {l.display}
          </span>
          {e.isYou && <YouPill />}
        </div>
        {e.twitterHandle && <XHandle handle={e.twitterHandle} className="mt-0.5 text-[11px] font-normal" />}
      </div>
      <span className={cnm('tnum shrink-0 text-[15px] font-black', board === 'gainers' ? 'text-up' : 'text-down')}>
        {money(e.netPnl, board)}
      </span>
    </div>
  )
}

function YouPill() {
  return (
    <span className="shrink-0 rounded bg-brand-500/15 px-1 py-px text-[9px] font-black uppercase tracking-wide text-brand-400">
      You
    </span>
  )
}

function XHandle({ handle, className }: { handle: string; className?: string }) {
  return (
    <span className={cnm('inline-flex w-fit items-center gap-1 text-text-2', className)}>
      <XGlyph className="h-2.5 w-2.5 shrink-0 text-text" />
      <span className="truncate">@{handle}</span>
    </span>
  )
}

function YourRankFooter({ board }: { board: Board }) {
  const rgb = board === 'gainers' ? '52,211,153' : '255,90,77'
  const rank = board === 'gainers' ? 2 : null
  const ranked = rank != null
  return (
    <div
      className="relative flex items-center gap-3 rounded-2xl px-3.5 py-3"
      style={{
        background: 'linear-gradient(180deg,#2c2b27 0%,#211f1c 52%,#171613 100%)',
        border: '1px solid #3a3730',
        boxShadow:
          'inset 0 1px 0 rgba(255,214,120,0.22), inset 0 -1px 3px rgba(0,0,0,0.6), 0 1px 0 #060606, 0 28px 46px -16px rgba(0,0,0,0.96)',
      }}
    >
      <div className="shrink-0 rounded-full" style={{ boxShadow: '0 0 0 2.5px #0a0a0a, 0 0 0 4.5px rgba(255,192,22,0.85)' }}>
        <Avatar name="you" size={46} className="block" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-black uppercase tracking-[0.02em] text-brand-400">Your rank</div>
        <div className="mt-0.5 truncate text-[17px] font-bold">
          {ranked ? (
            <span className="text-up">
              +$1,284.20 <span className="font-normal text-text-3">PnL</span>
            </span>
          ) : (
            <span className="text-text-3">Not in {board} yet</span>
          )}
        </div>
      </div>
      <div
        className="flex h-12 min-w-[74px] items-center justify-center rounded-xl px-3"
        style={{
          background: 'linear-gradient(180deg,#0c0c0b,#050505)',
          boxShadow: `inset 0 1px 0 #242422, inset 0 3px 9px rgba(0,0,0,0.75), inset 0 0 0 1px rgba(${rgb},${ranked ? 0.18 : 0.06})`,
        }}
      >
        <span
          className="tnum text-[27px] font-black leading-none"
          style={{ color: ranked ? `rgb(${rgb})` : '#7a7a7a', textShadow: ranked ? `0 0 13px rgba(${rgb},0.6)` : 'none' }}
        >
          {ranked ? `#${rank}` : '#--'}
        </span>
      </div>
    </div>
  )
}

// ── Referrals ──────────────────────────────────────────────────────────────

function ReferralsShowcase() {
  const [copied, setCopied] = useState(false)
  const fmt = useOverlayState()
  const referrals = [
    { handle: 'degenqueen', joined: 'Jul 18, 2026', plays: 42, earned: '18.40' },
    { handle: 'pipsniper', joined: 'Jul 12, 2026', plays: 128, earned: '64.10' },
  ]
  const claims = [
    { amount: '48.00', status: 'paid' as const, date: 'Jul 20, 2026' },
    { amount: '12.50', status: 'pending' as const, date: 'Jul 23, 2026' },
  ]
  return (
    <div className="flex flex-col gap-6">
      {/* Earnings hero: amber inner glow, claimable big, Claim button, summary strip. */}
      <div
        className="rounded-card border border-brand-500/25 p-4"
        style={{
          background: 'linear-gradient(180deg,#1c1810 0%,#141109 56%,#0c0a05 100%)',
          boxShadow:
            'inset 0 0 64px rgba(255,192,22,0.20), inset 0 1px 0 rgba(255,224,138,0.22), inset 0 0 0 1px rgba(255,192,22,0.10), 0 22px 44px -30px rgba(0,0,0,0.95)',
        }}
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-brand-300/80">Claimable rewards</span>
          <span className="text-[12px] font-semibold text-brand-300/60">25% of trading fees</span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-4">
          <div className="tnum text-[38px] font-black leading-none text-white">$60.50</div>
          <button type="button" className="btn-primary flex h-[46px] items-center justify-center rounded-xl px-6 text-[15px] font-extrabold">
            Claim
          </button>
        </div>
        <div className="mt-4 grid grid-cols-3 divide-x divide-white/[0.08] overflow-hidden rounded-xl border border-white/[0.06] bg-black/30">
          <SummaryCell label="Referred" value="12" />
          <SummaryCell label="Earned" value="$142.60" gold />
          <SummaryCell label="Claimed" value="$82.10" />
        </div>
      </div>

      {/* Invite link: dark skeuo plate, crisp amber edge, tap-to-copy pill. */}
      <div
        className="rounded-card p-5"
        style={{
          background: 'linear-gradient(180deg, #111110 0%, #0d0d0d 56%, #090909 100%)',
          border: '1.5px solid rgba(255,192,22,0.45)',
          boxShadow: 'inset 0 0 0 1px rgba(255,192,22,0.10), inset 0 1px 0 #242422, inset 0 -1px 4px rgba(0,0,0,0.46), 0 1px 0 #050505',
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-[17px] font-black leading-none text-white">Your invite link</span>
          <button
            type="button"
            onClick={() => fmt.open()}
            aria-label="Link format"
            className="-mr-1.5 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-white/70 transition-transform active:scale-90"
          >
            <MoreHorizontal className="h-5 w-5" strokeWidth={2.6} />
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          }}
          className="mt-4 flex w-full items-center gap-2 rounded-full border border-white/[0.12] bg-white/[0.05] py-3 pl-5 pr-2.5 text-left transition-transform active:scale-[0.99]"
        >
          <span className="tnum min-w-0 flex-1 truncate text-[15px] font-semibold text-white/90">playpips.fun/@you</span>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/70">
            {copied ? <Check className="h-[18px] w-[18px] text-up" strokeWidth={2.8} /> : <Copy className="h-[18px] w-[18px]" strokeWidth={2.4} />}
          </span>
        </button>
      </div>

      {/* Referral rows. */}
      <div className="flex flex-col gap-2">
        <span className="px-1 text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">My referrals · 12</span>
        {referrals.map((r) => (
          <div key={r.handle} className="surface-skeuo flex items-center justify-between gap-3 rounded-card p-4">
            <div className="min-w-0">
              <div className="truncate text-[15px] font-bold">@{r.handle}</div>
              <div className="text-sm text-text-3">Joined {r.joined} · {r.plays} plays</div>
            </div>
            <div className="shrink-0 text-right">
              <div className="tnum text-[15px] font-extrabold text-brand-400">+${r.earned}</div>
              <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-text-3">earned</div>
            </div>
          </div>
        ))}
      </div>

      {/* Claim history. */}
      <div className="flex flex-col gap-2">
        <span className="px-1 text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">Claim history</span>
        {claims.map((c, i) => (
          <ClaimRow key={i} amount={c.amount} status={c.status} date={c.date} />
        ))}
      </div>

      <FormatModal isOpen={fmt.isOpen} onOpenChange={fmt.setOpen} />
    </div>
  )
}

function SummaryCell({ label, value, gold }: { label: string; value: string; gold?: boolean }) {
  return (
    <div className="min-w-0 px-3 py-2.5 text-center">
      <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-white/50">{label}</div>
      <div className={cnm('tnum mt-1 truncate text-[16px] font-extrabold', gold ? 'text-brand-400' : 'text-white')}>{value}</div>
    </div>
  )
}

function ClaimRow({ amount, status, date }: { amount: string; status: 'paid' | 'pending' | 'failed'; date: string }) {
  const pill =
    status === 'paid'
      ? { label: 'Paid', cls: 'bg-up/15 text-up' }
      : status === 'pending'
        ? { label: 'Processing', cls: 'bg-brand-500/15 text-brand-400' }
        : { label: 'Failed', cls: 'bg-down/15 text-down' }
  return (
    <div className="surface-skeuo flex items-center justify-between gap-3 rounded-card p-4">
      <div className="min-w-0">
        <div className="tnum text-[15px] font-extrabold text-white">${amount}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[13px] text-text-3">
          <span>{date}</span>
          {status === 'paid' && (
            <>
              <span className="text-text-3">·</span>
              <span className="inline-flex items-center gap-1 text-text-2">
                Receipt
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={2.4} />
              </span>
            </>
          )}
        </div>
      </div>
      <span className={cnm('shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.08em]', pill.cls)}>{pill.label}</span>
    </div>
  )
}

function FormatModal({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const [anon, setAnon] = useState(false)
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="sm" placement="center" className="border border-line bg-[#161615]">
      <button
        type="button"
        onClick={() => onOpenChange(false)}
        aria-label="Close"
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.06] text-white/70 transition-transform active:scale-90"
      >
        <X className="h-[18px] w-[18px]" strokeWidth={2.6} />
      </button>
      <h2 className="pr-10 text-[19px] font-black leading-none text-white">Link format</h2>
      <p className="mt-2 text-[15px] leading-snug text-text-3">Pick how your invite link looks.</p>
      <div className="mt-5 flex flex-col gap-2">
        <FormatRow label="Use My Username" sub="playpips.fun/@you" selected={!anon} onTap={() => setAnon(false)} />
        <FormatRow label="Anonymous" sub="playpips.fun/r/CODE" selected={anon} onTap={() => setAnon(true)} />
      </div>
    </Modal>
  )
}

function FormatRow({ label, sub, selected, onTap }: { label: string; sub: string; selected: boolean; onTap: () => void }) {
  return (
    <button
      type="button"
      onClick={onTap}
      className="surface-skeuo flex w-full items-center justify-between rounded-card p-4 text-left transition-transform active:scale-[0.99]"
    >
      <div className="min-w-0">
        <div className="text-[16px] font-bold text-white">{label}</div>
        <div className="truncate text-sm text-text-3">{sub}</div>
      </div>
      <span className={cnm('flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2', selected ? 'border-brand-500 bg-brand-500' : 'border-line-strong')}>
        {selected && <Check className="h-4 w-4 text-black" strokeWidth={3} />}
      </span>
    </button>
  )
}

// ── History ────────────────────────────────────────────────────────────────

interface HistPlay {
  game: string
  asset: string
  line: string
  status: 'won' | 'lost' | 'cashed_out'
  headline: string
  label: string
  positive: boolean
  ago: string
}

const HIST_PLAYS: HistPlay[] = [
  { game: 'lucky', asset: 'BTC', line: 'UP · 12.4x', status: 'won', headline: '+$62.00', label: 'Won', positive: true, ago: '2m ago' },
  { game: 'range', asset: 'ETH', line: 'Range · 0.8% band', status: 'lost', headline: '-$5.00', label: 'Lost', positive: false, ago: '18m ago' },
  { game: 'moonshot', asset: 'SUI', line: 'LONG · 47.3x', status: 'cashed_out', headline: '+$28.40', label: 'Cashed', positive: true, ago: '1h ago' },
]

const WEEK: Array<{ label: string; net: number; today?: boolean; empty?: boolean }> = [
  { label: 'Mon', net: 42.5 },
  { label: 'Tue', net: -18 },
  { label: 'Wed', net: 0, empty: true },
  { label: 'Thu', net: 96 },
  { label: 'Fri', net: -30.4 },
  { label: 'Sat', net: 12 },
  { label: 'Today', net: 58, today: true },
]

function tileMag(abs: number): string {
  if (abs >= 1000) return formatCompactMoney(abs.toString())
  if (abs >= 100) return Math.round(abs).toString()
  const oneDp = Math.round(abs * 10) / 10
  return Number.isInteger(oneDp) ? oneDp.toString() : oneDp.toFixed(1)
}

function HistoryShowcase() {
  const [filter, setFilter] = useState('all')
  const filters = ['all', 'lucky', 'range', 'moonshot']
  const net = WEEK.reduce((s, c) => s + c.net, 0)
  const rows = filter === 'all' ? HIST_PLAYS : HIST_PLAYS.filter((p) => p.game === filter)
  return (
    <div className="flex flex-col gap-4">
      {/* Week strip: amber-framed hero plate, 7 tinted day cells. */}
      <div
        className="rounded-card border-[1.5px] border-brand-500 p-4"
        style={{
          background: 'linear-gradient(180deg,#2a2619 0%,#1c1913 52%,#131110 100%)',
          boxShadow:
            'inset 0 1px 0 rgba(255,229,158,0.34), inset 0 -2px 8px rgba(0,0,0,0.5), 0 2px 0 rgba(0,0,0,0.6), 0 0 28px -4px rgba(255,192,22,0.55)',
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-text-3">Last 7 days</div>
            <div className="mt-1 flex items-center gap-1.5 text-[12px] font-bold">
              <span className="tnum text-up">12W</span>
              <span className="text-text-3">·</span>
              <span className="tnum text-down">7L</span>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className={cnm('tnum text-[20px] font-extrabold leading-none', net > 0 ? 'text-up' : net < 0 ? 'text-down' : 'text-text-2')}>
              {net > 0 ? '+' : net < 0 ? '-' : ''}${formatCompactMoney(Math.abs(net).toString())}
            </div>
            <div className="mt-1 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-text-3">Net</div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-7 gap-1.5">
          {WEEK.map((c) => {
            const tone = c.empty || c.net === 0 ? 'flat' : c.net > 0 ? 'up' : 'down'
            const fill = tone === 'up' ? 'rgba(52,211,153,0.2)' : tone === 'down' ? 'rgba(255,90,77,0.2)' : 'rgba(255,255,255,0.05)'
            return (
              <div key={c.label} className="flex flex-col items-center gap-1">
                <span className={cnm('font-mono text-[9px] font-semibold uppercase tracking-[0.08em]', c.today ? 'text-brand-500' : 'text-text-3')}>
                  {c.label}
                </span>
                <div
                  className={cnm('flex h-[54px] w-full items-center justify-center rounded-xl px-0.5', tone === 'flat' && 'border border-white/[0.07]')}
                  style={{ backgroundColor: fill }}
                >
                  {c.empty ? (
                    <span className="text-[16px] font-bold text-text-3/60">·</span>
                  ) : (
                    <span className={cnm('tnum text-[15px] font-extrabold leading-none', tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text-2')}>
                      {c.net > 0 ? '+' : c.net < 0 ? '-' : ''}
                      {tileMag(Math.abs(c.net))}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Filter pills. */}
      <div className="flex gap-2">
        {filters.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cnm(
              'rounded-full px-4 py-2 text-xs font-extrabold uppercase tracking-wide transition-colors',
              filter === f ? 'bg-white/[0.92] text-black' : 'surface-skeuo text-text-2',
            )}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Play rows (tap opens the detail modal). */}
      <div className="flex flex-col gap-2.5">
        {rows.map((p, i) => (
          <HistoryRow key={i} play={p} />
        ))}
      </div>
    </div>
  )
}

function HistoryRow({ play }: { play: HistPlay }) {
  const detail = useOverlayState()
  return (
    <div className="surface-skeuo flex items-stretch overflow-hidden rounded-card">
      <button
        type="button"
        onClick={() => detail.open()}
        className="flex min-w-0 flex-1 items-center justify-between gap-3 p-4 text-left transition-transform active:scale-[0.99]"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-bold capitalize">{play.game}</span>
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-text-2">{play.asset}</span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-[13px] text-text-2">
            <span>{play.line}</span>
            <span className="text-text-3">·</span>
            <span className="text-text-3">{play.ago}</span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className={cnm('text-[11px] font-bold uppercase tracking-wide', play.positive ? 'text-up' : 'text-down')}>{play.label}</div>
          <div className={cnm('tnum text-[17px] font-extrabold leading-tight', play.positive ? 'text-up' : 'text-down')}>{play.headline}</div>
        </div>
      </button>
      <button
        type="button"
        aria-label="Share this play"
        className="flex items-center border-l border-white/[0.06] px-3 text-brand-300 transition-transform active:scale-90"
      >
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.05]">
          <Share2 className="h-[17px] w-[17px]" strokeWidth={2.6} />
        </span>
      </button>
      <PlayDetailModal play={play} isOpen={detail.isOpen} onOpenChange={detail.setOpen} />
    </div>
  )
}

function PlayDetailModal({ play, isOpen, onOpenChange }: { play: HistPlay; isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const [showDetails, setShowDetails] = useState(false)
  const positive = play.positive
  const tone = positive ? 'text-up' : 'text-down'
  const title = play.status === 'cashed_out' ? 'Cashed out' : positive ? 'Profit' : 'Rekt'
  const detailRows: Array<[string, string]> = [
    ['Duration', '30s'],
    ['Multiplier', play.line.split('· ')[1] ?? '—'],
    ['Entry price', '$117,240'],
    ['Settlement price', '$117,880'],
    ['Selected stake', '$5.00'],
    ['Payout', play.headline.replace('-', '')],
  ]
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="md" placement="center" className="border border-line bg-[#161615]">
      <button
        type="button"
        onClick={() => onOpenChange(false)}
        aria-label="Close"
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.06] text-white/70 transition-transform active:scale-90"
      >
        <X className="h-[18px] w-[18px]" strokeWidth={2.6} />
      </button>
      <h2 className="pr-10 font-sans text-[22px] font-black uppercase leading-none text-white">{title}</h2>

      <div className="mt-4 flex flex-col gap-3 pb-1">
        {/* Hero: outcome-tinted skeuo plate, big PnL, three stat cells. */}
        <div
          className="rounded-card px-4 py-5 text-center"
          style={
            positive
              ? {
                  background: 'linear-gradient(180deg,#17352a 0%,#102a20 52%,#0b1f18 100%)',
                  boxShadow: 'inset 0 1px 0 rgba(148,233,192,0.14), inset 0 -2px 8px rgba(0,0,0,0.45), 0 1px 0 rgba(0,0,0,0.6)',
                }
              : {
                  background: 'linear-gradient(180deg,#3a1d19 0%,#2b1512 52%,#1f100e 100%)',
                  boxShadow: 'inset 0 1px 0 rgba(255,170,160,0.12), inset 0 -2px 8px rgba(0,0,0,0.45), 0 1px 0 rgba(0,0,0,0.6)',
                }
          }
        >
          <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-white/50">
            <span className="capitalize">{play.game}</span> · {play.asset} · Jul 24, 5:27 AM
          </div>
          <div className={cnm('tnum mt-2.5 text-[40px] font-black leading-none', tone)}>{play.headline}</div>
          <div className="mt-5 grid grid-cols-3 gap-2">
            <HeroStat label="Amount" value="$5.00" />
            <HeroStat label="Multiplier" value={play.line.split('· ')[1] ?? '—'} />
            <HeroStat label="PnL" value={positive ? '+248%' : '-100%'} tone={tone} />
          </div>
        </div>

        {/* Share CTA. */}
        <div className="surface-skeuo flex items-center justify-between gap-3 rounded-card px-4 py-3.5">
          <div className="min-w-0">
            <div className="text-[15px] font-bold text-white">{positive ? 'Share your gain' : 'Share your rekt'}</div>
            <div className="mt-0.5 text-[12px] leading-snug text-text-3">Turn this play into a card.</div>
          </div>
          <button type="button" className="btn-primary flex items-center gap-2 rounded-full px-5 py-2.5 text-[13px] font-extrabold uppercase tracking-wide">
            <Share2 className="h-[15px] w-[15px]" strokeWidth={2.6} />
            Share
          </button>
        </div>

        {/* Collapsible trade details. */}
        <div className="surface-skeuo rounded-card">
          <button type="button" onClick={() => setShowDetails((s) => !s)} className="flex w-full items-center justify-between px-4 py-3.5 text-left">
            <span className="text-[14px] font-bold text-text">Trade details</span>
            <ChevronDown className={cnm('h-5 w-5 text-text-3 transition-transform', showDetails && 'rotate-180')} strokeWidth={2.4} />
          </button>
          {showDetails && (
            <div className="border-t border-white/[0.06] px-4 pb-4 pt-3">
              <div className="flex flex-col gap-y-2">
                {detailRows.map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-[11px] uppercase tracking-wide text-text-3">{k}</span>
                    <span className="tnum truncate text-right text-[13px] font-semibold text-text-2">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

function HeroStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl bg-black/[0.22] px-2 py-2.5 text-center shadow-[inset_0_1px_3px_rgba(0,0,0,0.35)]">
      <div className={cnm('tnum text-[15px] font-extrabold leading-none', tone ?? 'text-white')}>{value}</div>
      <div className="mt-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-white/40">{label}</div>
    </div>
  )
}

// ── Buttons & pills ──────────────────────────────────────────────────────────

function ButtonsShowcase() {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3">
        <Button variant="primary" className="w-full">Primary</Button>
        <Button variant="secondary" className="w-full">Secondary</Button>
        <Button variant="ghost" className="w-full">Ghost</Button>
        <Button variant="danger" className="w-full">
          <LogOut className="h-4 w-4" strokeWidth={2.4} />
          Danger
        </Button>
      </div>

      <div className="flex flex-col gap-2.5">
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">Raw classes</span>
        <div className="flex flex-wrap gap-3">
          <button type="button" className="btn-primary flex h-11 items-center justify-center rounded-xl px-6 text-[15px] font-extrabold">
            btn-primary
          </button>
          <button type="button" className="btn-muted flex h-11 items-center justify-center rounded-xl px-6 text-[15px] font-extrabold">
            btn-muted
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">Pills</span>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-text-2">BTC</span>
          <YouPill />
          <span className="rounded-full bg-up/15 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.08em] text-up">Paid</span>
          <span className="rounded-full bg-brand-500/15 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.08em] text-brand-400">Processing</span>
          <span className="rounded-full bg-down/15 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.08em] text-down">Failed</span>
        </div>
      </div>
    </div>
  )
}

// ── States ─────────────────────────────────────────────────────────────────

function StatesShowcase() {
  return (
    <div className="flex flex-col gap-5">
      <div className="card-neo rounded-card">
        <ScreenEmpty title="No plays yet" sub="Play your first game and it'll show up here." />
      </div>
      <div className="card-neo rounded-card">
        <ScreenError message="Could not load your history." onRetry={() => {}} />
      </div>
      <div className="flex flex-col gap-2.5">
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">Skeletons</span>
        {[0, 1].map((i) => (
          <div key={i} className="surface-skeuo flex items-center gap-3 rounded-card p-3.5">
            <div className="shimmer h-10 w-10 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="shimmer h-3.5 w-28 rounded" />
              <div className="shimmer h-3 w-16 rounded" />
            </div>
            <div className="shimmer h-4 w-14 shrink-0 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}
