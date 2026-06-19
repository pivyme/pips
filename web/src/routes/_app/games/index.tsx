import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { Activity, CandlestickChart, Dices, Target, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useConsoleControls } from '@/components/console/controls'
import { GameScreen } from '@/components/game/screen'
import { Stat } from '@/components/Stat'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { isDemo } from '@/lib/demo'
import { haptic } from '@/lib/haptics'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { cnm } from '@/utils/style'

// The Home screen on the device (docs/FLOW.md §5). The console screen emulates a Teenage
// Engineering instrument panel, so this is flat, edge-to-edge and high-contrast: true black,
// hairline rules that bleed past the rim, mono micro-labels, crisp line glyphs, sharp corners.
// No rounded cards, no domed surfaces, no emoji.
//
// Layout follows the L-shaped aperture. The game select (the one interactive thing) takes the
// full width up top, where the wide rows have room to breathe and never crop. The read-only
// readout (who you are, streak, chip balance) drops into the bottom-left, the notch-safe zone
// that is never full width because the knob + PLAY body occludes the bottom-right. Tap a row to
// launch, or scrub the knob and hit PLAY. The depth (full stats, history) lives in the Menu.
//
// Inset rule for this L-shaped aperture: the device body masks the outer ~16px, so text sits at
// RIM (clears the bevel) while the hairlines/fills run full width (they slide under the rim, so
// the visible line still reaches the screen edge). That is what reads as edge-to-edge, not padded.
export const Route = createFileRoute('/_app/games/')({ component: GamesConsole })

// Text inset that clears the beveled rim, responsive: --screen-rim is published by ConsoleCanvas
// per device scale (24px fallback). Rules + row fills stay full width and bleed under the rim, so
// the screen reads edge-to-edge while text never crops as the device grows.
const RIM = 'px-[var(--screen-rim,24px)]'
// Extra breathing room up top so the status strip doesn't kiss the bevel.
const RIM_T = 'pt-[calc(var(--screen-rim,24px)_+_18px)]'
const RIM_B = 'pb-[var(--screen-rim,24px)]'

type GameDef = { to: string; icon: LucideIcon; name: string; tag: string }

// Real plays. Every one settles a DeepBook Predict position with actual funds.
const GAMES: ReadonlyArray<GameDef> = [
  { to: '/games/lucky', icon: Dices, name: 'I Feel Lucky', tag: 'Spin. Win. Cash out.' },
  { to: '/games/range', icon: Target, name: 'Range', tag: 'Call the zone. Tighter pays more.' },
  { to: '/games/tap', icon: Zap, name: 'Tap', tag: 'Tap the chart. Catch the move.' },
]

// Minigames. Pure local arcade, no chain, no funds. A totally separate, just-for-fun lane.
const MINIGAMES: ReadonlyArray<GameDef> = [
  { to: '/games/line-rider', icon: Activity, name: 'Line Rider', tag: 'Ride the line. Don’t slip.' },
  { to: '/games/candle-hop', icon: CandlestickChart, name: 'Candle Hop', tag: 'Flap through the gaps.' },
]

// One flat order for the knob/PLAY selection; rendered in two separate sections below.
const ALL: ReadonlyArray<GameDef> = [...GAMES, ...MINIGAMES]

const pad2 = (n: number): string => String(n).padStart(2, '0')
const shortAddr = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

