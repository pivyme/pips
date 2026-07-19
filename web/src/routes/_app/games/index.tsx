import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Activity, CandlestickChart, Dices, Layers, Rocket, Target } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCallback } from 'react'
import { useConsoleControls } from '@/components/console/controls'
import { GameScreen } from '@/components/game/screen'
import { Stat } from '@/components/Stat'
import { api } from '@/lib/api'
import { rv2LivePlayIds } from '@/lib/rangeV2'
import { useAuth } from '@/lib/auth'
import { useLivePresence } from '@/lib/presence'
import { isDemo } from '@/lib/demo'
import { NETWORK_LABEL } from '@/lib/sui/config'
import { haptic } from '@/lib/haptics'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { cnm } from '@/utils/style'
import { displayHandle } from '@/utils/format'

// The Home screen (docs/FLOW.md §5): TE instrument style per docs/SCREEN.md. L-shaped aperture: game
// select is full width up top, the read-only readout sits notch-safe bottom-left (bottom-right is occluded by the knob/PLAY body). Text insets at RIM, hairlines/fills bleed full width under it.
export const Route = createFileRoute('/_app/games/')({ component: GamesConsole })

// Text inset that clears the beveled rim, responsive: --screen-rim is published by ConsoleCanvas per
// device scale (24px fallback). Rules/fills stay full width and bleed under it so the screen still reads edge-to-edge.
const RIM = 'px-[var(--screen-rim,24px)]'
// A little breathing room up top so the status strip doesn't kiss the bevel, kept small so the last minigame clears the bottom-right body.
const RIM_T = 'pt-[calc(var(--screen-rim,24px)_+_6px)]'
const RIM_B = 'pb-[var(--screen-rim,24px)]'

type GameDef = { to: string; icon: LucideIcon; name: string; tag: string }

// Real plays. Every one settles a DeepBook Predict position with actual funds.
const GAMES: ReadonlyArray<GameDef> = [
  { to: '/games/lucky', icon: Dices, name: 'I Feel Lucky', tag: 'Spin. Win. Cash out.' },
  { to: '/games/range', icon: Target, name: 'Range', tag: 'Call the zone. Tighter pays more.' },
  { to: '/games/range-v2', icon: Layers, name: 'Range V2', tag: 'Stack bands. Never wait a round.' },
  { to: '/games/moonshot', icon: Rocket, name: 'Moonshot', tag: 'Long or short. Reach further, win bigger.' },
]

// Minigames. Pure local arcade, no chain, no funds. A totally separate, just-for-fun lane.
const MINIGAMES: ReadonlyArray<GameDef> = [
  { to: '/games/flappy-piper', icon: CandlestickChart, name: 'Flappy Piper', tag: 'Flap through the gaps.' },
  { to: '/games/line-rider', icon: Activity, name: 'Line Rider', tag: 'Ride the line. Don’t slip.' },
]

// One flat order for the knob/PLAY selection; rendered in two separate sections below.
const ALL: ReadonlyArray<GameDef> = [...GAMES, ...MINIGAMES]

const pad2 = (n: number): string => String(n).padStart(2, '0')

