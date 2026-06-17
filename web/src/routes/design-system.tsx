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
import { useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Illo } from '@/ui/Illo'
import {
  ArcGauge,
  AssetList,
  BetFader,
  CountdownRing,
  DepthLadder,
  DepthSurface,
  DirectionPad,
  ExposureBars,
  GaugeCluster,
  LeverageLadder,
  LiquidationBar,
  LuckyWheel,
  OrderTicket,
  PayoutCurve,
  PlayFlow,
  PnlReadout,
  PriceChart,
  PriceTape,
  RadialMeter,
  ResultBurst,
  RoundTimeline,
  StatGrid,
  StatusBadge,
  StatusStrip,
  StrikeReticle,
  TapGrid,
  VolatilityScan,
  VolumeBars,
} from '@/components/game/instruments'
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
  const [activeMenu, setActiveMenu] = useState('Achievements')
  const [achievementView, setAchievementView] = useState<'all' | 'unlocked'>(
    'all',
  )
  const [selectedAchievement, setSelectedAchievement] = useState('First win')
  const [settings, setSettings] = useState({
    sound: true,
    haptics: true,
    reducedMotion: false,
  })

  const visibleAchievements =
    achievementView === 'all'
      ? ACHIEVEMENTS
      : ACHIEVEMENTS.filter((achievement) => achievement.tone !== 'locked')

  const toggleSetting = (key: keyof typeof settings) => {
    setSettings((current) => ({ ...current, [key]: !current[key] }))
  }

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
            <DesignIllo name="console" size={112} />
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
            <div className="surface-skeuo rounded-lg p-4">
              <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.1em] text-text-3">
                App Surface
              </p>
              <div className="space-y-3">
                {MENU_ITEMS.slice(0, 3).map((item) => (
                  <MenuCard
                    key={item.title}
                    {...item}
                    selected={activeMenu === item.title}
                    onPress={() => setActiveMenu(item.title)}
                  />
                ))}
              </div>
            </div>

            <GameScreen title="Lucky" status="BTC / 10s">
              <LuckyPreview />
            </GameScreen>
          </div>
        </section>

        <GameLab />

        <Section eyebrow="Tokens" title="Color, Type, Material">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {TOKENS.map((token) => (
              <div key={token.name} className="surface-skeuo rounded-lg p-3">
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

            <div className="surface-skeuo rounded-lg p-5">
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
                  <MenuCard
                    key={item.title}
                    {...item}
                    selected={activeMenu === item.title}
                    onPress={() => setActiveMenu(item.title)}
                  />
                ))}
              </div>
            </PreviewShell>

            <PreviewShell title="Achievements">
              <div className="mb-4 flex items-center justify-between">
                <p className="text-sm font-semibold text-text-2">
                  {achievementView === 'all'
                    ? '7 of 20 unlocked'
                    : 'Unlocked only'}
                </p>
                <button
                  type="button"
                  onClick={() =>
                    setAchievementView((current) =>
                      current === 'all' ? 'unlocked' : 'all',
                    )
                  }
                  className="rounded-full border border-line px-3 py-1.5 text-xs font-bold text-text-2 transition-colors active:bg-surface-2"
                >
                  {achievementView === 'all' ? 'Unlocked' : 'All achievements'}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {visibleAchievements.map((achievement) => (
                  <AchievementTile
                    key={achievement.title}
                    {...achievement}
                    selected={selectedAchievement === achievement.title}
                    onPress={() => setSelectedAchievement(achievement.title)}
                  />
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
                  control={
                    <Toggle
                      label="Sound"
                      on={settings.sound}
                      onToggle={() => toggleSetting('sound')}
                    />
                  }
                />
                <Divider />
                <SettingRow
                  icon={Vibrate}
                  title="Haptics"
                  sub="Buzz on taps and wins"
                  control={
                    <Toggle
                      label="Haptics"
                      on={settings.haptics}
                      onToggle={() => toggleSetting('haptics')}
                    />
                  }
                />
                <Divider />
                <SettingRow
                  icon={Sparkles}
                  title="Reduced motion"
                  sub="Calmer animations"
                  control={
                    <Toggle
                      label="Reduced motion"
                      on={settings.reducedMotion}
                      onToggle={() => toggleSetting('reducedMotion')}
                    />
                  }
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
                  <div className="shimmer h-12 w-12 rounded-md" />
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

            <div className="surface-skeuo rounded-lg p-5">
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
    <div className="surface-skeuo rounded-lg p-4">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-text-3">
          {title}
        </p>
      </div>
      {children}
    </div>
  )
}

function DesignIllo({
  name,
  size,
  className,
}: {
  name: string
  size: number
  className?: string
}) {
  return <Illo name={name} size={size} className={className} showGlow={false} />
}

function MenuCard({
  illo,
  title,
  sub,
  selected = false,
  onPress,
}: {
  illo: string
  title: string
  sub: string
  selected?: boolean
  onPress?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-pressed={selected}
      className={cnm(
        'flex w-full items-center gap-3 p-3 text-left transition-transform active:scale-[0.99]',
        selected ? 'card-neo-active rounded-card' : 'card-neo',
      )}
    >
      <DesignIllo name={illo} size={56} />
      <div className="min-w-0 flex-1">
        <span className="text-[17px] font-bold">{title}</span>
        <div className="truncate text-sm text-text-2">{sub}</div>
      </div>
      <ChevronRight size={18} className="text-text-3" strokeWidth={2.3} />
    </button>
  )
}

function AchievementTile({
  illo,
  title,
  status,
  tone,
  progress,
  selected = false,
  onPress,
}: {
  illo: string
  title: string
  status: string
  tone: 'up' | 'amber' | 'locked'
  progress?: number
  selected?: boolean
  onPress?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-pressed={selected}
      className={cnm(
        'flex min-h-36 flex-col items-center gap-2 p-3 text-center transition-transform active:scale-[0.98]',
        selected ? 'card-neo-active rounded-card' : 'card-neo',
        tone === 'locked' && 'opacity-45',
      )}
    >
      <DesignIllo
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
    </button>
  )
}

function Toggle({
  label,
  on = false,
  onToggle,
}: {
  label: string
  on?: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      onClick={onToggle}
      className={cnm('pips-switch-control', on && 'pips-switch-control-on')}
    >
      <span
        className={cnm('pips-switch-thumb', on && 'pips-switch-thumb-on')}
      />
    </button>
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
          'flex h-12 w-12 items-center justify-center rounded-md',
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
        <div className="text-[10px] font-black uppercase tracking-[0.1em] text-brand-500">
          {status}
        </div>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function LuckyPreview() {
  const [side, setSide] = useState<'LONG' | 'SHORT'>('LONG')
  const isLong = side === 'LONG'

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <Reel label="Leverage" value="25x" />
        <Reel label="Asset" value="BTC" />
        <Reel
          label="Side"
          value={side}
          tone={isLong ? 'up' : 'down'}
          onPress={() =>
            setSide((current) => (current === 'LONG' ? 'SHORT' : 'LONG'))
          }
        />
      </div>
      <MiniChart tone={isLong ? 'up' : 'down'} />
      <div className="flex items-end justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.12em] text-text-3">
            Live
          </p>
          <p
            className={cnm(
              'tnum text-4xl font-black leading-none',
              isLong ? 'text-up' : 'text-down',
            )}
          >
            {isLong ? '+$18.42' : '-$6.10'}
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
  const durations = ['10s', '30s', '60s'] as const
  const [duration, setDuration] = useState<(typeof durations)[number]>('30s')
  const multiplier =
    duration === '10s' ? '7.6x' : duration === '30s' ? '12.4x' : '18.8x'

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        <ScreenMetric label="Range" value="±0.8%" tone="amber" />
        <ScreenMetric label="Multiplier" value={multiplier} tone="amber" />
      </div>
      <MiniChart tone="amber" band />
      <div className="grid grid-cols-3 gap-2">
        {durations.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setDuration(option)}
            aria-pressed={duration === option}
            className={cnm(
              'rounded-md border px-3 py-2 text-center text-xs font-black transition-transform active:scale-95',
              duration === option
                ? 'border-brand-500 bg-brand-500 text-black'
                : 'border-line text-text-2',
            )}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  )
}

function TapPreview() {
  const [activeBoxes, setActiveBoxes] = useState([0, 2, 4])
  const toggleBox = (index: number) => {
    setActiveBoxes((current) =>
      current.includes(index)
        ? current.filter((active) => active !== index)
        : [...current, index],
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <ScreenMetric label="Tap $" value="$5" tone="amber" />
        <ScreenMetric label="Open" value={`${activeBoxes.length}/6`} />
      </div>
      <div className="grid h-44 grid-cols-3 gap-2">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <button
            key={index}
            type="button"
            onClick={() => toggleBox(index)}
            aria-pressed={activeBoxes.includes(index)}
            className={cnm(
              'rounded-md border transition-transform active:scale-95',
              activeBoxes.includes(index)
                ? index % 2 === 0
                  ? 'border-up/50 bg-up/12'
                  : 'border-down/50 bg-down/12'
                : 'border-line bg-white/[0.025]',
            )}
          />
        ))}
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold text-text-3">
          Tap a box. Catch the move.
        </p>
        <p className="tnum text-lg font-black text-up">
          +${(activeBoxes.length * 2.7).toFixed(2)}
        </p>
      </div>
    </div>
  )
}

