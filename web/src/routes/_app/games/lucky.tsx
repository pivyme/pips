import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useConsoleControls } from '@/components/console/controls'
import { Chart } from '@/components/game/Chart'
import { Cell, GameReadout, GameScreen, GameStage, ResultOverlay, ScreenMessage } from '@/components/game/screen'
import { Stat } from '@/components/Stat'
import { haptic } from '@/lib/haptics'
import { sound } from '@/lib/sound'
import { api, streamPlay, type LuckyParams, type PlayDTO, type PlayStatus, type Side } from '@/lib/api'
import { placePlay, cashOut } from '@/lib/sui/predict'
import { toastError } from '@/lib/errors'
import { notifyUnlocks } from '@/lib/achievements'
import { useAuth } from '@/lib/auth'
import { cnm } from '@/utils/style'
import { formatStringToNumericDecimals } from '@/utils/format'

// I Feel Lucky, the hero. Pick a bet, hit play, three reels spin and snap to a fair server RNG,
// then ride the live PnL on the chart and cash out (or let it settle at expiry). Every round is a
// real Predict mint/redeem. Runs on the 3D handheld: the number wheel is the bet, the action buttons
// set speed + risk, the main button plays / cashes out. The screen is the L-shaped aperture
// (web/CLAUDE.md): a top bar + the reel cluster float over the chart, a notch-safe readout below.
export const Route = createFileRoute('/_app/games/lucky')({ component: LuckyScreen })

const STAKE_LADDER = [0.1, 0.5, 1, 5, 10] as const
const FALLBACK_ASSETS = ['BTC', 'ETH', 'SUI', 'SOL', 'DEEP']
const FALLBACK_DURATIONS = [10, 30, 60]
const LEV_POOL = ['2x', '5x', '10x', '25x', '100x']
const SIDE_POOL = ['LONG', 'SHORT']
const SPIN_STOPS = [720, 980, 1240] // staggered reel stops (ms)
const SPIN_TOTAL = 1320
const RESULT_MS = 4200
const TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out', 'error'])

// Action 2: the risk tier. Asset and side stay random ("I feel lucky"), but the player sets how
// spicy the spin is. Chill hugs ATM (small, frequent), Lotto only draws the far, big-multiple
// strikes. Maps to the backend RiskTier, which constrains the leverage RNG.
const RISK_TIERS = [
  { key: 'chill', label: 'CHILL' },
  { key: 'wild', label: 'WILD' },
  { key: 'lotto', label: 'LOTTO' },
] as const

type Phase = 'idle' | 'placing' | 'spinning' | 'open' | 'cashing' | 'result'
type Live = { markValue: string; pnl: string; multiplier: number; status: PlayStatus }

const money = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const sideLabel = (s: Side): string => (s === 'up' ? 'LONG' : 'SHORT')
const durationLabel = (s: number): string => (s >= 60 ? `${s / 60}m` : `${s}s`)
const priceLabel = (p: number): string =>
  `$${p.toLocaleString('en-US', { maximumFractionDigits: p >= 1000 ? 0 : 2 })}`

