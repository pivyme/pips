import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useConsoleControls } from '@/components/console/controls'
import { Chart } from '@/components/game/Chart'
import { ResultOverlay, ScreenMessage } from '@/components/game/screen'
import { Stat } from '@/components/Stat'
import { Illo } from '@/ui/Illo'
import { Modal, useOverlayState } from '@/ui/Modal'
import { haptic } from '@/lib/haptics'
import { sound } from '@/lib/sound'
import { api, streamPlay, type LuckyParams, type PlayDTO, type PlayStatus, type Side } from '@/lib/api'
import { placePlay, cashOut } from '@/lib/sui/predict'
import { toastError } from '@/lib/errors'
import { notifyUnlocks } from '@/lib/achievements'
import { useAuth } from '@/lib/auth'
import { cnm } from '@/utils/style'

// I Feel Lucky, the hero. Pick a bet, hit play, three reels spin and snap to a fair server RNG,
// then ride the live PnL on the chart and cash out (or let it settle at expiry). Every round is
// a real Predict mint/redeem; the screen just drives the flow and renders the feel.
export const Route = createFileRoute('/_app/games/lucky')({ component: LuckyScreen })

const MIN_STAKE = 1
const MAX_STAKE = 100
const FALLBACK_ASSETS = ['BTC', 'ETH', 'SUI', 'SOL', 'DEEP']
const LEV_POOL = ['2x', '5x', '10x', '25x', '100x']
const SIDE_POOL = ['LONG', 'SHORT']
const SPIN_STOPS = [720, 980, 1240] // staggered reel stops (ms)
const SPIN_TOTAL = 1320
const RESULT_MS = 4200
const TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out', 'error'])

type Phase = 'idle' | 'placing' | 'spinning' | 'open' | 'cashing' | 'result'
type Live = { markValue: string; pnl: string; multiplier: number; status: PlayStatus }

const money = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const sideLabel = (s: Side): string => (s === 'up' ? 'LONG' : 'SHORT')

