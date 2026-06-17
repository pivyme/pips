import { Link, createFileRoute } from '@tanstack/react-router'
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Medal,
  Play,
  Sparkles,
  Trophy,
  Vibrate,
  Volume2,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Illo } from '@/ui/Illo'
import { cnm } from '@/utils/style'

export const Route = createFileRoute('/design-system')({
  component: DesignSystemPage,
})

const MENU_ITEMS = [
  { illo: 'trophy', title: 'Stats', sub: 'Your record' },
  { illo: 'medal', title: 'Achievements', sub: "What you've unlocked" },
  { illo: 'gem', title: 'Customize', sub: 'Make it yours' },
  { illo: 'gear', title: 'Settings', sub: 'Sound, haptics, motion' },
] as const

const ACHIEVEMENTS = [
  { illo: 'coin', title: 'First win', status: 'Unlocked', tone: 'up' },
  {
    illo: 'flame',
    title: 'Mini streak',
    status: '3/5',
    tone: 'amber',
    progress: 60,
  },
  { illo: 'bolt', title: 'Quick tap', status: 'Locked', tone: 'locked' },
  {
    illo: 'target',
    title: 'Close call',
    status: '8/10',
    tone: 'amber',
    progress: 80,
  },
] as const

const TOKENS = [
  { name: 'Canvas', value: 'bg-canvas', label: '#000' },
  { name: 'Surface', value: 'bg-surface', label: 'Card base' },
  { name: 'Surface 2', value: 'bg-surface-2', label: 'Selected' },
  { name: 'Amber', value: 'bg-brand-500', label: 'Primary' },
  { name: 'Up', value: 'bg-up', label: 'Win' },
  { name: 'Down', value: 'bg-down', label: 'Loss' },
  { name: 'Info', value: 'bg-info', label: 'Neutral' },
  { name: 'Premium', value: 'bg-premium-500', label: 'Special' },
] as const

