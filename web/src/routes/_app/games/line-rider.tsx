import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useConsoleControls } from '@/components/console/controls'
import { GameReadout, GameScreen, GameStage } from '@/components/game/screen'
import { RideEngine, heat, type RideHud } from '@/components/game/rideEngine'
import { Stat } from '@/components/Stat'
import { haptic } from '@/lib/haptics'
import { sound } from '@/lib/sound'
import { useAuth } from '@/lib/auth'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import {
  bestScore,
  getScores,
  submitScore,
  type ScoreEntry,
  type SubmitResult,
} from '@/lib/leaderboard'
import { cnm } from '@/utils/style'

// Line Rider. A pure local arcade minigame (no Sui, no backend): a neon trend line scrolls in, the
// thumbwheel rides a pip on it, the multiplier + unbanked "pending" climb while you hug it, and the
// main button BANKs that pending into a safe score before a slip drains your grip and ends the run.
// Hold vs take-profit, as a reflex toy. Runs on the 3D handheld's L-shaped aperture like the others.
export const Route = createFileRoute('/_app/games/line-rider')({ component: LineRiderScreen })

const GAME = 'line-rider'
const WHEEL_STEPS = 24 // knob resolution for the pip's vertical position (knob is ~40px/detent)

type Phase = 'title' | 'playing' | 'over'
const EMPTY_HUD: RideHud = { score: 0, pending: 0, multiplier: 1, grip: 1, elapsed: 0, onLine: false }
const fmt = (n: number) => Math.round(n).toLocaleString('en-US')

function LineRiderScreen() {
  const { user } = useAuth()
  const reduced = useReducedMotion()

  const [phase, setPhase] = useState<Phase>('title')
  const [wheel, setWheel] = useState(Math.round(WHEEL_STEPS / 2))
  const [hud, setHud] = useState<RideHud>(EMPTY_HUD)
  const [board, setBoard] = useState<ScoreEntry[]>(() => getScores(GAME))
  const [result, setResult] = useState<SubmitResult | null>(null)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const engineRef = useRef<RideEngine | null>(null)
  const endRef = useRef<(score: number) => void>(() => {})

  const name = user?.displayName ?? 'You'
  const best = result ? result.scores[0]?.score ?? 0 : bestScore(GAME)

  // The run ends from inside the engine loop. Kept in a ref so the engine (built once) always calls
  // the latest closure, picking up the current display name.
  endRef.current = (score: number) => {
    haptic('error')
    sound('lose')
    const res = submitScore(GAME, name, score)
    setResult(res)
    setBoard(res.scores)
    setPhase('over')
  }

  // Build the engine once the canvas is mounted; it lives for the screen's lifetime and is reused
  // across runs (start() resets it). Per-frame HUD comes back throttled.
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const eng = new RideEngine(c, {
      onHud: setHud,
      onEnd: (s) => endRef.current(s),
      onMilestone: () => haptic('rigid'), // multiplier crossed an integer: a satisfying "level up"
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
    setPhase('playing')
    const eng = engineRef.current
    if (eng) {
      eng.setTarget(wheel / WHEEL_STEPS)
      eng.start()
    }
    haptic('rigid')
  }, [wheel])

  const bank = useCallback(() => {
    const amt = engineRef.current?.bank() ?? 0
    if (amt > 0) {
      haptic('success')
      sound('win')
    } else {
      haptic('warning') // nothing to bank yet
    }
  }, [])

  const onWheel = useCallback((v: number) => {
    setWheel(v)
    engineRef.current?.setTarget(v / WHEEL_STEPS)
  }, [])

  const playing = phase === 'playing'
  useConsoleControls({
    knob: { label: 'RIDE', min: 0, max: WHEEL_STEPS, step: 1, value: wheel, onChange: onWheel },
    main: playing
      ? { label: 'BANK', color: 'up', onPress: bank }
      : { label: phase === 'over' ? 'PLAY AGAIN' : 'PLAY', color: 'amber', onPress: start },
  })

  const multColor = heat(hud.multiplier)
  const gripPct = Math.round(hud.grip * 100)

  return (
    <GameScreen>
      <GameStage
        top={
          playing ? (
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Banked</div>
                <div className="tnum text-3xl font-extrabold leading-none text-text">
                  $<Stat value={hud.score} decimals={0} />
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Grip {gripPct}%</div>
                <div className="tnum text-3xl font-extrabold leading-none" style={{ color: multColor }}>
                  x{hud.multiplier.toFixed(1)}
                </div>
              </div>
            </div>
          ) : null
        }
      >
        <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />
        {phase === 'title' && <TitleOverlay best={best} board={board} />}
        {phase === 'over' && result && <OverOverlay result={result} />}
      </GameStage>

      {/* readout band — left-only, notch-safe. The live pending you're risking, then the bank cue. */}
      <GameReadout>
        {playing ? (
          <>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                {hud.onLine ? 'Riding' : 'Off the line'}
              </div>
              <div className="tnum text-4xl font-extrabold leading-none" style={{ color: hud.pending > 0 ? multColor : '#8a8a8a' }}>
                +{fmt(hud.pending)}
              </div>
            </div>
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
              <span className="text-up">BANK</span> to lock it in
            </div>
          </>
        ) : (
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
            Hold the line, <span className="text-brand-500">BANK</span> before it breaks
          </div>
        )}
      </GameReadout>
    </GameScreen>
  )
}

