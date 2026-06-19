import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CandlestickChart } from 'lucide-react'
import type { FlapHud } from '@/components/game/flapEngine'
import type { ScoreEntry, SubmitResult } from '@/lib/leaderboard'
import { useConsoleControls } from '@/components/console/controls'
import { FlapEngine } from '@/components/game/flapEngine'
import { GameReadout, GameScreen, GameStage } from '@/components/game/screen'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { useAuth } from '@/lib/auth'
import { haptic } from '@/lib/haptics'
import { getScores, submitScore } from '@/lib/leaderboard'
import { sound } from '@/lib/sound'
import { cnm } from '@/utils/style'

// Candle Hop. A one-button flappy minigame (no Sui, no backend): tap the big button to fly the
// Pips face through scrolling candlesticks. A hit shakes the screen, then drops the character
// before the leaderboard appears. Runs on the 3D handheld's L-shaped aperture.
export const Route = createFileRoute('/_app/games/candle-hop')({ component: CandleHopScreen })

const GAME = 'candle-hop'
type Phase = 'title' | 'playing' | 'over'
const EMPTY_HUD: FlapHud = { score: 0, elapsed: 0, alive: false }
const fmt = (n: number) => Math.round(n).toLocaleString('en-US')

export function CandleHopScreen() {
  const { user } = useAuth()
  const reduced = useReducedMotion()

  const [phase, setPhase] = useState<Phase>('title')
  const [hud, setHud] = useState<FlapHud>(EMPTY_HUD)
  const [board, setBoard] = useState<Array<ScoreEntry>>(() => getScores(GAME))
  const [result, setResult] = useState<SubmitResult | null>(null)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const engineRef = useRef<FlapEngine | null>(null)
  const endRef = useRef<(score: number) => void>(() => {})

  const name = user?.displayName ?? 'You'
  const best = board[0]?.score ?? 0

  // The run ends from inside the engine loop. Kept in a ref so the engine (built once) always
  // calls the latest closure with the current display name.
  endRef.current = (score: number) => {
    const res = submitScore(GAME, name, score)
    if (res.isBest) {
      haptic('success')
      sound('win')
    }
    setResult(res)
    setBoard(res.scores)
    setPhase('over')
  }

  // Build the engine once the canvas is mounted; it lives for the screen and is reused across runs.
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const eng = new FlapEngine(c, {
      onHud: setHud,
      onEnd: (s) => endRef.current(s),
      onScore: () => haptic('selection'), // cleared a gap: a light tick
      onCrash: () => {
        haptic('error')
        sound('lose')
      },
      reduced,
    })
    engineRef.current = eng
    return () => {
      eng.destroy()
      engineRef.current = null
    }
  }, [reduced])

  const start = useCallback(() => {
    setResult(null)
    setHud(EMPTY_HUD)
    setPhase('playing')
    engineRef.current?.start()
    haptic('rigid')
  }, [])

  const flap = useCallback(() => {
    engineRef.current?.flap()
    haptic('medium')
  }, [])

  const playing = phase === 'playing'
  // One button is the whole game: it flaps while a run is live, starts / restarts otherwise. The two
  // idle action screens drift through an ambient light show while a run is live, calm on death/title.
  useConsoleControls({
    main: playing
      ? { label: 'FLAP', color: 'amber', onPress: flap }
      : { label: phase === 'over' ? 'PLAY AGAIN' : 'PLAY', color: 'amber', onPress: start },
    lightShow: playing,
  })

  const liveBest = Math.max(best, hud.score) // best ticks up the moment you pass it

  return (
    <GameScreen>
      <GameStage
        top={
          playing ? (
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

      {/* bottom-left: identity + how to play, always visible so it's instantly clear */}
      <GameReadout>
        <div className="flex items-center gap-3">
          <CandlestickChart size={30} strokeWidth={2.4} className="shrink-0 text-brand-500" />
          <div>
            <div className="text-[20px] font-extrabold uppercase leading-none tracking-[0.03em] text-text">Candle Hop</div>
            <div className="mt-1.5 text-[15px] font-semibold leading-snug text-text-2">Tap FLAP to fly. Thread the candles</div>
          </div>
        </div>
      </GameReadout>

      {phase === 'title' && <TitleOverlay best={best} board={board} />}
      {phase === 'over' && result && <OverOverlay result={result} />}
    </GameScreen>
  )
}

// Title: the pitch, the board, the prompt. Full-screen over the canvas.
function TitleOverlay({ best, board }: { best: number; board: Array<ScoreEntry> }) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col justify-center bg-black/93 p-[var(--screen-rim,24px)] backdrop-blur-[1px]">
      <div className="flex items-center gap-2.5">
        <CandlestickChart size={26} strokeWidth={2.4} className="text-brand-500" />
        <h1 className="text-4xl font-extrabold leading-none tracking-tight text-text">Candle Hop</h1>
      </div>
      <p className="mt-2 max-w-[82%] text-sm leading-snug text-text-2">
        Tap to lift Pips, let it fall, and slip through the candle gaps. It moves calmly, but one bad line ends the run.
      </p>
      <div className="mt-5 w-full">
        <Board rows={board.slice(0, 5)} />
      </div>
      <div className="mt-4 text-[11px] font-bold uppercase tracking-[0.16em] text-text-3">
        Best <span className="tnum text-text">{fmt(best)}</span> · hit <span className="text-brand-500">PLAY</span>
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
        Hit <span className="text-brand-500">PLAY AGAIN</span>
      </div>
    </div>
  )
}

// The shared leaderboard list. The player's just-set row glows.
function Board({ rows }: { rows: Array<ScoreEntry> }) {
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