function DesignSystemPage() {
  return (
    <div className="min-h-dvh bg-canvas text-text">
      <header className="sticky top-0 z-20 border-b border-line bg-black/86 px-5 py-4 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <Link
            to="/"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-surface text-text transition-transform active:scale-95"
            aria-label="Back to Pips"
          >
            <ChevronLeft size={20} strokeWidth={2.2} />
          </Link>
          <div className="min-w-0 text-center">
            <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-text-3">
              Reference
            </p>
            <h1 className="truncate text-xl font-extrabold tracking-tight sm:text-2xl">
              Pips Design System
            </h1>
          </div>
          <div className="h-10 w-10" />
        </div>
      </header>

      <main className="mx-auto flex max-w-7xl flex-col gap-16 px-5 py-8 sm:px-8 lg:py-12">
        <section className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <div>
            <Illo name="console" size={112} />
            <p className="mt-6 text-[11px] font-bold uppercase tracking-[0.1em] text-brand-500">
              North star
            </p>
            <h2 className="mt-3 max-w-xl text-4xl font-extrabold leading-[0.98] tracking-tight sm:text-6xl">
              Black canvas. Warm cards. Electric game screen.
            </h2>
            <p className="mt-5 max-w-lg text-base leading-7 text-text-2">
              The app surface is glossy and calm. The in-console game UI is
              flat, sparse, and high contrast.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-line bg-white/[0.025] p-4">
              <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.1em] text-text-3">
                App Surface
              </p>
              <div className="space-y-3">
                {MENU_ITEMS.slice(0, 3).map((item) => (
                  <MenuCard key={item.title} {...item} />
                ))}
              </div>
            </div>

            <GameScreen title="Lucky" status="BTC / 10s">
              <LuckyPreview />
            </GameScreen>
          </div>
        </section>

        <Section eyebrow="Tokens" title="Color, Type, Material">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {TOKENS.map((token) => (
              <div
                key={token.name}
                className="rounded-lg border border-line bg-white/[0.025] p-3"
              >
                <div
                  className={cnm(
                    'h-16 rounded-md border border-white/10',
                    token.value,
                  )}
                />
                <div className="mt-3 flex items-baseline justify-between gap-3">
                  <span className="text-sm font-bold">{token.name}</span>
                  <span className="text-xs font-semibold text-text-3">
                    {token.label}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="card-neo p-5">
              <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-text-3">
                Typography
              </p>
              <div className="mt-5 space-y-4">
                <div>
                  <p className="text-4xl font-extrabold leading-none tracking-tight">
                    Gabarito
                  </p>
                  <p className="mt-2 text-sm text-text-2">
                    Rounded, direct, built for big numbers.
                  </p>
                </div>
                <div className="grid grid-cols-3 gap-3 text-center">
                  <NumberSample value="$24.80" label="Balance" />
                  <NumberSample value="+12.4%" label="Live" tone="up" />
                  <NumberSample value="08s" label="Timer" tone="amber" />
                </div>
              </div>
            </div>

            <div className="card-neo-active rounded-card p-5">
              <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-brand-500">
                Active Surface
              </p>
              <h3 className="mt-4 text-2xl font-extrabold tracking-tight">
                Selected card state
              </h3>
              <p className="mt-2 text-sm leading-6 text-text-2">
                Amber only marks the current choice or primary action.
              </p>
              <button
                type="button"
                className="btn-primary mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-md text-sm"
              >
                <Check size={17} strokeWidth={2.4} />
                Selected
              </button>
            </div>

            <div className="rounded-lg border border-line bg-white/[0.025] p-5">
              <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-text-3">
                Flat Screen Rules
              </p>
              <div className="mt-5 screen rounded-card p-4">
                <div className="grid grid-cols-2 gap-2">
                  <ScreenMetric label="LIVE" value="+$18.42" tone="up" />
                  <ScreenMetric label="PAYOUT" value="$42.00" />
                  <ScreenMetric label="SIDE" value="LONG" tone="amber" />
                  <ScreenMetric label="ENDS" value="09s" />
                </div>
              </div>
            </div>
          </div>
        </Section>

        <Section eyebrow="Regular UI" title="Menus, Achievements, Settings">
          <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
            <PreviewShell title="Menu">
              <div className="space-y-3">
                {MENU_ITEMS.map((item) => (
                  <MenuCard key={item.title} {...item} />
                ))}
              </div>
            </PreviewShell>

            <PreviewShell title="Achievements">
              <div className="mb-4 flex items-center justify-between">
                <p className="text-sm font-semibold text-text-2">
                  7 of 20 unlocked
                </p>
                <button
                  type="button"
                  className="rounded-full border border-line px-3 py-1.5 text-xs font-bold text-text-2"
                >
                  All achievements
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {ACHIEVEMENTS.map((achievement) => (
                  <AchievementTile key={achievement.title} {...achievement} />
                ))}
              </div>
            </PreviewShell>
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <PreviewShell title="Grouped Rows">
              <div className="card-neo overflow-hidden">
                <SettingRow
                  icon={Volume2}
                  title="Sound"
                  sub="Beeps and wins"
                  control={<Toggle on />}
                />
                <Divider />
                <SettingRow
                  icon={Vibrate}
                  title="Haptics"
                  sub="Buzz on taps and wins"
                  control={<Toggle on />}
                />
                <Divider />
                <SettingRow
                  icon={Sparkles}
                  title="Reduced motion"
                  sub="Calmer animations"
                  control={<Toggle />}
                />
              </div>
            </PreviewShell>

            <PreviewShell title="Stats">
              <div className="card-neo overflow-hidden">
                <StatRow icon={Trophy} label="Win rate" value="62%" />
                <Divider />
                <StatRow
                  icon={Zap}
                  label="Current streak"
                  value="4"
                  tone="amber"
                />
                <Divider />
                <StatRow
                  icon={CircleDollarSign}
                  label="Net P&L"
                  value="+$184.20"
                  tone="up"
                />
              </div>
              <button
                type="button"
                className="btn-primary mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-md text-sm"
              >
                <Sparkles size={16} strokeWidth={2.4} />
                Share card
              </button>
            </PreviewShell>

            <PreviewShell title="States">
              <div className="grid gap-3">
                <StateBlock
                  tone="neutral"
                  title="No plays yet"
                  sub="Make your first play."
                />
                <div className="card-neo flex items-center gap-3 p-4">
                  <div className="shimmer h-12 w-12 rounded-2xl" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="shimmer h-3 w-28 rounded-full" />
                    <div className="shimmer h-3 w-40 rounded-full" />
                  </div>
                </div>
                <StateBlock
                  tone="down"
                  title="Could not load"
                  sub="Retry inline, keep it calm."
                />
              </div>
            </PreviewShell>
          </div>
        </Section>

        <Section eyebrow="Game UI" title="Inside The Console Screen">
          <div className="grid gap-5 lg:grid-cols-3">
            <GameScreen title="I Feel Lucky" status="SUI / LIVE">
              <LuckyPreview />
            </GameScreen>
            <GameScreen title="Range" status="ETH / 30s">
              <RangePreview />
            </GameScreen>
            <GameScreen title="Tap" status="BTC / 10s">
              <TapPreview />
            </GameScreen>
          </div>

          <div className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
            <GameScreen title="Result Moment" status="SETTLED">
              <div className="flex min-h-[300px] flex-col items-center justify-center text-center">
                <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">
                  Round complete
                </p>
                <p className="mt-4 text-5xl font-black leading-none tracking-tight text-up">
                  +$28.40
                </p>
                <p className="mt-2 text-lg font-extrabold">In the zone.</p>
                <button
                  type="button"
                  className="mt-8 flex h-10 items-center gap-2 rounded-md border border-up/40 bg-up/15 px-4 text-xs font-black uppercase tracking-[0.1em] text-up"
                >
                  <Play size={14} fill="currentColor" strokeWidth={2.2} />
                  Next
                </button>
              </div>
            </GameScreen>

            <div className="rounded-lg border border-line bg-white/[0.025] p-5">
              <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-text-3">
                Screen Components
              </p>
              <div className="mt-5 grid gap-3">
                <ScreenComponent
                  label="Primary readout"
                  value="+$12.80"
                  tone="up"
                />
                <ScreenComponent
                  label="Active choice"
                  value="LONG"
                  tone="amber"
                />
                <ScreenComponent
                  label="Risk / loss"
                  value="-$4.00"
                  tone="down"
                />
                <ScreenComponent label="Neutral status" value="12s" />
              </div>
            </div>
          </div>
        </Section>
      </main>
    </div>
  )
}

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string
  title: string
  children: ReactNode
}) {
  return (
    <section className="space-y-5">
      <div>
        <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-text-3">
          {eyebrow}
        </p>
        <h2 className="mt-2 text-3xl font-extrabold tracking-tight sm:text-4xl">
          {title}
        </h2>
      </div>
      {children}
    </section>
  )
}

