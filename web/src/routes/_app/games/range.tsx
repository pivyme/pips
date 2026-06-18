import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useConsoleControls } from '@/components/console/controls'
import { Chart, type BandOverlay } from '@/components/game/Chart'
import { Cell, ResultOverlay, ScreenMessage } from '@/components/game/screen'
import { Stat } from '@/components/Stat'
import { haptic } from '@/lib/haptics'
import { sound } from '@/lib/sound'
import { api, streamPlay, type PlayDTO, type PlayStatus } from '@/lib/api'
import { placePlay, cashOut } from '@/lib/sui/predict'
import { toastError } from '@/lib/errors'
import { notifyUnlocks } from '@/lib/achievements'
import { useAuth } from '@/lib/auth'
import { cnm } from '@/utils/style'
import { formatStringToNumericDecimals } from '@/utils/format'

// Range: rotate the knob to size a band around spot. Tighter band, lower odds, bigger multiple.
// A real mint_range under the hood; win if the settle price lands inside, cash out early at the
// live mark. The pre-play multiplier is a client estimate; the real one comes back on the mint.
export const Route = createFileRoute('/_app/games/range')({ component: RangeScreen })

const STAKE_LADDER = [0.1, 0.5, 1, 5, 10] as const
const FALLBACK_ASSETS = ['BTC', 'ETH', 'SUI', 'SOL', 'DEEP']
const FALLBACK_DURATIONS = [10, 30, 60]
const RESULT_MS = 4200
const TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out', 'error'])

type Phase = 'idle' | 'placing' | 'open' | 'cashing' | 'result'
type Live = { markValue: string; pnl: string; multiplier: number; status: PlayStatus }

const money = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const durationLabel = (s: number): string => (s >= 60 ? `${s / 60}m` : `${s}s`)

// Rough, monotonic estimate so the readout responds as the knob turns. Real value lands on mint.
function estimateMultiplier(halfPct: number, durationSec: number): number {
  const sigma = 0.6 * Math.sqrt(durationSec / 30) // ~1-sigma % move, scales with sqrt(T)
  const ratio = halfPct / sigma
  const prob = 1 - Math.exp(-ratio)
  return Math.max(1.05, Math.min(0.97 / Math.max(prob, 0.03), 99))
}