function LuckyScreen() {
  const { refresh } = useAuth()
  const qc = useQueryClient()
  const help = useOverlayState()
  const history = useOverlayState()

  const [bet, setBet] = useState(25)
  const [phase, setPhase] = useState<Phase>('idle')
  const [play, setPlay] = useState<PlayDTO | null>(null)
  const [live, setLive] = useState<Live | null>(null)

  const finalized = useRef(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const marketsQ = useQuery({ queryKey: ['markets'], queryFn: () => api.markets(), refetchInterval: 10_000 })
  const markets = marketsQ.data?.markets ?? []
  const liveAssets = markets.filter((m) => m.live).map((m) => m.asset)
  const assetPool = liveAssets.length ? liveAssets : FALLBACK_ASSETS
  const noLiveMarket = !marketsQ.isLoading && !marketsQ.isError && liveAssets.length === 0
  const canPlay = liveAssets.length > 0 && bet >= MIN_STAKE && bet <= MAX_STAKE

  const chartAsset = play?.params.asset ?? liveAssets[0]
  const showStrike = play != null && (phase === 'spinning' || phase === 'open' || phase === 'cashing' || phase === 'result')
  const strike = play?.market.strike ? parseFloat(play.market.strike) : undefined

  const clearResetTimer = () => {
    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = null
  }

  const finishResult = useCallback(
    (final: PlayDTO, unlocked: string[]) => {
      finalized.current = true
      setPlay(final)
      setLive({ markValue: final.markValue, pnl: final.pnl, multiplier: final.multiplier, status: final.status })
      setPhase('result')
      haptic(final.status === 'lost' ? 'error' : 'success')
      sound(final.status === 'lost' ? 'lose' : 'win')
      notifyUnlocks(unlocked)
      void refresh()
      // Settle/cashout moved the record: freshen stats, achievements, and history.
      for (const key of ['stats', 'achievements', 'plays']) void qc.invalidateQueries({ queryKey: [key] })
      clearResetTimer()
      resetTimer.current = setTimeout(() => setPhase('idle'), RESULT_MS)
    },
    [refresh, qc],
  )

  // Live PnL while a play is open. Closes on a terminal frame (expiry settle); we then refetch
  // the finalized play to grab payout + the redeem digest for the result + explorer link.
  useEffect(() => {
    if (!play || phase !== 'open') return
    const unsub = streamPlay(
      play.id,
      (tick) => {
        setLive({ markValue: tick.markValue, pnl: tick.pnl, multiplier: tick.multiplier, status: tick.status })
        if (TERMINAL.has(tick.status) && !finalized.current) {
          finalized.current = true
          void api
            .getPlay(play.id)
            .then(({ play: final }) => finishResult(final, []))
            .catch(() => setPhase('idle'))
        }
      },
      () => {
        // SSE dropped: keep the last good readout, EventSource will retry on its own.
      },
    )
    return unsub
  }, [play, phase, finishResult])

  useEffect(() => () => clearResetTimer(), [])

  const doPlay = useCallback(async () => {
    if (phase !== 'idle' && phase !== 'result') return
    if (!canPlay) {
      toast.error('No live market right now. Try again in a sec.')
      return
    }
    clearResetTimer()
    finalized.current = false
    setPhase('placing')
    haptic('rigid')
    try {
      const { play: p } = await placePlay('lucky', { stake: bet })
      setPlay(p)
      setLive({ markValue: p.markValue, pnl: p.pnl, multiplier: p.multiplier, status: p.status })
      setPhase('spinning')
      haptic('heavy')
      setTimeout(() => setPhase((cur) => (cur === 'spinning' ? 'open' : cur)), SPIN_TOTAL)
    } catch (e) {
      toastError(e)
      setPhase('idle')
    }
  }, [phase, canPlay, bet])

  const doCashOut = useCallback(async () => {
    if (phase !== 'open' || !play) return
    setPhase('cashing')
    haptic('rigid')
    try {
      const { play: p, unlocked } = await cashOut(play.id)
      finishResult(p, unlocked)
    } catch (e) {
      // Expiry may have beaten the cash-out. Reconcile against the chain before complaining.
      try {
        const { play: final } = await api.getPlay(play.id)
        if (TERMINAL.has(final.status)) {
          finishResult(final, [])
          return
        }
      } catch {
        // fall through to the error toast
      }
      toastError(e)
      setPhase('open')
    }
  }, [phase, play, finishResult])

  const openHistory = useCallback(() => {
    haptic('selection')
    history.open()
  }, [history])

  const isOpen = phase === 'open'
  useConsoleControls({
    knob: {
      label: 'BET',
      min: MIN_STAKE,
      max: MAX_STAKE,
      step: 1,
      value: bet,
      onChange: setBet,
      format: (v) => `$${v}`,
      disabled: phase !== 'idle' && phase !== 'result',
    },
    action1: { label: 'How to', color: 'neutral', onPress: help.open },
    action2: { label: 'History', color: 'neutral', onPress: openHistory },
    main: isOpen
      ? { label: 'CASH OUT', color: 'up', onPress: () => void doCashOut() }
      : phase === 'cashing'
        ? { label: 'CASH OUT', color: 'up', onPress: () => {}, loading: true, disabled: true }
        : {
            label: 'PLAY',
            color: 'amber',
            onPress: () => void doPlay(),
            loading: phase === 'placing' || phase === 'spinning',
            disabled: !canPlay || phase === 'placing' || phase === 'spinning',
          },
  })

  const spinning = phase === 'spinning'
  const pnlNum = live ? parseFloat(live.pnl) : 0
  const maxPayout = play ? parseFloat(play.stake) * (live?.multiplier ?? play.multiplier) : 0
  const showReadouts = play != null && (phase === 'open' || phase === 'cashing' || phase === 'result')
  const lp = play ? (play.params as LuckyParams) : null

  return (
    <div className="relative flex h-full flex-col gap-3 p-4">
      <h1 className="px-1 pt-1 text-xl font-extrabold tracking-tight">I Feel Lucky</h1>

      <div className="grid grid-cols-3 gap-2">
        <Reel label="Leverage" pool={LEV_POOL} target={lp ? `${lp.leverage}x` : undefined} spinning={spinning} stopAt={SPIN_STOPS[0]} />
        <Reel label="Asset" pool={assetPool} target={lp?.asset} spinning={spinning} stopAt={SPIN_STOPS[1]} />
        <Reel
          label="Side"
          pool={SIDE_POOL}
          target={lp ? sideLabel(lp.side) : undefined}
          spinning={spinning}
          stopAt={SPIN_STOPS[2]}
          tone={lp?.side}
        />
      </div>

      {/* The live display. Markets gate the playable state per the screen state matrix. */}
      <div className="screen relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-card">
        {marketsQ.isLoading ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="shimmer h-24 w-full rounded-md" />
          </div>
        ) : marketsQ.isError ? (
          <ScreenMessage title="Could not load markets" action="Retry" onAction={() => void marketsQ.refetch()} />
        ) : noLiveMarket ? (
          <ScreenMessage title="No live markets right now." action="Retry" onAction={() => void marketsQ.refetch()} />
        ) : (
          <>
            {chartAsset ? (
              <Chart asset={chartAsset} overlays={showStrike && strike != null ? { strike } : undefined} className="flex-1" />
            ) : (
              <div className="flex-1" />
            )}

            {showReadouts ? (
              <div className="flex items-end justify-between gap-3 px-4 pb-4">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-text-3">Live</div>
                  <div className={cnm('text-4xl font-extrabold leading-none', pnlNum >= 0 ? 'text-up' : 'text-down')}>
                    {pnlNum >= 0 ? '+' : '-'}$<Stat value={Math.abs(pnlNum)} />
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-text-3">Payout</div>
                  <div className="tnum text-lg font-bold text-text-2">
                    $<Stat value={maxPayout} />
                  </div>
                </div>
              </div>
            ) : (
              <div className="px-4 pb-4 text-center text-sm text-text-3">Set your bet. Hit play. See what you get.</div>
            )}
          </>
        )}

        {phase === 'result' && play && (
          <ResultOverlay {...luckyResult(play)} onDismiss={() => setPhase('idle')} />
        )}
      </div>

      <HelpSheet state={help} />
      <HistorySheet state={history} open={history.isOpen} />
    </div>
  )
}