function GamesConsole() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const reduced = useReducedMotion()
  // Remember the last cartridge the player highlighted, so returning to the hub keeps it selected. Stored by route so it survives a reorder / new game.
  const [selTo, setSelTo] = useLocalStorage('pips_game_sel', ALL[0].to)
  const sel = Math.max(0, ALL.findIndex((g) => g.to === selTo))

  const statsQ = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() })
  const streak = statsQ.data?.stats.currentStreak ?? 0

  // Which real games have positions still riding, so the row can flag it. Open plays from the backend are the fresh,
  // chain-reconciled truth; range-v2 shares the `range` game with Range, so its own tagged ids split the two rows apart.
  const openPlaysQ = useQuery({
    queryKey: ['plays', 'open'],
    queryFn: () => api.plays({ status: 'open', limit: 30 }),
    refetchInterval: 5000,
    staleTime: 3000,
    retry: false,
  })
  const openPlays = openPlaysQ.data?.plays ?? []
  const rv2Ids = rv2LivePlayIds()
  const rangeV2Live = openPlays.some((p) => p.game === 'range' && rv2Ids.has(p.id))
  const rangeLive = openPlays.some((p) => p.game === 'range' && !rv2Ids.has(p.id))
  const inPlayFor = (to: string): boolean =>
    to === '/games/lucky'
      ? openPlays.some((p) => p.game === 'lucky')
      : to === '/games/moonshot'
        ? openPlays.some((p) => p.game === 'moonshot')
        : to === '/games/range'
          ? rangeLive
          : to === '/games/range-v2'
            ? rangeV2Live
            : false
  // First-run only: same signal Lucky's idle hint uses, no extra storage, disappears for good after the first play.
  const firstRun = !statsQ.isLoading && (statsQ.data?.stats.gamesPlayed ?? 0) === 0

  // Live presence ticker: the connection lives at the app shell (LivePresenceProvider) across every screen; we just read the count here.
  const { online, live: liveOn } = useLivePresence()

  const move = useCallback(
    (next: number) => {
      const i = Math.max(0, Math.min(ALL.length - 1, next))
      setSelTo(ALL[i].to)
    },
    [setSelTo],
  )

  // The PLAY button lands here. A rigid tick sells picking the cartridge up. Remember what we launched
  // (a direct row tap skips the knob, which is what persists selection), so Home reopens on your last game, not the default.
  const launch = useCallback(
    (i: number) => {
      haptic('rigid')
      setSelTo(ALL[i].to)
      void navigate({ to: ALL[i].to })
    },
    [navigate, setSelTo],
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
  const balanceDecimals = Math.max(
    2,
    Math.min(6, (user?.balance.split('.')[1] ?? '').replace(/0+$/, '').length),
  )

  return (
    <GameScreen>
      {/* status line — mono, like a device model strip. Left: network. Right: live presence ticker. */}
      <div className={cnm('flex items-center justify-between pb-2.5 font-mono text-[12px] font-semibold uppercase tracking-[0.12em] text-text-2', RIM_T, RIM)}>
        <span className="flex min-w-0 items-center gap-2">
          <span className={cnm('h-2 w-2 shrink-0', demo ? 'bg-brand-500' : 'bg-up')} />
          <span className="truncate">{demo ? 'Demo' : NETWORK_LABEL}</span>
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
      <div className={cnm('flex items-baseline justify-between pb-1 pt-3 font-mono text-[12px] font-semibold uppercase tracking-[0.18em] text-text-2', RIM)}>
        <span>Select Game</span>
        {firstRun && <span className="tracking-[0.1em] text-text-3">Tap or turn the knob</span>}
      </div>
      <div className="flex flex-col">
        {GAMES.map((g, i) => (
          <div key={g.to}>
            {i > 0 && <Rule />}
            <GameRow index={i + 1} game={g} selected={i === sel} inPlay={inPlayFor(g.to)} onLaunch={() => launch(i)} />
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
              <MiniRow game={g} selected={i === sel} onLaunch={() => launch(i)} />
            </div>
          )
        })}
      </div>

      {/* black negative space absorbs the slack height (and the occluded bottom-right body) */}
      <div className="min-h-0 flex-1" />

      {/* readout — left-only, notch-safe info zone (bottom-right is the knob/PLAY body): who you are, streak, balance */}
      <Rule />
      <div className={cnm('max-w-[62%] pt-3', RIM_B, RIM)}>
        {/* who you are + streak on one line: no wallet address here, it just ate vertical space */}
        <div className="flex items-center gap-2.5">
          <span className="min-w-0 truncate text-[17px] font-extrabold lowercase leading-tight tracking-[0.02em] text-text">{name}</span>
          {streak > 0 && (
            <span className="tnum flex shrink-0 items-center border border-brand-500/60 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.08em] text-brand-500">STREAK {streak}</span>
          )}
        </div>
        <div className="mt-2 font-mono text-[11px] uppercase tracking-[0.14em] text-text-2">Available</div>
        <div className="mt-0.5 leading-none">
          <Stat
            value={balance}
            prefix="$"
            decimals={balanceDecimals}
            className="text-[26px] font-extrabold tracking-tight text-text"
          />
          <span className="ml-1 font-mono text-[11px] uppercase tracking-[0.1em] text-text-2">DUSDC</span>
        </div>
      </div>
    </GameScreen>
  )
}