function Reel({
  label,
  value,
  tone,
  onPress,
}: {
  label: string
  value: string
  tone?: 'up' | 'down' | 'amber'
  onPress?: () => void
}) {
  const content = (
    <>
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
    </>
  )

  if (onPress) {
    return (
      <button
        type="button"
        onClick={onPress}
        className="rounded-md border border-line bg-white/[0.025] p-3 text-left transition-transform active:scale-95"
      >
        {content}
      </button>
    )
  }

  return (
    <div className="rounded-md border border-line bg-white/[0.025] p-3">
      {content}
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
      <div
        className={cnm(
          'absolute bottom-4 right-4 h-6 w-px',
          tone === 'up' && 'bg-up',
          tone === 'down' && 'bg-down',
          tone === 'amber' && 'bg-brand-500',
        )}
      />
    </div>
  )
}

// ── Teenage-engineering game-screen lab ────────────────────────────────────
// A filterable bench of the vivid-line instruments. Each tile is a real screen
// (true black, faint vignette, registration ticks) so a piece reads as it will
// inside the console. Pick what fits a game, the rest is reference.

type LabCat = 'chart' | 'gauge' | 'timer' | 'input' | 'status' | 'schematic' | 'hero'

interface LabItem {
  id: string
  name: string
  hint: string
  cat: LabCat
  render: (frozen: boolean) => ReactNode
}