function RangeScreen() {
  const { refresh, user } = useAuth()
  const qc = useQueryClient()

  const [widthTenths, setWidthTenths] = useState(10) // knob: half-band in tenths of a percent
  const [stakeIdx, setStakeIdx] = useState(2)
  const [assetIdx, setAssetIdx] = useState(0)
  const [durIdx, setDurIdx] = useState(1)
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
  const durations = markets[0]?.durations ?? FALLBACK_DURATIONS
  const noLiveMarket = !marketsQ.isLoading && !marketsQ.isError && liveAssets.length === 0

  const assets = liveAssets.length ? liveAssets : FALLBACK_ASSETS
  const asset = play?.params.asset ?? assets[Math.min(assetIdx, assets.length - 1)]
  const duration = durations[Math.min(durIdx, durations.length - 1)] ?? FALLBACK_DURATIONS[1]
  const stake = STAKE_LADDER[stakeIdx]

  const halfPct = widthTenths / 10
  const canPlay = liveAssets.length > 0

  const liveMult = live?.multiplier ?? play?.multiplier
  const mult = phase === 'idle' ? estimateMultiplier(halfPct, duration) : (liveMult ?? estimateMultiplier(halfPct, duration))

  // Band overlay: a live ±halfPct zone while idle (the chart centers it on the smoothed price),
  // locked to the play's strike bounds once open. The chart animates the lock from a right-side
  // zone to full width.
  const band: BandOverlay | undefined =
    play && play.market.lower && play.market.upper
      ? { lower: parseFloat(play.market.lower), upper: parseFloat(play.market.upper), locked: true }
      : spot != null
        ? { pct: halfPct }
        : undefined
  const showBand = phase !== 'result' || play != null

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
      () => {},
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
      const { play: p } = await placePlay('range', { stake, asset, widthPct: halfPct * 2, duration })
      setPlay(p)
      setLive({ markValue: p.markValue, pnl: p.pnl, multiplier: p.multiplier, status: p.status })
      setPhase('open')
      haptic('heavy')
    } catch (e) {
      toastError(e)
      setPhase('idle')
    }
  }, [phase, canPlay, stake, asset, halfPct, duration])

  const doCashOut = useCallback(async () => {
    if (phase !== 'open' || !play) return
    setPhase('cashing')
    haptic('rigid')
    try {
      const { play: p, unlocked } = await cashOut(play.id)
      finishResult(p, unlocked)
    } catch (e) {
      try {
        const { play: final } = await api.getPlay(play.id)
        if (TERMINAL.has(final.status)) {
          finishResult(final, [])
          return
        }
      } catch {
        // fall through
      }
      toastError(e)
      setPhase('open')
    }
  }, [phase, play, finishResult])

  // Round timer: the chosen duration is the round length, realized as an auto-cash at the live
  // mark when it elapses (the on-chain oracle lives ~5 min; the round is the UX timer, see
  // 05-SUI-PREDICT). An early Main cash-out still wins, whichever comes first.
  useEffect(() => {
    if (phase !== 'open' || !play) {
      setSecsLeft(null)
      return
    }
    const lenMs = (play.params.duration || duration) * 1000
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

  const cycleAsset = useCallback(() => {
    haptic('selection')
    if (assets.length) setAssetIdx((i) => (i + 1) % assets.length)
  }, [assets.length])
  const cycleDuration = useCallback(() => {
    haptic('selection')
    setDurIdx((i) => (i + 1) % durations.length)
  }, [durations.length])

  const isOpen = phase === 'open'
  useConsoleControls({
    knob: {
      label: 'RANGE',
      min: 1,
      max: 30,
      step: 1,
      value: widthTenths,
      onChange: setWidthTenths,
      format: (v) => `±${(v / 10).toFixed(1)}%`,
      disabled: phase !== 'idle' && phase !== 'result',
    },
    numberWheel: {
      label: 'USDC',
      min: 0,
      max: STAKE_LADDER.length - 1,
      step: 1,
      value: stakeIdx,
      onChange: setStakeIdx,
      format: (v) => String(STAKE_LADDER[v]),
      disabled: phase !== 'idle' && phase !== 'result',
    },
    action1: { label: durationLabel(duration), color: 'neutral', onPress: cycleDuration, disabled: isOpen || phase === 'cashing' },
    action2: { label: asset ?? '·', color: 'neutral', onPress: cycleAsset, disabled: isOpen || phase === 'cashing' },
    main: isOpen
      ? { label: 'CASH OUT', color: 'up', onPress: () => void doCashOut() }
      : phase === 'cashing'
        ? { label: 'CASH OUT', color: 'up', onPress: () => {}, loading: true, disabled: true }
        : {
            label: 'PLAY',
            color: 'amber',
            onPress: () => void doPlay(),
            loading: phase === 'placing',
            disabled: !canPlay || phase === 'placing',
          },
  })

  const pnlNum = live ? parseFloat(live.pnl) : 0
  const showReadouts = play != null && (phase === 'open' || phase === 'cashing' || phase === 'result')

  // The device screen is the L-shaped aperture (web/CLAUDE.md "The console screen"): a top bar, the
  // chart filling the slack height, then a notch-safe readout band the chart stops above. The
  // bottom-right is the body (main button + knob), so the band is left-only and padded off the rim.
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-black text-text">
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
          {/* top bar + chart: the chart fills the slack height, the top bar floats over its top.
              The chart stops above the readout band below, it never runs under it. */}
          <div className="relative min-h-0 flex-1">
            {asset ? (
              <Chart
                asset={asset}
                overlays={showBand && band ? { band } : undefined}
                onPrice={(p) => setSpot(p)}
                className="absolute inset-0"
              />
            ) : null}

            {/* top bar — full width. Left: market + live price. Right: balance at rest, the expiry
                countdown once a play is open. Padded clear of the rim. */}
            <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-4">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Range · {asset}</div>
                <div className="tnum text-2xl font-extrabold leading-none text-text">
                  {spot != null
                    ? `$${spot.toLocaleString('en-US', { maximumFractionDigits: spot >= 1000 ? 0 : 2 })}`
                    : '—'}
                </div>
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
          </div>

          {/* readout band — notch-safe (bottom-right is the body: knob + PLAY). A hero number over a
              clean two-up grid: the prize multiple + stake at rest, the live PnL once a play runs. */}
          <div className="pointer-events-none max-w-[62%] space-y-2.5 p-4">
            {showReadouts ? (
              <>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Live PnL</div>
                  <div className={cnm('text-4xl font-extrabold leading-none', pnlNum >= 0 ? 'text-up' : 'text-down')}>
                    {pnlNum >= 0 ? '+' : '-'}$<Stat value={Math.abs(pnlNum)} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-x-4">
                  <Cell label="Mult" value={`${mult.toFixed(2)}x`} />
                  <Cell label="Ends" value={secsLeft != null ? `${secsLeft}s` : '—'} />
                </div>
              </>
            ) : (
              <>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Pays</div>
                  <div className="tnum text-4xl font-extrabold leading-none text-brand-500">{mult.toFixed(2)}x</div>
                </div>
                <div className="grid grid-cols-2 gap-x-4">
                  <Cell label="Stake" value={`$${stake}`} />
                  <Cell label="Band" value={`±${halfPct.toFixed(1)}%`} />
                </div>
              </>
            )}
          </div>
        </>
      )}

      {phase === 'result' && play && <ResultOverlay {...rangeResult(play)} onDismiss={() => setPhase('idle')} />}
    </div>
  )
}

// Range result copy (07-DESIGN-SYSTEM.md).
function rangeResult(play: PlayDTO): { title: string; tone: 'up' | 'down'; digest?: string } {
  const payout = parseFloat(play.payout ?? '0')
  const pnl = parseFloat(play.pnl ?? '0')
  const digest = play.txRedeem ?? play.txMint
  if (play.status === 'won') return { title: `In the zone. +$${money(payout)}`, tone: 'up', digest }
  if (play.status === 'cashed_out') return { title: `Cashed out +$${money(Math.max(pnl, 0))}`, tone: pnl >= 0 ? 'up' : 'down', digest }
  return { title: 'Out of range.', tone: 'down', digest }
}