function GamesConsole() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const reduced = useReducedMotion()
  const [sel, setSel] = useState(0)

  const marketsQ = useQuery({ queryKey: ['markets'], queryFn: () => api.markets(), refetchInterval: 10_000 })
  const statsQ = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() })
  const liveCount = (marketsQ.data?.markets ?? []).filter((m) => m.live).length
  const streak = statsQ.data?.stats.currentStreak ?? 0

  const move = useCallback((next: number) => {
    setSel(Math.max(0, Math.min(ALL.length - 1, next)))
  }, [])

  // Tap a row or hit PLAY both land here. A rigid tick sells picking the cartridge up.
  const launch = useCallback(
    (i: number) => {
      haptic('rigid')
      void navigate({ to: ALL[i].to })
    },
    [navigate],
  )

  useConsoleControls({
    knob: {
      label: 'SELECT',
      min: 0,
      max: ALL.length - 1,
      step: 1,
      value: sel,
      onChange: move,
      format: (v) => `${pad2(v + 1)}/${pad2(ALL.length)}`,
    },
    action1: { label: 'PREV', color: 'neutral', onPress: () => move(sel - 1) },
    action2: { label: 'NEXT', color: 'neutral', onPress: () => move(sel + 1) },
    main: { label: '', color: 'amber', onPress: () => launch(sel) },
  })

  const demo = isDemo()
  const name = user?.displayName ?? 'Player'
  const balance = parseFloat(user?.balance ?? '0') || 0

  return (
    <GameScreen>
      {/* status line — mono, like a device model strip */}
      <div className={cnm('flex items-center justify-between pb-2.5 font-mono text-[12px] font-semibold uppercase tracking-[0.16em] text-text-2', RIM_T, RIM)}>
        <span className="flex items-center gap-2">
          <span className={cnm('h-2 w-2', demo ? 'bg-brand-500' : 'bg-up')} />
          {demo ? 'Demo' : 'Testnet'}
        </span>
        <span className="flex items-center gap-2">
          {marketsQ.isLoading ? '—' : liveCount > 0 ? `${liveCount} live` : 'Warming up'}
          <span className={cnm('h-2 w-2', liveCount > 0 ? 'bg-up' : 'bg-text-3')} />
        </span>
      </div>
      <Rule />

      {/* select game — real plays, each settles a Predict position. Full-bleed rows split by hairlines */}
      <div className={cnm('pb-1 pt-3 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-text-2', RIM)}>Select Game</div>
      <div className="flex flex-col">
        {GAMES.map((g, i) => (
          <div key={g.to}>
            {i > 0 && <Rule />}
            <GameRow index={i + 1} game={g} selected={i === sel} reduced={reduced} onSelect={() => { setSel(i); launch(i) }} />
          </div>
        ))}
      </div>

      {/* minigame — a quieter, lower-hierarchy lane below the real plays. No chain, no funds, just play. */}
      <div className={cnm('flex items-baseline justify-between pb-0.5 pt-5 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-text-3', RIM)}>
        <span>Minigame</span>
        <span className="tracking-[0.1em]">Just for fun · No funds</span>
      </div>
      <Rule />
      <div className="flex flex-col">
        {MINIGAMES.map((g, j) => {
          const i = GAMES.length + j
          return (
            <div key={g.to}>
              {j > 0 && <Rule />}
              <MiniRow game={g} selected={i === sel} reduced={reduced} onSelect={() => { setSel(i); launch(i) }} />
            </div>
          )
        })}
      </div>

      {/* black negative space absorbs the slack height (and the occluded bottom-right body) */}
      <div className="min-h-0 flex-1" />

      {/* readout — left-only info zone, notch-safe (the bottom-right is the body: knob + PLAY).
          who you are, streak, chip balance: all the read-only context lives down here now. */}
      <Rule />
      <div className={cnm('max-w-[62%] pt-3', RIM_B, RIM)}>
        <div className="truncate text-[17px] font-extrabold uppercase leading-tight tracking-[0.02em] text-text">{name}</div>
        <div className="mt-1 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.08em] text-text-2">
          <span className="tnum truncate">{user ? shortAddr(user.address) : '—'}</span>
          {streak > 0 && (
            <span className="tnum flex shrink-0 items-center border border-brand-500/60 px-1.5 py-0.5 text-brand-500">STREAK {streak}</span>
          )}
        </div>
        <div className="mt-3 font-mono text-[11px] uppercase tracking-[0.14em] text-text-2">Balance</div>
        <div className="mt-0.5 leading-none">
          <Stat value={balance} prefix="$" className="text-[26px] font-extrabold tracking-tight text-text" />
          <span className="ml-1 font-mono text-[11px] uppercase tracking-[0.1em] text-text-2">USDC</span>
        </div>
      </div>
    </GameScreen>
  )
}

function GameRow({
  index,
  game,
  selected,
  reduced,
  onSelect,
}: {
  index: number
  game: { icon: LucideIcon; name: string; tag: string }
  selected: boolean
  reduced: boolean
  onSelect: () => void
}) {
  const Icon = game.icon
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      whileTap={reduced ? undefined : { scale: 0.99 }}
      className={cnm(
        'relative flex w-full items-center gap-3.5 py-3.5 text-left transition-colors',
        RIM,
        selected ? 'bg-brand-500/[0.13]' : 'hover:bg-white/[0.04]',
      )}
    >
      {/* left edge bar marks the selected cartridge, instrument-panel style */}
      {selected && <span className="absolute inset-y-0 left-0 w-1 bg-brand-500" />}
      <span className={cnm('tnum w-6 font-mono text-[15px] font-bold', selected ? 'text-brand-500' : 'text-text-2')}>{pad2(index)}</span>
      <Icon size={28} strokeWidth={2} className={selected ? 'text-brand-500' : 'text-text-2'} />
      <div className="min-w-0 flex-1">
        <div className={cnm('text-[21px] font-extrabold uppercase leading-tight tracking-[0.02em]', selected ? 'text-text' : 'text-text-2')}>{game.name}</div>
        <div className="truncate font-mono text-[12px] uppercase tracking-[0.08em] text-text-3">{game.tag}</div>
      </div>
      {selected && <span className="font-mono text-lg text-brand-500">▶</span>}
    </motion.button>
  )
}

// The minigame row: deliberately smaller than GameRow so the just-for-fun lane reads as secondary.
// Compact icon, single line, no big slot number. Still knob-selectable and tappable.
function MiniRow({
  game,
  selected,
  reduced,
  onSelect,
}: {
  game: GameDef
  selected: boolean
  reduced: boolean
  onSelect: () => void
}) {
  const Icon = game.icon
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      whileTap={reduced ? undefined : { scale: 0.99 }}
      className={cnm(
        'relative flex w-full items-center gap-3 py-2.5 text-left transition-colors',
        RIM,
        selected ? 'bg-brand-500/[0.13]' : 'hover:bg-white/[0.04]',
      )}
    >
      {selected && <span className="absolute inset-y-0 left-0 w-0.5 bg-brand-500" />}
      <Icon size={18} strokeWidth={2} className={selected ? 'text-brand-500' : 'text-text-3'} />
      <span className={cnm('text-[15px] font-bold uppercase tracking-[0.04em]', selected ? 'text-text' : 'text-text-2')}>{game.name}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] uppercase tracking-[0.06em] text-text-3">{game.tag}</span>
      {selected && <span className="font-mono text-sm text-brand-500">▶</span>}
    </motion.button>
  )
}

// Full-bleed hairline rule. Slides under the rim so the visible line reaches the screen edge.
function Rule() {
  return <div className="h-px w-full bg-line-strong" />
}