const LAB_CATS: Array<{ key: LabCat | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'chart', label: 'Charts' },
  { key: 'gauge', label: 'Gauges' },
  { key: 'timer', label: 'Timers' },
  { key: 'input', label: 'Inputs' },
  { key: 'status', label: 'Status' },
  { key: 'schematic', label: 'Schematic' },
  { key: 'hero', label: 'Hero' },
]

const LAB: Array<LabItem> = [
  // Price / charts
  { id: 'tape-up', name: 'Price tape', hint: 'Live BTC price streaming in. The signature trace.', cat: 'chart', render: (f) => <PriceTape hue="up" frozen={f} /> },
  { id: 'tape-down', name: 'Price tape · short', hint: 'Same trace, tinted to a short.', cat: 'chart', render: (f) => <PriceTape hue="down" frozen={f} /> },
  { id: 'chart-up', name: 'Price chart', hint: 'Price line, entry level, glowing live mark.', cat: 'chart', render: (f) => <PriceChart hue="up" frozen={f} /> },
  { id: 'chart-down', name: 'Price chart · down', hint: 'Bearish read of the same chart.', cat: 'chart', render: (f) => <PriceChart hue="down" frozen={f} /> },
  { id: 'payout', name: 'Payout curve', hint: 'Multiplier peaks at the strike. Range game.', cat: 'chart', render: (f) => <PayoutCurve hue="amber" frozen={f} /> },
  { id: 'volume', name: 'Volume bars', hint: '24h volume by bucket, live.', cat: 'chart', render: (f) => <VolumeBars hue="info" frozen={f} /> },
  { id: 'depth', name: 'Order book', hint: 'Mirrored bid / ask depth around the mid.', cat: 'chart', render: (f) => <DepthLadder frozen={f} /> },

  // Gauges / meters
  { id: 'gauge-lev', name: 'Leverage dial', hint: 'VU-style dial with a needle.', cat: 'gauge', render: (f) => <ArcGauge hue="info" value={0.5} display="25×" label="LEVERAGE" frozen={f} /> },
  { id: 'gauge-odds', name: 'Odds dial', hint: 'Same dial, win probability.', cat: 'gauge', render: (f) => <ArcGauge hue="amber" value={0.68} display="68%" label="ODDS" frozen={f} /> },
  { id: 'gauge-win', name: 'Win-rate dial', hint: 'Up-tinted for a positive stat.', cat: 'gauge', render: (f) => <ArcGauge hue="up" value={0.8} display="80%" label="WIN RATE" frozen={f} /> },
  { id: 'cluster', name: 'Gauge cluster', hint: 'Four readouts at once: lev, odds, size, risk.', cat: 'gauge', render: (f) => <GaugeCluster frozen={f} /> },
  { id: 'radial-margin', name: 'Margin meter', hint: 'Ring + big number. Margin used.', cat: 'gauge', render: (f) => <RadialMeter hue="violet" value={0.74} display="74%" sub="MARGIN" frozen={f} /> },
  { id: 'radial-streak', name: 'Streak meter', hint: 'Win streak / progress.', cat: 'gauge', render: (f) => <RadialMeter hue="amber" value={0.6} display="x4" sub="STREAK" frozen={f} /> },
  { id: 'betfader', name: 'Bet amount', hint: 'On-screen twin of the knob. Stake slider.', cat: 'gauge', render: (f) => <BetFader hue="amber" value={0.62} frozen={f} /> },
  { id: 'exposure', name: 'Long / short', hint: 'Net exposure, segmented.', cat: 'gauge', render: (f) => <ExposureBars frozen={f} /> },

  // Timers
  { id: 'countdown-down', name: 'Expiry ring', hint: 'Depleting arc to settlement.', cat: 'timer', render: (f) => <CountdownRing hue="down" frozen={f} /> },
  { id: 'countdown-amber', name: 'Expiry · amber', hint: 'Calmer countdown variant.', cat: 'timer', render: (f) => <CountdownRing hue="amber" frozen={f} /> },
  { id: 'timeline', name: 'Round timeline', hint: 'Open → now → settle, with time left.', cat: 'timer', render: (f) => <RoundTimeline hue="amber" frozen={f} /> },
  { id: 'scan-cyan', name: 'Volatility scan', hint: 'Sweep markets for a move. Lucky pre-spin.', cat: 'timer', render: (f) => <VolatilityScan hue="cyan" frozen={f} /> },
  { id: 'scan-violet', name: 'Volatility · violet', hint: 'Same sweep, special moments.', cat: 'timer', render: (f) => <VolatilityScan hue="violet" frozen={f} /> },

  // Inputs
  { id: 'dpad-long', name: 'Long / short pad', hint: 'Direction select, bound to Action 1/2.', cat: 'input', render: (f) => <DirectionPad active="up" frozen={f} /> },
  { id: 'dpad-short', name: 'Pad · short', hint: 'Short selected state.', cat: 'input', render: (f) => <DirectionPad active="down" frozen={f} /> },
  { id: 'ladder', name: 'Leverage ladder', hint: 'Pick a rung: 2× to 100×.', cat: 'input', render: (f) => <LeverageLadder hue="amber" frozen={f} /> },
  { id: 'tap', name: 'Tap grid', hint: 'The Tap game, sweeping playhead.', cat: 'input', render: (f) => <TapGrid hue="amber" frozen={f} /> },
  { id: 'assets', name: 'Market picker', hint: 'Asset list with live change.', cat: 'input', render: () => <AssetList hue="amber" /> },
  { id: 'reticle-amber', name: 'Strike reticle', hint: 'Entry / strike targeting for Range.', cat: 'input', render: (f) => <StrikeReticle hue="amber" frozen={f} /> },
  { id: 'reticle-info', name: 'Reticle · info', hint: 'Neutral targeting variant.', cat: 'input', render: (f) => <StrikeReticle hue="info" frozen={f} /> },

  // Status / readouts
  { id: 'badge-live', name: 'Status · live', hint: 'Position open, blinking dot.', cat: 'status', render: (f) => <StatusBadge state="live" frozen={f} /> },
  { id: 'badge-flat', name: 'Status · flat', hint: 'No position, waiting.', cat: 'status', render: (f) => <StatusBadge state="flat" frozen={f} /> },
  { id: 'badge-placing', name: 'Status · placing', hint: 'Order going on-chain.', cat: 'status', render: (f) => <StatusBadge state="placing" frozen={f} /> },
  { id: 'badge-armed', name: 'Status · armed', hint: 'Ready to fire, amber.', cat: 'status', render: (f) => <StatusBadge state="armed" frozen={f} /> },
  { id: 'pnl-up', name: 'P&L readout', hint: 'Giant live P&L with payout line.', cat: 'status', render: () => <PnlReadout hue="up" value="+$18.42" label="LIVE P&L" /> },
  { id: 'pnl-down', name: 'P&L · loss', hint: 'Negative mark.', cat: 'status', render: () => <PnlReadout hue="down" value="-$6.10" label="LIVE P&L" /> },
  { id: 'ticket', name: 'Order ticket', hint: 'Position at a glance: side, entry, liq, P&L.', cat: 'status', render: (f) => <OrderTicket hue="up" frozen={f} /> },
  { id: 'strip', name: 'Status strip', hint: 'Console sensor bar: network, balance, battery.', cat: 'status', render: (f) => <StatusStrip frozen={f} /> },
  { id: 'statrow', name: 'Stat row', hint: 'Four colored stats: win, vol, lev, P&L.', cat: 'status', render: () => <StatGrid /> },

  // Schematic
  { id: 'flow', name: 'Play flow', hint: 'You → open → settle. Marching dashes.', cat: 'schematic', render: (f) => <PlayFlow hue="cyan" frozen={f} /> },
  { id: 'liq', name: 'Liquidation bar', hint: 'Distance to liq: danger, entry, live mark.', cat: 'schematic', render: (f) => <LiquidationBar hue="down" frozen={f} /> },

  // Hero
  { id: 'depthsurf', name: 'Depth surface', hint: 'Perspective book depth over time. Hero piece.', cat: 'hero', render: (f) => <DepthSurface frozen={f} /> },
  { id: 'burst-up', name: 'Result burst', hint: 'Win moment, radial burst + number.', cat: 'hero', render: (f) => <ResultBurst hue="up" frozen={f} /> },
  { id: 'burst-down', name: 'Result · loss', hint: 'Down-tinted settle.', cat: 'hero', render: (f) => <ResultBurst hue="down" frozen={f} /> },
  { id: 'wheel', name: 'Lucky wheel', hint: 'I Feel Lucky. Multiplier segments, spins to a stop.', cat: 'hero', render: (f) => <LuckyWheel frozen={f} /> },
]

