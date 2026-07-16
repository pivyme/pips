import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity } from 'lucide-react'
import { useConsoleControls } from '@/components/console/controls'
import { GameReadout, GameScreen, GameStage, ScreenCRT } from '@/components/game/screen'
import { MinigameBoard, useMinigameLeaderboard } from '@/components/game/MinigameBoard'
import { RideEngine, type RideHud } from '@/components/game/rideEngine'
import type { LeaderboardScoreEntry, MinigameSubmit } from '@/lib/api'
import { haptic } from '@/lib/haptics'
import { rideCrash, rideStart, setRideState, startRideBgm, stopRideBgm } from '@/lib/sound'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { cnm } from '@/utils/style'

// Line Rider. Pure local arcade (no Sui, no backend): thumbwheel rides a pip on a scrolling neon line.
// Hug the line and score climbs (faster via a combo multiplier); fall off and combo resets while grip drains; grip empties, run ends into the leaderboard. Runs on the 3D handheld's L-shaped aperture.
export const Route = createFileRoute('/_app/games/line-rider')({ component: LineRiderScreen })

const GAME = 'line-rider'
const WHEEL_STEPS = 24 // knob resolution for the pip's vertical position (knob is ~40px/detent)
const CENTER = Math.round(WHEEL_STEPS / 2)

type Phase = 'title' | 'playing' | 'over'
const EMPTY_HUD: RideHud = { score: 0, multiplier: 1, grip: 1, elapsed: 0, onLine: false, intensity: 0 }
const fmt = (n: number) => Math.round(n).toLocaleString('en-US')

function LineRiderScreen() {
  const reduced = useReducedMotion()

  const [phase, setPhase] = useState<Phase>('title')
  const [wheel, setWheel] = useState(CENTER)
  const [hud, setHud] = useState<RideHud>(EMPTY_HUD)
  const { board, submit, startRun } = useMinigameLeaderboard(GAME)
  const [over, setOver] = useState<{ score: number; result: MinigameSubmit | null } | null>(null)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const engineRef = useRef<RideEngine | null>(null)
  const endRef = useRef<(score: number) => void>(() => {})

  const best = board[0]?.score ?? 0 // the high score to chase (top of the board)

  // The run ends inside the engine loop; kept in a ref so the engine (built once) always calls the latest closure. Score shows instantly, rank + refreshed board land when submit resolves.
  endRef.current = (score: number) => {
    haptic('error')
    stopRideBgm() // cut the bed so the wipeout lands clean over silence
    rideCrash()
    setOver({ score, result: null })
    setPhase('over')
    void submit(score)
      .then((result) => setOver((o) => (o ? { ...o, result } : { score, result })))
      .catch(() => {})
  }

  // Build the engine once the canvas is mounted; it lives for the screen and is reused across runs.
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const eng = new RideEngine(c, {
      onHud: (h) => {
        setHud(h)
        // Feed the bed: the tone filter rides intensity + onLine, the heartbeat + sparkle ride grip + combo.
        setRideState({ intensity: h.intensity, onLine: h.onLine, gripLow: h.grip < 0.28, mult: h.multiplier })
      },
      onEnd: (s) => endRef.current(s),
      onMilestone: () => haptic('rigid'), // combo crossed an integer: just a tick, the bed carries the rest
      onRegain: () => haptic('selection'), // snapped back onto the line: haptic only, no chime
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
    setOver(null)
    setHud(EMPTY_HUD)
    setWheel(CENTER) // recenter so the run opens with the pip on the (flat) line
    setPhase('playing')
    startRun() // open the run before playing
    const eng = engineRef.current
    if (eng) {
      eng.setTarget(0.5)
      eng.start()
    }
    haptic('rigid')
    rideStart() // takeoff whoosh as the line flows in (the bed itself starts on the phase effect)
  }, [startRun])

  // The glide bed rides only the active run: start on play, fade out on game over or when the screen unmounts.
  useEffect(() => {
    if (phase !== 'playing') return
    startRideBgm()
    return () => stopRideBgm()
  }, [phase])

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
            // top-left only: current score over high score. Grip reads off the on-screen bar, combo off the line's heat, so the top-right stays clear.
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
      {phase === 'over' && over && <OverOverlay over={over} board={board} />}
    </GameScreen>
  )
}

// Title: the pitch, the board, the prompt. Full-screen over the canvas.
function TitleOverlay({ best, board }: { best: number; board: LeaderboardScoreEntry[] }) {
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
        <MinigameBoard rows={board.slice(0, 5)} />
      </div>
      <div className="mt-4 text-[11px] font-bold uppercase tracking-[0.16em] text-text-3">
        Best <span className="tnum text-text">{fmt(best)}</span> · press the <span className="text-brand-500">big button</span>
      </div>
    </div>
  )
}

// Game over: banner, final score, where it landed globally. Score shows instantly; rank + refreshed board fill in when submit resolves (board is the pre-run fallback meanwhile).
function OverOverlay({ over, board }: { over: { score: number; result: MinigameSubmit | null }; board: LeaderboardScoreEntry[] }) {
  const { score, result } = over
  const rows = result?.entries ?? board
  const isBest = result?.isBest ?? false
  const banner = isBest ? '★ New best' : result ? (result.rank <= 10 ? `Ranked #${result.rank}` : `Rank #${result.rank}`) : 'Run over'
  const sub = isBest ? 'Top of the board' : result ? (result.rank <= 10 ? 'On the board' : 'Keep climbing') : 'Saving score…'
  return (
    <div className="absolute inset-0 z-20 flex flex-col justify-center bg-black/95 p-[var(--screen-rim,24px)]">
      <div className={cnm('text-[11px] font-bold uppercase tracking-[0.2em]', isBest ? 'text-brand-500' : 'text-text-3')}>{banner}</div>
      <div className="tnum text-5xl font-extrabold leading-none text-text">{fmt(score)}</div>
      <div className="mt-1 text-[11px] uppercase tracking-[0.14em] text-text-3">{sub}</div>
      <div className="mt-5 w-full">
        <MinigameBoard rows={rows.slice(0, 6)} />
      </div>
      <div className="mt-4 text-[11px] font-bold uppercase tracking-[0.16em] text-text-3">
        Press the <span className="text-brand-500">big button</span> to play again
      </div>
    </div>
  )
}