// One reel. While spinning it cycles random pool values, then snaps to the target at its stop
// time with a haptic tick. The stagger across the three reels is the slot-machine feel.
function Reel({
  label,
  pool,
  target,
  spinning,
  stopAt,
  tone,
}: {
  label: string
  pool: string[]
  target?: string
  spinning: boolean
  stopAt: number
  tone?: Side
}) {
  const [shown, setShown] = useState<string>('?')
  const poolRef = useRef(pool)
  poolRef.current = pool

  useEffect(() => {
    if (!spinning || !target) return
    let stopped = false
    const iv = setInterval(() => {
      if (!stopped) {
        const p = poolRef.current
        setShown(p[Math.floor(Math.random() * p.length)])
      }
    }, 70)
    const to = setTimeout(() => {
      stopped = true
      clearInterval(iv)
      setShown(target)
      haptic('rigid')
    }, stopAt)
    return () => {
      clearInterval(iv)
      clearTimeout(to)
    }
  }, [spinning, target, stopAt])

  useEffect(() => {
    if (!spinning) setShown(target ?? '?')
  }, [spinning, target])

  return (
    <div className="card-neo flex flex-col items-center justify-center gap-1 py-4">
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-3">{label}</span>
      <span
        className={cnm(
          'tnum text-lg font-extrabold',
          !spinning && tone === 'up' && 'text-up',
          !spinning && tone === 'down' && 'text-down',
        )}
      >
        {shown}
      </span>
    </div>
  )
}

// Lucky's result copy (07-DESIGN-SYSTEM.md), fed into the shared ResultOverlay.
function luckyResult(play: PlayDTO): { title: string; tone: 'up' | 'down'; digest?: string } {
  const payout = parseFloat(play.payout ?? '0')
  const pnl = parseFloat(play.pnl ?? '0')
  const tone: 'up' | 'down' = play.status === 'lost' ? 'down' : pnl >= 0 ? 'up' : 'down'
  const title =
    play.status === 'won'
      ? `You won $${money(payout)}`
      : play.status === 'cashed_out'
        ? `Cashed out +$${money(Math.max(pnl, 0))}`
        : 'Missed it.'
  return { title, tone, digest: play.txRedeem ?? play.txMint }
}

function HelpSheet({ state }: { state: ReturnType<typeof useOverlayState> }) {
  return (
    <Modal isOpen={state.isOpen} onOpenChange={state.setOpen} placement="bottom" title="How I Feel Lucky works">
      <p className="text-sm leading-relaxed text-text-2">
        Pick a bet and hit play. You get a random asset, leverage, and side. The price moves, your payout moves with it.
        Cash out whenever, or let it ride to the end.
      </p>
    </Modal>
  )
}

function HistorySheet({ state, open }: { state: ReturnType<typeof useOverlayState>; open: boolean }) {
  const q = useQuery({ queryKey: ['plays', 'history'], queryFn: () => api.plays({ limit: 20 }), enabled: open })
  const plays = q.data?.plays ?? []

  return (
    <Modal isOpen={state.isOpen} onOpenChange={state.setOpen} placement="bottom" title="Your plays">
      {q.isLoading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="shimmer h-12 rounded-sm" />
          ))}
        </div>
      ) : q.isError ? (
        <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
          <span className="h-1.5 w-1.5 rounded-full bg-down" />
          <p className="text-sm text-text-2">Could not load your plays</p>
          <button
            type="button"
            onClick={() => void q.refetch()}
            className="card-neo rounded-full px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-text-2"
          >
            Retry
          </button>
        </div>
      ) : plays.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 py-10 text-center">
          <Illo name="vault" size={72} />
          <div>
            <div className="text-lg font-extrabold">No plays yet</div>
            <div className="mt-1 text-sm text-text-2">Make your first play.</div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {plays.map((p) => (
            <HistoryRow key={p.id} play={p} />
          ))}
        </div>
      )}
    </Modal>
  )
}

function HistoryRow({ play }: { play: PlayDTO }) {
  const pnl = parseFloat(play.pnl ?? '0')
  const won = play.status === 'won' || play.status === 'cashed_out'
  return (
    <div className="card-neo flex items-center justify-between px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-bold">
          {play.market.asset} · {play.game}
        </div>
        <div className="text-[11px] uppercase tracking-wide text-text-3">{play.status.replace('_', ' ')}</div>
      </div>
      <div className={cnm('tnum text-sm font-bold', won && pnl >= 0 ? 'text-up' : pnl < 0 ? 'text-down' : 'text-text-2')}>
        {pnl >= 0 ? '+' : '-'}${money(Math.abs(pnl))}
      </div>
    </div>
  )
}