function GameLab() {
  const [cat, setCat] = useState<LabCat | 'all'>('all')
  const [frozen, setFrozen] = useState(false)
  const items = cat === 'all' ? LAB : LAB.filter((item) => item.cat === cat)
  const count = (key: LabCat | 'all') =>
    key === 'all' ? LAB.length : LAB.filter((item) => item.cat === key).length

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-brand-500">
            Teenage Engineering
          </p>
          <h2 className="mt-2 text-3xl font-extrabold tracking-tight sm:text-4xl">
            Game Screen Instruments
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-text-2">
            Crisp, vivid line graphics for inside the console screen. Pick what
            fits a game, ignore the rest. Each piece is a real component,
            hue-swappable and reduced-motion aware.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setFrozen((v) => !v)}
          aria-pressed={!frozen}
          className={cnm(
            'flex items-center gap-2 rounded-full border px-3.5 py-2 text-xs font-bold transition-transform active:scale-95',
            frozen
              ? 'border-line text-text-2'
              : 'border-brand-500/50 text-brand-500',
          )}
        >
          <span
            className={cnm(
              'h-2 w-2 rounded-full',
              frozen ? 'bg-text-3' : 'bg-brand-500 shadow-[0_0_8px_rgba(255,192,22,0.8)]',
            )}
          />
          {frozen ? 'Motion off' : 'Motion on'}
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {LAB_CATS.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setCat(c.key)}
            aria-pressed={cat === c.key}
            className={cnm(
              'rounded-full border px-3.5 py-1.5 text-xs font-bold transition-transform active:scale-95',
              cat === c.key
                ? 'border-brand-500 bg-brand-500 text-black'
                : 'border-line text-text-2 hover:text-text',
            )}
          >
            {c.label}
            <span className="ml-1.5 text-[10px] opacity-60">{count(c.key)}</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {items.map((item) => (
          <LabTile key={item.id} name={item.name} hint={item.hint} cat={item.cat}>
            {item.render(frozen)}
          </LabTile>
        ))}
      </div>
    </section>
  )
}

function LabTile({
  name,
  hint,
  cat,
  children,
}: {
  name: string
  hint: string
  cat: LabCat
  children: ReactNode
}) {
  return (
    <div>
      <div className="screen relative aspect-[8/5] overflow-hidden rounded-md border border-line">
        {children}
        <div className="viz-vignette pointer-events-none absolute inset-0" />
        <span className="pointer-events-none absolute left-2 top-2 h-2.5 w-2.5 border-l border-t border-white/15" />
        <span className="pointer-events-none absolute right-2 top-2 h-2.5 w-2.5 border-r border-t border-white/15" />
        <span className="pointer-events-none absolute bottom-2 left-2 h-2.5 w-2.5 border-b border-l border-white/15" />
        <span className="pointer-events-none absolute bottom-2 right-2 h-2.5 w-2.5 border-b border-r border-white/15" />
      </div>
      <div className="mt-2.5 flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-bold">{name}</span>
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-text-3">
          {cat}
        </span>
      </div>
      <p className="mt-0.5 text-[11px] leading-snug text-text-3">{hint}</p>
    </div>
  )
}