function PreviewShell({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <div className="rounded-lg border border-line bg-white/[0.025] p-4">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-text-3">
          {title}
        </p>
        <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
      </div>
      {children}
    </div>
  )
}

function MenuCard({
  illo,
  title,
  sub,
}: {
  illo: string
  title: string
  sub: string
}) {
  return (
    <div className="card-neo flex items-center gap-3 p-3 transition-transform active:scale-[0.99]">
      <Illo name={illo} size={56} />
      <div className="min-w-0 flex-1">
        <span className="text-[17px] font-bold">{title}</span>
        <div className="truncate text-sm text-text-2">{sub}</div>
      </div>
      <ChevronRight size={18} className="text-text-3" strokeWidth={2.3} />
    </div>
  )
}

function AchievementTile({
  illo,
  title,
  status,
  tone,
  progress,
}: {
  illo: string
  title: string
  status: string
  tone: 'up' | 'amber' | 'locked'
  progress?: number
}) {
  return (
    <div
      className={cnm(
        'card-neo flex min-h-36 flex-col items-center gap-2 p-3 text-center',
        tone === 'locked' && 'opacity-45',
      )}
    >
      <Illo
        name={illo}
        size={50}
        className={tone === 'locked' ? 'grayscale' : undefined}
      />
      <div className="flex flex-1 items-center text-[12px] font-extrabold leading-tight">
        {title}
      </div>
      <div
        className={cnm(
          'text-[9px] font-black uppercase tracking-[0.08em]',
          tone === 'up' && 'text-up',
          tone === 'amber' && 'text-brand-500',
          tone === 'locked' && 'text-text-3',
        )}
      >
        {status}
      </div>
      {progress != null && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-black/50">
          <div
            className="h-full rounded-full bg-brand-500/80"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </div>
  )
}

function Toggle({ on = false }: { on?: boolean }) {
  return (
    <span
      className={cnm(
        'relative h-7 w-12 rounded-full transition-colors',
        on
          ? 'bg-gradient-to-b from-brand-400 to-brand-600 shadow-[0_4px_16px_-2px_rgba(255,192,22,0.45)]'
          : 'bg-surface-2',
      )}
    >
      <span
        className={cnm(
          'absolute top-1 h-5 w-5 rounded-full bg-text transition-transform',
          on ? 'translate-x-6' : 'translate-x-1',
        )}
      />
    </span>
  )
}

function SettingRow({
  icon: Icon,
  title,
  sub,
  control,
}: {
  icon: LucideIcon
  title: string
  sub: string
  control: ReactNode
}) {
  return (
    <div className="flex min-h-16 items-center gap-3 px-4 py-3">
      <Icon size={18} className="shrink-0 text-text-2" strokeWidth={2.1} />
      <div className="min-w-0 flex-1">
        <p className="font-bold">{title}</p>
        <p className="text-sm text-text-2">{sub}</p>
      </div>
      {control}
    </div>
  )
}

function StatRow({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: LucideIcon
  label: string
  value: string
  tone?: 'up' | 'down' | 'amber'
}) {
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-3">
      <Icon size={18} className="shrink-0 text-text-2" strokeWidth={2.1} />
      <span className="flex-1 text-sm font-semibold text-text-2">{label}</span>
      <span
        className={cnm(
          'tnum text-sm font-black',
          tone === 'up' && 'text-up',
          tone === 'down' && 'text-down',
          tone === 'amber' && 'text-brand-500',
        )}
      >
        {value}
      </span>
    </div>
  )
}

