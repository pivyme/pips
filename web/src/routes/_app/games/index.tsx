import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Activity, CandlestickChart, Dices, Target } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useConsoleControls } from '@/components/console/controls'
import { GameScreen } from '@/components/game/screen'
import { Stat } from '@/components/Stat'
import { api, streamLive } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { isDemo } from '@/lib/demo'
import { haptic } from '@/lib/haptics'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { cnm } from '@/utils/style'
import { displayHandle } from '@/utils/format'

// The Home screen on the device (docs/FLOW.md §5). The console screen emulates a Teenage
// Engineering instrument panel, so this is flat, edge-to-edge and high-contrast: true black,
// hairline rules that bleed past the rim, mono micro-labels, crisp line glyphs, sharp corners.
// No rounded cards, no domed surfaces, no emoji.
//
// Layout follows the L-shaped aperture. The game select (the one interactive thing) takes the
// full width up top, where the wide rows have room to breathe and never crop. The read-only
// readout (who you are, streak, chip balance) drops into the bottom-left, the notch-safe zone
// that is never full width because the knob + PLAY body occludes the bottom-right. The screen is not
// clickable: scrub the knob to pick a cartridge and hit PLAY. The depth (full stats, history) lives in the Menu.
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
]

// Minigames. Pure local arcade, no chain, no funds. A totally separate, just-for-fun lane.
const MINIGAMES: ReadonlyArray<GameDef> = [
  { to: '/games/line-rider', icon: Activity, name: 'Line Rider', tag: 'Ride the line. Don’t slip.' },
  { to: '/games/candle-hop', icon: CandlestickChart, name: 'Flappy Piper', tag: 'Flap through the gaps.' },
]

// One flat order for the knob/PLAY selection; rendered in two separate sections below.
const ALL: ReadonlyArray<GameDef> = [...GAMES, ...MINIGAMES]

const pad2 = (n: number): string => String(n).padStart(2, '0')
const shortAddr = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

export function GamesConsole() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const reduced = useReducedMotion()
  // Remember the last cartridge the player highlighted, so returning to the hub keeps it selected
  // instead of snapping back to the first row. Stored by route so it survives a reorder / new game.
  const [selTo, setSelTo] = useLocalStorage('pips_game_sel', ALL[0].to)
  const sel = Math.max(0, ALL.findIndex((g) => g.to === selTo))

  const statsQ = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() })
  const streak = statsQ.data?.stats.currentStreak ?? 0

  // Live presence over SSE: the ticker moves in real time as players open and close PIPS. `online`
  // stays null until the first frame lands; `liveOn` tracks the connection so the pip can breathe.
  const [online, setOnline] = useState<number | null>(null)
  const [liveOn, setLiveOn] = useState(false)
  useEffect(() => {
    const stop = streamLive(
      (t) => {
        setOnline(t.online)
        setLiveOn(true)
      },
      () => setLiveOn(false),
    )
    return stop
  }, [user?.id])

  const move = useCallback(
    (next: number) => {
      const i = Math.max(0, Math.min(ALL.length - 1, next))
      setSelTo(ALL[i].to)
    },
    [setSelTo],
  )

  // The PLAY button lands here. A rigid tick sells picking the cartridge up.
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
  const name = displayHandle(user)
  const balance = parseFloat(user?.balance ?? '0') || 0

  return (
    <GameScreen>
      {/* status line — mono, like a device model strip. Left: network. Right: live presence ticker. */}
      <div className={cnm('flex items-center justify-between pb-2.5 font-mono text-[12px] font-semibold uppercase tracking-[0.12em] text-text-2', RIM_T, RIM)}>
        <span className="flex min-w-0 items-center gap-2">
          <span className={cnm('h-2 w-2 shrink-0', demo ? 'bg-brand-500' : 'bg-up')} />
          <span className="truncate">{demo ? 'Demo' : "PIPS's Localnet"}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 pl-3">
          {online == null ? (
            <span className="text-text-3">—</span>
          ) : (
            <>
              <span className="tnum font-bold text-text">{online}</span>
              <span className="text-text-3">online</span>
            </>
          )}
          <LiveDot on={liveOn && online != null} reduced={reduced} />
        </span>
      </div>
      <Rule />

      {/* select game — real plays, each settles a Predict position. Full-bleed rows split by hairlines */}
      <div className={cnm('pb-1 pt-3 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-text-2', RIM)}>Select Game</div>
      <div className="flex flex-col">
        {GAMES.map((g, i) => (
          <div key={g.to}>
            {i > 0 && <Rule />}
            <GameRow index={i + 1} game={g} selected={i === sel} />
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
              <MiniRow game={g} selected={i === sel} />
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
        <div className="truncate text-[17px] font-extrabold lowercase leading-tight tracking-[0.02em] text-text">{name}</div>
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
}: {
  index: number
  game: { icon: LucideIcon; name: string; tag: string }
  selected: boolean
}) {
  const Icon = game.icon
  // Pure readout: the device screen is not clickable, so the row only paints selection state. The
  // knob scrubs it and the PLAY button launches it.
  return (
    <div
      className={cnm(
        'relative flex w-full items-center gap-3.5 py-3.5 text-left',
        RIM,
        selected ? 'bg-brand-500/[0.13]' : '',
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
    </div>
  )
}

// The minigame row: deliberately smaller than GameRow so the just-for-fun lane reads as secondary.
// Compact icon, single line, no big slot number. Knob-selectable, launched with PLAY (not clickable).
function MiniRow({
  game,
  selected,
}: {
  game: GameDef
  selected: boolean
}) {
  const Icon = game.icon
  return (
    <div
      className={cnm(
        'relative flex w-full items-center gap-3 py-2.5 text-left',
        RIM,
        selected ? 'bg-brand-500/[0.13]' : '',
      )}
    >
      {selected && <span className="absolute inset-y-0 left-0 w-0.5 bg-brand-500" />}
      <Icon size={18} strokeWidth={2} className={selected ? 'text-brand-500' : 'text-text-3'} />
      <span className={cnm('text-[15px] font-bold uppercase tracking-[0.04em]', selected ? 'text-text' : 'text-text-2')}>{game.name}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] uppercase tracking-[0.06em] text-text-3">{game.tag}</span>
      {selected && <span className="font-mono text-sm text-brand-500">▶</span>}
    </div>
  )
}

// Full-bleed hairline rule. Slides under the rim so the visible line reaches the screen edge.
function Rule() {
  return <div className="h-px w-full bg-line-strong" />
}

// The live-presence pip: a breathing green square while the stream is connected, a dim static one
// when it isn't. Square to match the instrument-panel pixels (no rounded dot, no blur).
function LiveDot({ on, reduced }: { on: boolean; reduced: boolean }) {
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0">
      {on && !reduced && <span className="absolute inset-0 animate-ping bg-up/70" />}
      <span className={cnm('relative inline-block h-2 w-2', on ? 'bg-up' : 'bg-text-3')} />
    </span>
  )
}