function LuckyScreen() {
  const { refresh, user } = useAuth()
  const qc = useQueryClient()

  const [betIdx, setBetIdx] = useState(2)
  const [durIdx, setDurIdx] = useState(1) // SPEED (Action 1): index into durations, default mid
  const [riskIdx, setRiskIdx] = useState(1) // RISK (Action 2): index into RISK_TIERS, default WILD
  const [phase, setPhase] = useState<Phase>('idle')
  const [play, setPlay] = useState<PlayDTO | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [spot, setSpot] = useState<number | null>(null)
  const [secsLeft, setSecsLeft] = useState<number | null>(null)

  const finalized = useRef(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const marketsQ = useQuery({ queryKey: ['markets'], queryFn: () => api.markets(), refetchInterval: 10_000 })
  const markets = marketsQ.data?.markets ?? []
  const liveAssets = markets.filter((m) => m.live).map((m) => m.asset)
  const assetPool = liveAssets.length ? liveAssets : FALLBACK_ASSETS
  const noLiveMarket = !marketsQ.isLoading && !marketsQ.isError && liveAssets.length === 0
  const canPlay = liveAssets.length > 0

  const durations = markets[0]?.durations ?? FALLBACK_DURATIONS
  const duration = durations[Math.min(durIdx, durations.length - 1)] ?? FALLBACK_DURATIONS[0]
  const risk = RISK_TIERS[riskIdx]
  const bet = STAKE_LADDER[betIdx]

  const lp = play ? (play.params as LuckyParams) : null
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
      const { play: p } = await placePlay('lucky', { stake: bet, duration, risk: risk.key })
      setPlay(p)
      setLive({ markValue: p.markValue, pnl: p.pnl, multiplier: p.multiplier, status: p.status })
      setPhase('spinning')
      haptic('heavy')
      setTimeout(() => setPhase((cur) => (cur === 'spinning' ? 'open' : cur)), SPIN_TOTAL)
    } catch (e) {
      toastError(e)
      setPhase('idle')
    }
  }, [phase, canPlay, bet, duration, risk.key])

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

  // Round timer: the chosen duration is the round length, realized as an auto-cash at the live
  // mark. The on-chain oracle lives ~5 min; the round is the UX timer (see 05-SUI-PREDICT). The
  // player can still cash out early with Main; whichever comes first wins.
  useEffect(() => {
    if (phase !== 'open' || !play) {
      setSecsLeft(null)
      return
    }
    const lenMs = ((play.params as LuckyParams).duration || duration) * 1000
    const endAt = (play.openedAt ? Date.parse(play.openedAt) : Date.now()) + lenMs
    let fired = false
    const tick = () => {
      const left = Math.max(0, Math.ceil((endAt - Date.now()) / 1000))
      setSecsLeft(left)
      // The phase flips to 'cashing' on cash-out, tearing down this effect; `fired` guards the
      // gap before that re-render lands so we never fire two redeems.
      if (left <= 0 && !fired) {
        fired = true
        void doCashOut()
      }
    }
    tick()
    const iv = setInterval(tick, 250)
    return () => clearInterval(iv)
  }, [phase, play, duration, doCashOut])

  const cycleSpeed = useCallback(() => {
    haptic('selection')
    setDurIdx((i) => (i + 1) % durations.length)
  }, [durations.length])
  const cycleRisk = useCallback(() => {
    haptic('selection')
    setRiskIdx((i) => (i + 1) % RISK_TIERS.length)
  }, [])

  const isOpen = phase === 'open'
  useConsoleControls({
    numberWheel: {
      label: 'USDC',
      min: 0,
      max: STAKE_LADDER.length - 1,
      step: 1,
      value: betIdx,
      onChange: setBetIdx,
      format: (v) => String(STAKE_LADDER[v]),
    },
    action1: { label: durationLabel(duration), color: 'neutral', onPress: cycleSpeed },
    action2: { label: risk.label, color: 'neutral', onPress: cycleRisk },
    main: isOpen
      ? { label: 'CASH OUT', color: 'up', onPress: () => void doCashOut() }
      : phase === 'cashing'
        ? { label: 'CASH OUT', color: 'up', onPress: () => {}, loading: true }
        : {
            label: 'PLAY',
            color: 'amber',
            onPress: () => void doPlay(),
            loading: phase === 'placing' || phase === 'spinning',
          },
  })

  const spinning = phase === 'spinning'
  const pnlNum = live ? parseFloat(live.pnl) : 0
  const maxPayout = play ? parseFloat(play.stake) * (live?.multiplier ?? play.multiplier) : 0
  const showReadouts = play != null && (phase === 'open' || phase === 'cashing' || phase === 'result')

  // The device screen is the L-shaped aperture (web/CLAUDE.md "The console screen"): the chart fills
  // the slack height with the top bar + reel cluster floating over it, then a notch-safe readout band
  // the chart stops above. The rim inset is owned by the GameScreen/GameStage/GameReadout layout.
  return (
    <GameScreen>
      {marketsQ.isLoading ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="shimmer h-24 w-2/3 rounded-md" />
        </div>
      ) : marketsQ.isError ? (
        <ScreenMessage title="Could not load markets" action="Retry" onAction={() => void marketsQ.refetch()} />
      ) : noLiveMarket ? (
        <ScreenMessage title="No live markets right now." action="Retry" onAction={() => void marketsQ.refetch()} />
      ) : (
        <>
          {/* top bar + reel cluster float over the chart. The asset is hidden until the spin draws
              it, so at rest the title leads instead of a price. */}
          <GameStage
            top={
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    {lp ? (
                      <>
                        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Lucky · {lp.asset}</div>
                        <div className="tnum text-2xl font-extrabold leading-none text-text">
                          {spot != null ? priceLabel(spot) : '—'}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Pips</div>
                        <div className="text-2xl font-extrabold leading-none tracking-tight text-text">I Feel Lucky</div>
                      </>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                      {showReadouts && secsLeft != null ? 'Ends in' : 'Balance'}
                    </div>
                    <div className="tnum text-xl font-bold leading-none text-text-2">
                      {showReadouts && secsLeft != null
                        ? `${secsLeft}s`
                        : user?.balance != null
                          ? `$${formatStringToNumericDecimals(user.balance, 2)}`
                          : '—'}
                    </div>
                  </div>
                </div>

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
              </div>
            }
          >
            {chartAsset ? (
              <Chart
                asset={chartAsset}
                overlays={showStrike && strike != null ? { strike } : undefined}
                onPrice={(p) => setSpot(p)}
                className="absolute inset-0"
              />
            ) : null}
          </GameStage>

          {/* readout band — Live PnL once a play runs, the bet setup at rest. */}
          <GameReadout>
            {showReadouts ? (
              <>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Live PnL</div>
                  <div className={cnm('text-4xl font-extrabold leading-none', pnlNum >= 0 ? 'text-up' : 'text-down')}>
                    {pnlNum >= 0 ? '+' : '-'}$<Stat value={Math.abs(pnlNum)} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-x-4">
                  <Cell label="Payout" value={`$${money(maxPayout)}`} />
                  <Cell label="Ends" value={secsLeft != null ? `${secsLeft}s` : '—'} />
                </div>
              </>
            ) : (
              <>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Your bet</div>
                  <div className="tnum text-4xl font-extrabold leading-none text-brand-500">${bet}</div>
                </div>
                <div className="grid grid-cols-2 gap-x-4">
                  <Cell label="Risk" value={risk.label} />
                  <Cell label="Speed" value={durationLabel(duration)} />
                </div>
              </>
            )}
          </GameReadout>
        </>
      )}

      {phase === 'result' && play && <ResultOverlay {...luckyResult(play)} onDismiss={() => setPhase('idle')} />}
    </GameScreen>
  )
}

// One reel. While spinning it cycles random pool values, then snaps to the target at its stop
// time with a haptic tick. The stagger across the three reels is the slot-machine feel. The cell
// is opaque so it reads cleanly where it floats over the live chart.
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
    <div className="card-neo flex flex-col items-center justify-center gap-0.5 py-2">
      <span className="text-[9px] font-semibold uppercase tracking-[0.08em] text-text-3">{label}</span>
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