function StateBlock({
  tone,
  title,
  sub,
}: {
  tone: 'neutral' | 'down'
  title: string
  sub: string
}) {
  const Icon = tone === 'down' ? AlertTriangle : Medal
  return (
    <div className="card-neo flex items-center gap-3 p-4">
      <div
        className={cnm(
          'flex h-12 w-12 items-center justify-center rounded-2xl',
          tone === 'down'
            ? 'bg-down/10 text-down'
            : 'bg-surface-2 text-brand-500',
        )}
      >
        <Icon size={20} strokeWidth={2.2} />
      </div>
      <div>
        <p className="font-bold">{title}</p>
        <p className="text-sm text-text-2">{sub}</p>
      </div>
    </div>
  )
}

function Divider() {
  return <div className="h-px bg-line" />
}

function NumberSample({
  value,
  label,
  tone,
}: {
  value: string
  label: string
  tone?: 'up' | 'down' | 'amber'
}) {
  return (
    <div className="rounded-md bg-black/35 p-3">
      <p
        className={cnm(
          'tnum text-lg font-black',
          tone === 'up' && 'text-up',
          tone === 'down' && 'text-down',
          tone === 'amber' && 'text-brand-500',
        )}
      >
        {value}
      </p>
      <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.08em] text-text-3">
        {label}
      </p>
    </div>
  )
}

function GameScreen({
  title,
  status,
  children,
}: {
  title: string
  status: string
  children: ReactNode
}) {
  return (
    <div className="screen overflow-hidden rounded-card border border-line">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.12em] text-text-3">
            Game
          </p>
          <h3 className="text-lg font-black tracking-tight">{title}</h3>
        </div>
        <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.1em] text-brand-500">
          <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
          {status}
        </div>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function LuckyPreview() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <Reel label="Leverage" value="25x" />
        <Reel label="Asset" value="BTC" />
        <Reel label="Side" value="LONG" tone="up" />
      </div>
      <MiniChart tone="up" />
      <div className="flex items-end justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.12em] text-text-3">
            Live
          </p>
          <p className="tnum text-4xl font-black leading-none text-up">
            +$18.42
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-black uppercase tracking-[0.12em] text-text-3">
            Payout
          </p>
          <p className="tnum text-lg font-black text-text-2">$42.00</p>
        </div>
      </div>
    </div>
  )
}

