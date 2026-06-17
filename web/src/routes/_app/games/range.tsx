import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useConsoleControls } from '@/components/console/controls'
import { Chart } from '@/components/game/Chart'
import { ResultOverlay, ScreenMessage } from '@/components/game/screen'
import { Stat } from '@/components/Stat'
import { haptic } from '@/lib/haptics'
import { api, streamPlay, type PlayDTO, type PlayStatus } from '@/lib/api'
import { placePlay, cashOut } from '@/lib/sui/predict'
import { toastError } from '@/lib/errors'
import { useAuth } from '@/lib/auth'
import { cnm } from '@/utils/style'

// Range: rotate the knob to size a band around spot. Tighter band, lower odds, bigger multiple.
// A real mint_range under the hood; win if the settle price lands inside, cash out early at the
// live mark. The pre-play multiplier is a client estimate; the real one comes back on the mint.
export const Route = createFileRoute('/_app/games/range')({ component: RangeScreen })

const RANGE_STAKE = 10 // the knob is the band, so the bet is fixed here
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
  const { refresh } = useAuth()

  const [widthTenths, setWidthTenths] = useState(10) // knob: half-band in tenths of a percent
  const [assetIdx, setAssetIdx] = useState(0)
  const [durIdx, setDurIdx] = useState(1)
  const [phase, setPhase] = useState<Phase>('idle')
  const [play, setPlay] = useState<PlayDTO | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [spot, setSpot] = useState<number | null>(null)
  const [nowMs, setNowMs] = useState(0)

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

  const halfPct = widthTenths / 10
  const canPlay = liveAssets.length > 0

  const liveMult = live?.multiplier ?? play?.multiplier
  const mult = phase === 'idle' ? estimateMultiplier(halfPct, duration) : (liveMult ?? estimateMultiplier(halfPct, duration))

  // Band overlay: live (knob + current spot) while idle, locked to the play once open.
  const band =
    play && play.market.lower && play.market.upper
      ? { lower: parseFloat(play.market.lower), upper: parseFloat(play.market.upper) }
      : spot != null
        ? { lower: spot * (1 - halfPct / 100), upper: spot * (1 + halfPct / 100) }
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
      if (unlocked.length) toast.success(unlocked.length > 1 ? `${unlocked.length} achievements unlocked` : 'Achievement unlocked')
      void refresh()
      clearResetTimer()
      resetTimer.current = setTimeout(() => setPhase('idle'), RESULT_MS)
    },
    [refresh],
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

  // Expiry countdown ticker while open.
  useEffect(() => {
    if (phase !== 'open') return
    const iv = setInterval(() => setNowMs(Date.now()), 500)
    setNowMs(Date.now())
    return () => clearInterval(iv)
  }, [phase])

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
      const { play: p } = await placePlay('range', { stake: RANGE_STAKE, asset, widthPct: halfPct * 2, duration })
      setPlay(p)
      setLive({ markValue: p.markValue, pnl: p.pnl, multiplier: p.multiplier, status: p.status })
      setPhase('open')
      haptic('heavy')
    } catch (e) {
      toastError(e)
      setPhase('idle')
    }
  }, [phase, canPlay, asset, halfPct, duration])

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
    action1: { label: durationLabel(duration), color: 'neutral', onPress: cycleDuration, disabled: isOpen || phase === 'cashing' },
    action2: { label: asset ?? '—', color: 'neutral', onPress: cycleAsset, disabled: isOpen || phase === 'cashing' },
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
  const secsLeft = play && phase === 'open' ? Math.max(0, Math.ceil((play.market.expiry - nowMs) / 1000)) : null

  return (
    <div className="relative flex h-full flex-col gap-3 p-4">
      <div className="flex items-baseline justify-between px-1 pt-1">
        <h1 className="text-xl font-extrabold tracking-tight">Range</h1>
        <div className="tnum text-sm font-bold text-brand-500">{mult.toFixed(2)}x</div>
      </div>

      <div className="screen relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-card">
        {marketsQ.isLoading ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="shimmer h-24 w-full rounded-2xl" />
          </div>
        ) : marketsQ.isError ? (
          <ScreenMessage title="Could not load markets" action="Retry" onAction={() => void marketsQ.refetch()} />
        ) : noLiveMarket ? (
          <ScreenMessage title="No live markets right now." action="Retry" onAction={() => void marketsQ.refetch()} />
        ) : (
          <>
            {asset ? (
              <Chart
                asset={asset}
                overlays={showBand && band ? { band } : undefined}
                onPrice={(p) => setSpot(p)}
                className="flex-1"
              />
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
                {secsLeft != null && (
                  <div className="text-right">
                    <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-text-3">Ends in</div>
                    <div className="tnum text-lg font-bold text-text-2">{secsLeft}s</div>
                  </div>
                )}
              </div>
            ) : (
              <div className="px-4 pb-4 text-center text-sm text-text-3">Tighter range, bigger prize. Win if the price lands inside.</div>
            )}
          </>
        )}

        {phase === 'result' && play && <ResultOverlay {...rangeResult(play)} onDismiss={() => setPhase('idle')} />}
      </div>
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
