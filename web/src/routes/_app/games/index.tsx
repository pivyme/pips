import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { useConsoleControls } from '@/components/console/controls'
import { Illo } from '@/ui/Illo'
import { api } from '@/lib/api'
import { haptic } from '@/lib/haptics'
import { cnm } from '@/utils/style'

// The games picker, rendered on the device screen instead of a separate page. The knob scrubs the
// selection, the action buttons step it, the main button launches. Reads like a handheld's cartridge
// list: one row per game, the selected one lit. Picking Tap drops to the CSS shell (it isn't laid
// out for the L-shaped aperture yet); Lucky and Range run on the device.
export const Route = createFileRoute('/_app/games/')({ component: GamesConsole })

const GAMES = [
  { to: '/games/lucky', illo: 'dice', name: 'I Feel Lucky', tag: 'Spin. Ride it. Cash out.' },
  { to: '/games/range', illo: 'target', name: 'Range', tag: 'Call the zone. Tighter pays more.' },
  { to: '/games/tap', illo: 'bolt', name: 'Tap', tag: 'Tap the chart. Catch the move.' },
] as const

const pad2 = (n: number): string => String(n).padStart(2, '0')

function GamesConsole() {
  const navigate = useNavigate()
  const [sel, setSel] = useState(0)

  const marketsQ = useQuery({ queryKey: ['markets'], queryFn: () => api.markets(), refetchInterval: 10_000 })
  const liveCount = (marketsQ.data?.markets ?? []).filter((m) => m.live).length

  // The shell handles the tactile feedback (knob detent click, button press), so keep this pure.
  const move = useCallback((next: number) => {
    setSel(Math.max(0, Math.min(GAMES.length - 1, next)))
  }, [])

  const launch = useCallback(() => {
    haptic('medium')
    void navigate({ to: GAMES[sel].to })
  }, [navigate, sel])

  useConsoleControls({
    knob: {
      label: 'SELECT',
      min: 0,
      max: GAMES.length - 1,
      step: 1,
      value: sel,
      onChange: move,
      format: (v) => `${v + 1}/${GAMES.length}`,
    },
    action1: { label: 'PREV', color: 'neutral', onPress: () => move(sel - 1), disabled: sel === 0 },
    action2: { label: 'NEXT', color: 'neutral', onPress: () => move(sel + 1), disabled: sel === GAMES.length - 1 },
    main: { label: 'PLAY', color: 'amber', onPress: launch },
  })

  // The L-shaped aperture (web/CLAUDE.md): a full-width top bar, the list filling the slack height
  // (centered so it never sprawls into the occluded bottom-right), then a notch-safe readout band.
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-black text-text">
      <div className="flex items-start justify-between gap-3 p-4">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Pips</div>
          <div className="text-2xl font-extrabold leading-none tracking-tight">Games</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Markets</div>
          <div className="flex items-center justify-end gap-1.5 text-sm font-bold text-text-2">
            <span className={cnm('h-1.5 w-1.5 rounded-full', liveCount > 0 ? 'bg-up' : 'bg-text-3')} />
            {marketsQ.isLoading ? '—' : liveCount > 0 ? `${liveCount} live` : 'Warming up'}
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col justify-center gap-2 px-4">
        {GAMES.map((g, i) => (
          <GameRow key={g.to} index={i + 1} game={g} selected={i === sel} />
        ))}
      </div>

      {/* readout band — notch-safe, left-only (bottom-right is the body: knob + PLAY) */}
      <div className="pointer-events-none max-w-[60%] p-4">
        <div className="tnum text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
          {pad2(sel + 1)} / {pad2(GAMES.length)}
        </div>
        <div className="text-sm font-bold text-text-2">
          Press <span className="text-brand-500">PLAY</span> to start
        </div>
      </div>
    </div>
  )
}

function GameRow({
  index,
  game,
  selected,
}: {
  index: number
  game: { illo: string; name: string; tag: string }
  selected: boolean
}) {
  return (
    <div
      className={cnm(
        'flex items-center gap-3 rounded-card px-3 py-2.5 transition-all',
        selected ? 'card-neo-active scale-[1.01]' : 'opacity-45',
      )}
    >
      <span className={cnm('tnum w-5 text-sm font-extrabold', selected ? 'text-brand-500' : 'text-text-3')}>
        {pad2(index)}
      </span>
      <Illo name={game.illo} size={44} showGlow={selected} />
      <div className="min-w-0 flex-1">
        <div className={cnm('text-[17px] font-bold leading-tight', selected ? 'text-text' : 'text-text-2')}>
          {game.name}
        </div>
        <div className="truncate text-xs text-text-3">{game.tag}</div>
      </div>
      {selected && <span className="text-lg text-brand-500">▸</span>}
    </div>
  )
}