function RangePreview() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        <ScreenMetric label="Range" value="±0.8%" tone="amber" />
        <ScreenMetric label="Multiplier" value="12.4x" tone="amber" />
      </div>
      <MiniChart tone="amber" band />
      <div className="grid grid-cols-3 gap-2">
        {['10s', '30s', '60s'].map((duration) => (
          <div
            key={duration}
            className={cnm(
              'rounded-md border px-3 py-2 text-center text-xs font-black',
              duration === '30s'
                ? 'border-brand-500 bg-brand-500 text-black'
                : 'border-line text-text-2',
            )}
          >
            {duration}
          </div>
        ))}
      </div>
    </div>
  )
}

function TapPreview() {
  const boxes = [
    'border-up/50 bg-up/12',
    'border-line bg-white/[0.025]',
    'border-brand-500/60 bg-brand-500/12',
    'border-line bg-white/[0.025]',
    'border-down/50 bg-down/12',
    'border-line bg-white/[0.025]',
  ]
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <ScreenMetric label="Tap $" value="$5" tone="amber" />
        <ScreenMetric label="Open" value="3/6" />
      </div>
      <div className="grid h-44 grid-cols-3 gap-2">
        {boxes.map((box, index) => (
          <div key={index} className={cnm('rounded-md border', box)} />
        ))}
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold text-text-3">
          Tap a box. Catch the move.
        </p>
        <p className="tnum text-lg font-black text-up">+$8.10</p>
      </div>
    </div>
  )
}

function Reel({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'up' | 'down' | 'amber'
}) {
  return (
    <div className="rounded-md border border-line bg-white/[0.025] p-3">
      <p className="text-[9px] font-black uppercase tracking-[0.1em] text-text-3">
        {label}
      </p>
      <p
        className={cnm(
          'tnum mt-2 text-xl font-black',
          tone === 'up' && 'text-up',
          tone === 'down' && 'text-down',
          tone === 'amber' && 'text-brand-500',
        )}
      >
        {value}
      </p>
    </div>
  )
}

function ScreenMetric({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'up' | 'down' | 'amber'
}) {
  return (
    <div className="min-w-0 rounded-md border border-line bg-white/[0.025] px-3 py-2">
      <p className="truncate text-[9px] font-black uppercase tracking-[0.1em] text-text-3">
        {label}
      </p>
      <p
        className={cnm(
          'tnum truncate text-lg font-black',
          tone === 'up' && 'text-up',
          tone === 'down' && 'text-down',
          tone === 'amber' && 'text-brand-500',
        )}
      >
        {value}
      </p>
    </div>
  )
}

function ScreenComponent({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'up' | 'down' | 'amber'
}) {
  return (
    <div className="screen rounded-md border border-line p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[10px] font-black uppercase tracking-[0.1em] text-text-3">
          {label}
        </span>
        <span
          className={cnm(
            'tnum text-base font-black',
            tone === 'up' && 'text-up',
            tone === 'down' && 'text-down',
            tone === 'amber' && 'text-brand-500',
          )}
        >
          {value}
        </span>
      </div>
    </div>
  )
}

function MiniChart({
  tone,
  band = false,
}: {
  tone: 'up' | 'down' | 'amber'
  band?: boolean
}) {
  return (
    <div className="relative h-44 overflow-hidden rounded-md border border-line bg-black">
      <div className="absolute inset-0 opacity-60 [background-image:linear-gradient(rgba(255,255,255,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.045)_1px,transparent_1px)] [background-size:28px_28px]" />
      {band && (
        <div className="absolute inset-x-4 top-14 h-16 rounded-md border border-brand-500/50 bg-brand-500/10">
          <div className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-brand-500/70" />
        </div>
      )}
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 320 176"
        role="img"
        aria-label="Price preview"
      >
        <path
          d="M0 112 C42 94 62 126 96 98 C128 72 154 88 184 62 C222 30 250 52 320 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          className={cnm(
            tone === 'up' && 'text-up',
            tone === 'down' && 'text-down',
            tone === 'amber' && 'text-brand-500',
          )}
        />
      </svg>
      <div className="absolute left-4 top-4 rounded-full border border-line bg-black/70 px-3 py-1 text-[10px] font-black uppercase tracking-[0.1em] text-text-2">
        Live mark
      </div>
      <div className="absolute bottom-4 right-4 h-2 w-2 rounded-full bg-brand-500 shadow-[0_0_18px_rgba(255,192,22,0.75)]" />
    </div>
  )
}