function GameRow({
  index,
  game,
  selected,
  inPlay,
  onLaunch,
}: {
  index: number
  game: { icon: LucideIcon; name: string; tag: string }
  selected: boolean
  inPlay: boolean
  onLaunch: () => void
}) {
  const Icon = game.icon
  // The screen renders behind the 3D device and taps land on the WebGL canvas, not this DOM: data-console-tap
  // opts this button into ConsoleCanvas's screen-tap-forward hit test, which clicks it directly. Knob still scrubs selection, PLAY still launches the lit row.
  return (
    <button
      type="button"
      data-console-tap
      onClick={onLaunch}
      className={cnm(
        'relative flex w-full items-center gap-3 py-2.5 text-left',
        RIM,
        selected ? 'bg-brand-500/[0.13]' : '',
      )}
    >
      {/* left edge bar marks the selected cartridge, instrument-panel style */}
      {selected && <span className="absolute inset-y-0 left-0 w-1 bg-brand-500" />}
      <span className={cnm('tnum w-5 font-mono text-[14px] font-bold', selected ? 'text-brand-500' : 'text-text-2')}>{pad2(index)}</span>
      <Icon size={23} strokeWidth={2} className={selected ? 'text-brand-500' : 'text-text-2'} />
      <div className="min-w-0 flex-1">
        <div className={cnm('text-[18px] font-extrabold uppercase leading-tight tracking-[0.02em]', selected ? 'text-text' : 'text-text-2')}>{game.name}</div>
        <div className="truncate font-mono text-[11px] uppercase tracking-[0.08em] text-text-3">{game.tag}</div>
      </div>
      {/* live positions still riding: a green status pill, sharp-cornered like the in-play chips per SCREEN.md */}
      {inPlay && (
        <span className="inline-flex shrink-0 items-center gap-1.5 border border-up/60 bg-up/15 px-1.5 py-1 font-mono text-[9px] font-bold uppercase leading-none tracking-[0.12em] text-up">
          <span className="h-1.5 w-1.5 bg-up motion-safe:animate-pulse" />
          In Play
        </span>
      )}
      {selected && <span className="font-mono text-lg text-brand-500">▶</span>}
    </button>
  )
}

// Deliberately smaller than GameRow so the just-for-fun lane reads as secondary: compact icon, no slot number. Knob-selectable or tappable, same as GameRow.
function MiniRow({
  game,
  selected,
  onLaunch,
}: {
  game: GameDef
  selected: boolean
  onLaunch: () => void
}) {
  const Icon = game.icon
  return (
    <button
      type="button"
      data-console-tap
      onClick={onLaunch}
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
    </button>
  )
}

// Full-bleed hairline rule. Slides under the rim so the visible line reaches the screen edge.
function Rule() {
  return <div className="h-px w-full bg-line-strong" />
}

// The live-presence pip: breathing green square when connected, dim static otherwise. Square to match the instrument-panel pixels, no rounded dot or blur.
function LiveDot({ on, reduced }: { on: boolean; reduced: boolean }) {
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0">
      {on && !reduced && <span className="absolute inset-0 animate-ping bg-up/70" />}
      <span className={cnm('relative inline-block h-2 w-2', on ? 'bg-up' : 'bg-text-3')} />
    </span>
  )
}
