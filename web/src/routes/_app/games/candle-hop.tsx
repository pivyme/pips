import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CandlestickChart } from 'lucide-react'
import type { FlapHud } from '@/components/game/flapEngine'
import type { LeaderboardScoreEntry, MinigameSubmit } from '@/lib/api'
import { useConsoleControls, useDeviceSettled } from '@/components/console/controls'
import { FlapEngine } from '@/components/game/flapEngine'
import { GameReadout, GameScreen, GameStage, ScreenCRT } from '@/components/game/screen'
import { MinigameBoard, useMinigameLeaderboard } from '@/components/game/MinigameBoard'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { haptic } from '@/lib/haptics'
import { sound, startBgm, stopBgm, hopScore, hopLose, hopResetCombo } from '@/lib/sound'
import { cnm } from '@/utils/style'

// Flappy Piper. A one-button flappy minigame (no Sui, no backend): tap the big button to fly the
// PIPS face through scrolling candlesticks. A hit shakes the screen, then drops the character
// before the leaderboard appears. Runs on the 3D handheld's L-shaped aperture.
export const Route = createFileRoute('/_app/games/candle-hop')({ component: CandleHopScreen })

const GAME = 'candle-hop'
type Phase = 'title' | 'playing' | 'over'
const EMPTY_HUD: FlapHud = { score: 0, elapsed: 0, alive: false }
const fmt = (n: number) => Math.round(n).toLocaleString('en-US')

function CandleHopScreen() {
  const reduced = useReducedMotion()

  // Hold the screen black until the device has finished dropping in, then a short beat, then fade
  // the game in, so it doesn't pop on mid-settle. No settle (nav / restore) just gives a clean fade.
  const deviceSettled = useDeviceSettled()
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    if (reduced) return setRevealed(true)
    if (!revealed && deviceSettled) {
      const t = window.setTimeout(() => setRevealed(true), 300)
      return () => window.clearTimeout(t)
    }
  }, [deviceSettled, reduced, revealed])

  const [phase, setPhase] = useState<Phase>('title')
  const [hud, setHud] = useState<FlapHud>(EMPTY_HUD)
  const { board, submit } = useMinigameLeaderboard(GAME)
  const [over, setOver] = useState<{ score: number; result: MinigameSubmit | null } | null>(null)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const engineRef = useRef<FlapEngine | null>(null)
  const endRef = useRef<(score: number) => void>(() => {})

  const best = board[0]?.score ?? 0

  // The run ends from inside the engine loop. Kept in a ref so the engine (built once) always calls
  // the latest closure. Show the score instantly; the new-best celebration fires once submit lands.
  endRef.current = (score: number) => {
    setOver({ score, result: null })
    setPhase('over')
    void submit(score)
      .then((result) => {
        setOver((o) => (o ? { ...o, result } : { score, result }))
        if (result.isBest) {
          haptic('success')
          sound('win')
        }
      })
      .catch(() => {})
  }

  // Build the engine once the canvas is mounted; it lives for the screen and is reused across runs.
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const eng = new FlapEngine(c, {
      onHud: setHud,
      onEnd: (s) => endRef.current(s),
      onScore: () => {
        haptic('selection') // cleared a gap: a light tick
        hopScore() // and a bright "tuiing" that climbs with the streak
      },
      onCrash: () => {
        haptic('error')
        stopBgm() // cut the bed the instant you hit, so the lose synth lands clean
        hopLose()
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
    setOver(null)
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
  // BGM rides the run: the synth bed loops only while you're alive, and the combo ladder resets each
  // run so every "tuiing" streak starts fresh. Cleanup covers death, navigating away, and unmount.
  useEffect(() => {
    if (!playing) return
    hopResetCombo()
    startBgm()
    return () => stopBgm()
  }, [playing])

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
    <div
      className={cnm(
        'h-full w-full transition-opacity duration-500 ease-out',
        revealed ? 'opacity-100' : 'opacity-0',
      )}
    >
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
              <div className="text-[20px] font-extrabold uppercase leading-none tracking-[0.03em] text-text">Flappy Piper</div>
              <div className="mt-1.5 text-[15px] font-semibold leading-snug text-text-2">Tap the big button to fly</div>
            </div>
          </div>
        </GameReadout>

        <ScreenCRT />

        {phase === 'title' && <TitleOverlay best={best} board={board} />}
        {phase === 'over' && over && <OverOverlay over={over} board={board} />}
      </GameScreen>
    </div>
  )
}

// Title: the pitch, the board, the prompt. Full-screen over the canvas.
function TitleOverlay({ best, board }: { best: number; board: LeaderboardScoreEntry[] }) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col justify-center bg-black/93 p-[var(--screen-rim,24px)] backdrop-blur-[1px]">
      <div className="flex items-center gap-2.5">
        <CandlestickChart size={26} strokeWidth={2.4} className="text-brand-500" />
        <h1 className="text-4xl font-extrabold leading-none tracking-tight text-text">Flappy Piper</h1>
      </div>
      <p className="mt-2 max-w-[82%] text-sm leading-snug text-text-2">
        Tap to lift PIPS, let it fall, and slip through the candle gaps. It moves calmly, but one bad line ends the run.
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

// Game over: the banner, the final score, where it landed globally. The score shows instantly; the
// rank + refreshed board fill in when the submit resolves (board is the pre-run fallback meanwhile).
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
