import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity } from 'lucide-react'
import { useConsoleControls } from '@/components/console/controls'
import { GameReadout, GameScreen, GameStage, ScreenCRT } from '@/components/game/screen'
import { RideEngine, type RideHud } from '@/components/game/rideEngine'
import { haptic } from '@/lib/haptics'
import { sound } from '@/lib/sound'
import { useAuth } from '@/lib/auth'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { getScores, submitScore, type ScoreEntry, type SubmitResult } from '@/lib/leaderboard'
import { cnm } from '@/utils/style'

// Line Rider. A pure local arcade minigame (no Sui, no backend): a neon trend line scrolls in and
// the thumbwheel rides a pip on it. Hug the line and your score climbs (faster the tighter you hug,
// via a combo multiplier); fall off and the combo resets while your grip drains; grip empties and
// the run ends, straight into the leaderboard. Runs on the 3D handheld's L-shaped aperture.
export const Route = createFileRoute('/_app/games/line-rider')({ component: LineRiderScreen })

const GAME = 'line-rider'
const WHEEL_STEPS = 24 // knob resolution for the pip's vertical position (knob is ~40px/detent)
const CENTER = Math.round(WHEEL_STEPS / 2)

type Phase = 'title' | 'playing' | 'over'
const EMPTY_HUD: RideHud = { score: 0, multiplier: 1, grip: 1, elapsed: 0, onLine: false }
const fmt = (n: number) => Math.round(n).toLocaleString('en-US')

export function LineRiderScreen() {
  const { user } = useAuth()
  const reduced = useReducedMotion()

  const [phase, setPhase] = useState<Phase>('title')
  const [wheel, setWheel] = useState(CENTER)
  const [hud, setHud] = useState<RideHud>(EMPTY_HUD)
  const [board, setBoard] = useState<ScoreEntry[]>(() => getScores(GAME))
  const [result, setResult] = useState<SubmitResult | null>(null)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const engineRef = useRef<RideEngine | null>(null)
  const endRef = useRef<(score: number) => void>(() => {})

  const name = user?.displayName ?? 'You'
  const best = board[0]?.score ?? 0 // the high score to chase (top of the board)

  // The run ends from inside the engine loop. Kept in a ref so the engine (built once) always calls
  // the latest closure with the current display name.
  endRef.current = (score: number) => {
    haptic('error')
    sound('lose')
    const res = submitScore(GAME, name, score)
    setResult(res)
    setBoard(res.scores)
    setPhase('over')
  }

  // Build the engine once the canvas is mounted; it lives for the screen and is reused across runs.
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const eng = new RideEngine(c, {
      onHud: setHud,
      onEnd: (s) => endRef.current(s),
      onMilestone: () => haptic('rigid'), // combo crossed an integer: a satisfying tick
      onRegain: () => haptic('selection'), // snapped back onto the line
      reduced,
    })
    engineRef.current = eng
    return () => {
      eng.destroy()
      engineRef.current = null
    }
    // reduced is read once at build; it effectively never flips mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const start = useCallback(() => {
    setResult(null)
    setHud(EMPTY_HUD)
    setWheel(CENTER) // recenter so the run opens with the pip on the (flat) line
    setPhase('playing')
    const eng = engineRef.current
    if (eng) {
      eng.setTarget(0.5)
      eng.start()
    }
    haptic('rigid')
  }, [])

  const onWheel = useCallback((v: number) => {
    setWheel(v)
    engineRef.current?.setTarget(v / WHEEL_STEPS)
  }, [])

  const playing = phase === 'playing'
  useConsoleControls({
    knob: { label: 'RIDE', min: 0, max: WHEEL_STEPS, step: 1, value: wheel, onChange: onWheel },
    // The wheel is the whole game; the main button just starts / restarts a run.
    main: playing ? null : { label: phase === 'over' ? 'PLAY AGAIN' : 'PLAY', color: 'amber', onPress: start },
  })

  const liveBest = Math.max(best, hud.score) // HI ticks up the moment you pass it

  return (
    <GameScreen>
      <GameStage
        top={
          playing ? (
            // top-left only: current score over the high score, dropped a touch off the top edge.
            // (Grip reads off the on-screen bar, the combo off the line's heat, so the top-right is clear.)
            <div className="pt-[18px]">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Score</div>
              <div className="tnum text-4xl font-extrabold leading-none text-text">{fmt(hud.score)}</div>
              <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                Best <span className="tnum text-text-2">{fmt(liveBest)}</span>
              </div>
            </div>
          ) : null
        }
      >
        <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />
      </GameStage>

      {/* bottom-left: the game's identity + how to play, always visible so it's instantly clear */}
      <GameReadout>
        <div className="flex items-center gap-3">
          <Activity size={30} strokeWidth={2.4} className="shrink-0 text-brand-500" />
          <div>
            <div className="text-[20px] font-extrabold uppercase leading-none tracking-[0.03em] text-text">Line Rider</div>
            <div className="mt-1.5 text-[15px] font-semibold leading-snug text-text-2">Turn the big wheel to follow the line</div>
          </div>
        </div>
      </GameReadout>

      <ScreenCRT />

      {phase === 'title' && <TitleOverlay best={best} board={board} />}
      {phase === 'over' && result && <OverOverlay result={result} />}
    </GameScreen>
  )
}