// Title: the pitch, the best, and the board. The overlay sits over the (static) canvas.
function TitleOverlay({ best, board }: { best: number; board: ScoreEntry[] }) {
  return (
    <div className="absolute inset-0 flex flex-col justify-center bg-black/82 p-[var(--screen-rim,24px)] backdrop-blur-[1px]">
      <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-brand-500">Arcade</div>
      <h1 className="text-4xl font-extrabold leading-none tracking-tight text-text">Line Rider</h1>
      <p className="mt-2 max-w-[80%] text-sm leading-snug text-text-2">
        Ride the wheel to hug the line. Your streak climbs while you hold it. <span className="text-up">BANK</span> it
        before a slip drains your grip.
      </p>
      <div className="mt-4 max-w-[78%]">
        <Board rows={board.slice(0, 5)} />
      </div>
      <div className="mt-4 text-[11px] font-bold uppercase tracking-[0.16em] text-text-3">
        Best <span className="tnum text-text">{fmt(best)}</span> · hit <span className="text-brand-500">PLAY</span>
      </div>
    </div>
  )
}

// Game over: the banner, the score, where it landed. Shown after every run.
function OverOverlay({ result }: { result: SubmitResult }) {
  const you = result.scores.find((s) => s.you)
  const score = you?.score ?? 0
  const placed = result.rank > 0
  return (
    <div className="absolute inset-0 flex flex-col justify-center bg-black/85 p-[var(--screen-rim,24px)]">
      <div className={cnm('text-[11px] font-bold uppercase tracking-[0.2em]', result.isBest ? 'text-brand-500' : 'text-text-3')}>
        {result.isBest ? '★ New best' : placed ? `Ranked #${result.rank}` : 'Run over'}
      </div>
      <div className="tnum text-5xl font-extrabold leading-none text-text">{fmt(score)}</div>
      <div className="mt-1 text-[11px] uppercase tracking-[0.14em] text-text-3">
        {result.isBest ? 'Top of the board' : placed ? 'On the board' : `${fmt(result.prevBest)} to place`}
      </div>
      <div className="mt-4 max-w-[78%]">
        <Board rows={result.scores.slice(0, 6)} />
      </div>
      <div className="mt-4 text-[11px] font-bold uppercase tracking-[0.16em] text-text-3">
        Hit <span className="text-brand-500">PLAY AGAIN</span>
      </div>
    </div>
  )
}

// The shared leaderboard list. The player's just-set row glows.
function Board({ rows }: { rows: ScoreEntry[] }) {
  return (
    <div className="flex flex-col font-mono">
      {rows.map((r, i) => (
        <div
          key={`${r.name}-${r.at}`}
          className={cnm(
            'flex items-center gap-2 py-0.5 text-[12px] tracking-[0.04em]',
            r.you ? 'text-brand-500' : 'text-text-2',
          )}
        >
          <span className="tnum w-5 text-text-3">{i + 1}</span>
          <span className="flex-1 truncate font-bold uppercase">{r.you ? 'You' : r.name}</span>
          <span className="tnum font-bold">{fmt(r.score)}</span>
          {r.you && <span className="text-brand-500">◀</span>}
        </div>
      ))}
    </div>
  )
}