// Title: the pitch, the board, the prompt. Full-screen over the canvas.
function TitleOverlay({ best, board }: { best: number; board: ScoreEntry[] }) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col justify-center bg-black/93 p-[var(--screen-rim,24px)] backdrop-blur-[1px]">
      <div className="flex items-center gap-2.5">
        <Activity size={26} strokeWidth={2.4} className="text-brand-500" />
        <h1 className="text-4xl font-extrabold leading-none tracking-tight text-text">Line Rider</h1>
      </div>
      <p className="mt-2 max-w-[82%] text-sm leading-snug text-text-2">
        Spin the wheel to keep the dot on the line. The longer you ride it, the faster your score climbs. Don't fall off.
      </p>
      <div className="mt-5 w-full">
        <Board rows={board.slice(0, 5)} />
      </div>
      <div className="mt-4 text-[11px] font-bold uppercase tracking-[0.16em] text-text-3">
        Best <span className="tnum text-text">{fmt(best)}</span> · press the <span className="text-brand-500">big button</span>
      </div>
    </div>
  )
}

// Game over: the banner, the final score, where it landed. Shown after every run.
function OverOverlay({ result }: { result: SubmitResult }) {
  const you = result.scores.find((s) => s.you)
  const score = you?.score ?? 0
  const placed = result.rank > 0
  return (
    <div className="absolute inset-0 z-20 flex flex-col justify-center bg-black/95 p-[var(--screen-rim,24px)]">
      <div className={cnm('text-[11px] font-bold uppercase tracking-[0.2em]', result.isBest ? 'text-brand-500' : 'text-text-3')}>
        {result.isBest ? '★ New best' : placed ? `Ranked #${result.rank}` : 'Run over'}
      </div>
      <div className="tnum text-5xl font-extrabold leading-none text-text">{fmt(score)}</div>
      <div className="mt-1 text-[11px] uppercase tracking-[0.14em] text-text-3">
        {result.isBest ? 'Top of the board' : placed ? 'On the board' : `${fmt(result.prevBest)} to place`}
      </div>
      <div className="mt-5 w-full">
        <Board rows={result.scores.slice(0, 6)} />
      </div>
      <div className="mt-4 text-[11px] font-bold uppercase tracking-[0.16em] text-text-3">
        Press the <span className="text-brand-500">big button</span> to play again
      </div>
    </div>
  )
}

// The shared leaderboard list. The player's just-set row glows.
function Board({ rows }: { rows: ScoreEntry[] }) {
  return (
    <div className="flex w-full flex-col font-mono">
      {rows.map((r, i) => (
        <div
          key={`${r.name}-${r.at}`}
          className={cnm(
            'flex items-center gap-3 py-1.5 text-[16px] tracking-[0.04em]',
            r.you ? 'text-brand-500' : 'text-text-2',
          )}
        >
          <span className="tnum w-6 text-text-3">{i + 1}</span>
          <span className="flex-1 truncate font-bold uppercase">{r.you ? 'You' : r.name}</span>
          <span className="tnum font-bold">{fmt(r.score)}</span>
          {r.you && <span className="text-brand-500">◀</span>}
        </div>
      ))}
    </div>
  )
}
