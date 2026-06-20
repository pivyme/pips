import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useConsoleControls } from '@/components/console/controls'
import { Chart, type BandOverlay } from '@/components/game/Chart'
import { Cell, GameScreen, ScreenMessage } from '@/components/game/screen'
import { GameLeaderboardOverlay } from '@/components/game/GameLeaderboardOverlay'
import { Stat } from '@/components/Stat'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { haptic } from '@/lib/haptics'
import {
  startRangeBgm,
  stopRangeBgm,
  rangeLock,
  rangeCross,
  rangeBuzzer,
  rangeWin,
  rangeLose,
} from '@/lib/sound'
import { api, streamPlay, type PlayDTO, type PlayStatus } from '@/lib/api'
import { placePlay, cashOut } from '@/lib/sui/predict'
import { explorerTxUrl } from '@/lib/sui/config'
import { toastError } from '@/lib/errors'
import { useAuth } from '@/lib/auth'
import { cnm } from '@/utils/style'
import { formatStringToNumericDecimals } from '@/utils/format'

// RANGE. Size a band around the live price with the knob (tighter = higher multiple), hit PLAY to lock
// it, then hold to the buzzer: a real mint_range that settles IN THE ZONE (spread-free $1·qty) or OUT
// OF RANGE (0) at the routed oracle's expiry, or CASH OUT early at the live mark. Every round is a real
// Predict position; demo mode runs the same flow on the in-memory model. The screen is the L-aperture
// (web/CLAUDE.md): a top bar over the chart, a notch-safe readout below. Teenage Engineering language
// throughout (docs/SCREEN.md): flat black, mono labels, one amber accent, green/red for facts.
export const Route = createFileRoute('/_app/games/range')({
  component: RangeScreen,
})

// Stake ladder, scrubbed on the number wheel and clamped to the live balance (within MIN/MAX_STAKE).
const STAKE_LADDER = [1, 5, 10, 25, 50, 100] as const
const FALLBACK_ASSETS = ['BTC', 'ETH', 'SUI', 'SOL', 'DEEP']
const TOKEN_LOGOS: Record<string, string> = {
  BTC: '/assets/images/coins/btc-logo.png',
  ETH: '/assets/images/coins/eth-logo.png',
  SUI: '/assets/images/coins/sui-logo.png',
}
const NOMINAL_ROUND_SEC = 30 // the idle multiplier preview's reference; the real round = oracle expiry
const RESULT_MS = 4200
const TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out', 'error'])
// Terminal states that resolve to a win/loss RESULT screen. 'error' is excluded: an errored play is
// a background mint that could not open (chips safe), handled as a clean re-rack, not a result.
const RESULT_TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out'])

type Phase = 'idle' | 'placing' | 'open' | 'cashing' | 'result'
type Live = {
  markValue: string
  pnl: string
  multiplier: number
  status: PlayStatus
}
type Overlay = 'none' | 'howto' | 'board'

// Compact price for the band recap: 67,210 -> 67.2k, 3.94 -> 3.94.
const compact = (n: number): string =>
  n >= 1000
    ? `${(n / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k`
    : n.toLocaleString('en-US', { maximumFractionDigits: n >= 1 ? 2 : 4 })

// Two-decimal money for the readout cells (payout, stake).
const money = (n: number): string =>
  n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

// Live price for the header, fewer decimals as the magnitude grows.
const priceLabel = (p: number): string =>
  `$${p.toLocaleString('en-US', { maximumFractionDigits: p >= 1000 ? 0 : p >= 1 ? 2 : 4 })}`

// Rough, monotonic estimate so the readout responds as the knob turns. Real value lands on mint.
function estimateMultiplier(halfPct: number, durationSec: number): number {
  const sigma = 0.6 * Math.sqrt(durationSec / 30) // ~1-sigma % move, scales with sqrt(T)
  const ratio = halfPct / sigma
  const prob = 1 - Math.exp(-ratio)
  return Math.max(1.05, Math.min(0.97 / Math.max(prob, 0.03), 99))
}

export function RangeScreen() {
  const { refresh, user } = useAuth()
  const qc = useQueryClient()

  const [widthTenths, setWidthTenths] = useState(10) // knob: half-band in tenths of a percent
  const [stakeIdx, setStakeIdx] = useState(2)
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null) // the player's pick, by symbol
  const [phase, setPhase] = useState<Phase>('idle')
  const [play, setPlay] = useState<PlayDTO | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [spot, setSpot] = useState<number | null>(null)
  const [secsLeft, setSecsLeft] = useState<number | null>(null)
  const [overlay, setOverlay] = useState<Overlay>('none')

  const finalized = useRef(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wasInside = useRef<boolean | null>(null) // last in/out band state, for the crossing tick
  // The chart's eased leading price (the active dot), written every frame by the Chart. The live P/L
  // reads it to track the line at 60fps instead of the laggy ~2s backend mark.
  const livePriceRef = useRef(0)

  const marketsQ = useQuery({
    queryKey: ['markets'],
    queryFn: () => api.markets(),
    refetchInterval: 10_000,
  })
  const statsQ = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() })
  const markets = marketsQ.data?.markets ?? []
  const liveAssets = markets.filter((m) => m.live).map((m) => m.asset)
  const noLiveMarket =
    !marketsQ.isLoading && !marketsQ.isError && liveAssets.length === 0
  const streak = statsQ.data?.stats.currentStreak ?? 0

  const assets = liveAssets.length ? liveAssets : FALLBACK_ASSETS
  // Hold the pick by symbol, not by index: the live market list reorders as oracles roll, so an
  // index would silently point at a different token every few seconds. Falls back to the first
  // asset until the player chooses, and if their pick ever drops offline.
  const activeAsset =
    selectedAsset && assets.includes(selectedAsset) ? selectedAsset : assets[0]
  const asset = play?.params.asset ?? activeAsset

  // BET clamps to what the balance affords, so the wheel never offers an unplayable bet.
  const balance = parseFloat(user?.balance ?? '0') || 0
  const maxBetIdx = Math.max(
    0,
    STAKE_LADDER.reduce((acc, v, i) => (v <= balance ? i : acc), 0),
  )
  const safeBetIdx = Math.min(stakeIdx, maxBetIdx)
  const stake = STAKE_LADDER[safeBetIdx]

  const halfPct = widthTenths / 10
  const canPlay = liveAssets.length > 0

  const liveMult = live?.multiplier ?? play?.multiplier
  const mult = liveMult ?? estimateMultiplier(halfPct, NOMINAL_ROUND_SEC)
  const idleMult = estimateMultiplier(halfPct, NOMINAL_ROUND_SEC)

  // Band overlay: a live ±halfPct preview while idle (the chart centers it on the smoothed price),
  // locked to the play's strike bounds once open. The chart animates the lock from a right-side zone
  // to full width, labels the edges, and tints by whether the live price sits inside.
  const lower = play?.market.lower ? parseFloat(play.market.lower) : null
  const upper = play?.market.upper ? parseFloat(play.market.upper) : null
  const band: BandOverlay | undefined =
    play && lower != null && upper != null
      ? { lower, upper, locked: true }
      : spot != null
        ? { pct: halfPct }
        : undefined
  const showBand = phase !== 'result' || play != null

  // Round-start + settle dots on the line (band center = the entry level). The now-dot rides from the
  // start dot toward the settle dot, which lands at the buzzer. Same window the countdown uses.
  const openedAtMs = play?.openedAt ? Date.parse(play.openedAt) : 0
  const settleMs = openedAtMs ? openedAtMs + (play?.params.duration || NOMINAL_ROUND_SEC) * 1000 : 0
  const markers =
    play && lower != null && upper != null && openedAtMs
      ? [
          { t: openedAtMs, p: (lower + upper) / 2 },
          { t: settleMs, p: (lower + upper) / 2 },
        ]
      : undefined

  // Is the live price inside the locked band right now? Drives the open-state IN ZONE / OUT pill and
  // the tactile crossing tick. (lower, upper] matches the on-chain settlement rule.
  const inZone =
    lower != null && upper != null && spot != null
      ? spot > lower && spot <= upper
      : null

  const clearResetTimer = () => {
    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = null
  }

  const finishResult = useCallback(
    (final: PlayDTO) => {
      finalized.current = true
      wasInside.current = null
      setPlay(final)
      setLive({
        markValue: final.markValue,
        pnl: final.pnl,
        multiplier: final.multiplier,
        status: final.status,
      })
      setPhase('result')
      stopRangeBgm() // cut the tension bed the instant it resolves, so the sting lands clean
      haptic(final.status === 'lost' ? 'error' : 'success')
      if (final.status === 'lost') rangeLose()
      else rangeWin()
      void refresh()
      // Settle/cashout moved the record: freshen stats (streak), achievements, and history.
      for (const key of ['stats', 'achievements', 'plays'])
        void qc.invalidateQueries({ queryKey: [key] })
      clearResetTimer()
      resetTimer.current = setTimeout(() => setPhase('idle'), RESULT_MS)
    },
    [refresh, qc],
  )

  // Live value while a play is open. The play comes back 'pending' the instant it's placed; the real
  // mint_range lands a moment later and the stream flips it to 'open'. The stream closes on a terminal
  // frame (the settle worker drives the oracle to settlement and redeems an in-the-money position); we
  // then refetch the finalized play to grab the payout + redeem digest. A 'pending' that flips to
  // 'error' means the background mint could not open it (rare): chips are safe, so we re-rack cleanly.
  useEffect(() => {
    if (!play || phase !== 'open') return
    const unsub = streamPlay(
      play.id,
      (tick) => {
        setLive({
          markValue: tick.markValue,
          pnl: tick.pnl,
          multiplier: tick.multiplier,
          status: tick.status,
        })
        if (tick.status === 'error' && !finalized.current) {
          finalized.current = true
          toast.error('Could not open that play. Your chips are safe, play again.', {
            id: 'range-play-error',
          })
          clearResetTimer()
          setPlay(null)
          setLive(null)
          setPhase('idle')
          return
        }
        if (RESULT_TERMINAL.has(tick.status) && !finalized.current) {
          finalized.current = true
          void api
            .getPlay(play.id)
            .then(({ play: final }) => finishResult(final))
            .catch(() => setPhase('idle'))
        }
      },
      () => {
        // SSE dropped: keep the last good readout, EventSource retries on its own.
      },
    )
    return unsub
  }, [play, phase, finishResult])

  useEffect(() => () => clearResetTimer(), [])

  // The cinematic tension bed rides the open hold only: it fades in when a position opens and out the
  // moment the phase leaves 'open' (cash out, settle, re-rack, or navigating away).
  useEffect(() => {
    if (phase !== 'open') return
    startRangeBgm()
    return () => stopRangeBgm()
  }, [phase])

  const doPlay = useCallback(async () => {
    if (phase !== 'idle' && phase !== 'result') return
    if (!canPlay) {
      toast.error('No live market right now. Try again in a sec.', { id: 'no-market' })
      return
    }
    clearResetTimer()
    finalized.current = false
    wasInside.current = null
    setOverlay('none')
    setPhase('placing')
    haptic('rigid')
    try {
      const { play: p } = await placePlay('range', {
        stake,
        asset,
        widthPct: halfPct * 2,
      })
      setPlay(p)
      setLive({
        markValue: p.markValue,
        pnl: p.pnl,
        multiplier: p.multiplier,
        status: p.status,
      })
      setPhase('open')
      haptic('heavy')
      rangeLock() // the band locks: a deep, committing confirm
    } catch (e) {
      toastError(e)
      setPhase('idle')
    }
  }, [phase, canPlay, stake, asset, halfPct])

  const doCashOut = useCallback(async () => {
    if (phase !== 'open' || !play) return
    setPhase('cashing')
    haptic('rigid')
    try {
      const { play: p } = await cashOut(play.id)
      finishResult(p)
    } catch (e) {
      // The buzzer settle may have beaten the cash-out. Reconcile against the chain before complaining.
      try {
        const { play: final } = await api.getPlay(play.id)
        if (TERMINAL.has(final.status)) {
          finishResult(final)
          return
        }
      } catch {
        // fall through to the error toast
      }
      toastError(e)
      setPhase('open')
    }
  }, [phase, play, finishResult])

  // Round countdown to the routed oracle's real expiry. At the buzzer we HOLD (the readout shows
  // SETTLING) and let the settle worker drive the win/lose; the stream effect above catches the
  // terminal frame. An early Main cash-out exits sooner. No auto-cash here.
  useEffect(() => {
    if (phase !== 'open' || !play) {
      setSecsLeft(null)
      return
    }
    const lenMs = (play.params.duration || NOMINAL_ROUND_SEC) * 1000
    const endAt =
      (play.openedAt ? Date.parse(play.openedAt) : Date.now()) + lenMs
    const tick = () =>
      setSecsLeft(Math.max(0, Math.ceil((endAt - Date.now()) / 1000)))
    tick()
    const iv = setInterval(tick, 250)
    return () => clearInterval(iv)
  }, [phase, play])

  // A tactile tick whenever the live price crosses into or out of your band (open only), so the
  // tension is felt, not just seen.
  useEffect(() => {
    if (phase !== 'open' || inZone == null) return
    if (wasInside.current != null && wasInside.current !== inZone) {
      haptic('selection')
      rangeCross(inZone)
    }
    wasInside.current = inZone
  }, [inZone, phase])

  const cycleAsset = useCallback(() => {
    haptic('selection')
    if (!assets.length) return
    const i = assets.indexOf(activeAsset)
    setSelectedAsset(assets[(i + 1) % assets.length])
  }, [assets, activeAsset])
  const toggleHowto = useCallback(() => {
    haptic('selection')
    setOverlay((o) => (o === 'howto' ? 'none' : 'howto'))
  }, [])

  // The mint lands a beat after PLAY, so CASH OUT only arms once the play is confirmed 'open'
  // on-chain; until then the button reads OPENING (cashing a not-yet-minted play would revert).
  const confirmed = live?.status === 'open'
  const isOpen = phase === 'open' && confirmed
  const isOpening = phase === 'open' && !confirmed
  useConsoleControls({
    knob: {
      label: 'RANGE',
      min: 1,
      max: 30,
      step: 1,
      value: widthTenths,
      onChange: setWidthTenths,
      format: (v) => `±${(v / 10).toFixed(1)}%`,
    },
    numberWheel: {
      label: 'USDC',
      min: 0,
      max: maxBetIdx,
      step: 1,
      value: safeBetIdx,
      onChange: setStakeIdx,
      format: (v) => `$${STAKE_LADDER[Math.min(v, maxBetIdx)]}`,
    },
    action1: { label: 'HOW TO', color: 'neutral', onPress: toggleHowto },
    action2: {
      label: asset,
      color: 'neutral',
      onPress: cycleAsset,
      display: {
        mode: 'token',
        ticker: asset,
        logoSrc: TOKEN_LOGOS[asset],
      },
    },
    main: isOpen
      ? { label: 'CASH OUT', color: 'up', onPress: () => void doCashOut() }
      : isOpening
        ? { label: 'OPENING', color: 'up', onPress: () => {}, loading: true }
        : phase === 'cashing'
          ? { label: 'CASH OUT', color: 'up', onPress: () => {}, loading: true }
          : {
              label: 'PLAY',
              color: 'amber',
              onPress: () => void doPlay(),
              loading: phase === 'placing',
            },
  })

  const pnlNum = live ? parseFloat(live.pnl) : 0
  const showReadouts =
    play != null &&
    (phase === 'open' || phase === 'cashing' || phase === 'result')
  // The mint is still landing (reels of this game: the band locked, the position not open on-chain yet).
  const opening = phase === 'open' && live?.status === 'pending'
  const settling = phase === 'open' && secsLeft != null && secsLeft <= 0
  const showZonePill = phase === 'open' && inZone != null && !settling
  const firstRun =
    !statsQ.isLoading && (statsQ.data?.stats.gamesPlayed ?? 0) === 0
  const playStake = play ? parseFloat(play.stake) : stake
  // The locked play, read back under OPENING / SETTLING so the round always shows what's in flight.
  const recap =
    lower != null && upper != null
      ? `${asset} · ${compact(lower)}–${compact(upper)} · $${playStake}`
      : `${asset} · ±${halfPct.toFixed(1)}% · $${playStake}`

  // A one-shot riser at the buzzer, the last seconds before the oracle settles, to spike the tension.
  useEffect(() => {
    if (settling) rangeBuzzer()
  }, [settling])

  // Layout mirrors Lucky (the house language): a solid header band (price · balance) divides off the
  // chart with a foot hairline, the chart bleeds full width but stays bounded between header and
  // footer, and the readout hangs off the bottom-left as a flat black band tall enough to span the
  // device's occluded bottom-right (the knob + PLAY body). Rim/notch insets come from ConsoleCanvas.
  return (
    <GameScreen>
      {marketsQ.isLoading ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="shimmer h-24 w-2/3" />
        </div>
      ) : marketsQ.isError ? (
        <ScreenMessage
          title="Could not load markets"
          action="Retry"
          onAction={() => void marketsQ.refetch()}
        />
      ) : noLiveMarket ? (
        <ScreenMessage
          title="No live markets right now."
          action="Retry"
          onAction={() => void marketsQ.refetch()}
        />
      ) : (
        <div className="relative flex h-full flex-col">
          {/* HEADER — solid band: market + live price (left), balance / expiry countdown (right). A
              foot hairline divides it off the chart so the live line never runs under the text. */}
          <div className="shrink-0 border-b border-line-strong bg-black pt-[calc(var(--screen-rim,24px)+12px)]">
            <div className="flex items-start justify-between gap-3 px-[var(--screen-rim,24px)] pb-4">
              <div className="min-w-0">
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-text-3">
                  Range · {asset}
                </div>
                <div className="tnum text-[34px] font-extrabold leading-none text-text">
                  {spot != null ? priceLabel(spot) : '—'}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                  {showReadouts && secsLeft != null ? 'Ends in' : 'Balance'}
                </div>
                <div className="tnum text-xl font-bold leading-none text-text-2">
                  {showReadouts && secsLeft != null
                    ? `${secsLeft}s`
                    : user?.balance != null
                      ? `$${formatStringToNumericDecimals(user.balance, 2)}`
                      : '—'}
                </div>
                {streak > 0 && (
                  <div className="mt-1 inline-flex items-center border border-brand-500/60 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-brand-500">
                    Streak {streak}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* CHART — bounded between the header and the footer, so the band + line never run under
              either. The band overlay rides inside it (live ±pct preview, then locked bounds). */}
          <div className="relative min-h-0 flex-1">
            {asset ? (
              <Chart
                asset={asset}
                overlays={showBand && band ? { band, markers } : undefined}
                livePriceRef={livePriceRef}
                onPrice={(p) => setSpot(p)}
                className="absolute inset-0"
              />
            ) : null}
          </div>

          {/* FOOTER — full-width readout band, one top hairline, tall enough to span the device's
              occluded bottom-right (the knob + PLAY body). Content hugs the left, clear of that body:
              the prize multiple + stake at rest, the live PnL (with an IN ZONE / OUT tag) once a play
              runs, OPENING while the mint lands, SETTLING at the buzzer. */}
          <div className="shrink-0 border-t border-line-strong bg-black px-[var(--screen-rim,24px)] pb-[var(--screen-rim,24px)] pt-3.5 min-h-[var(--screen-notch,21%)]">
            <div className="max-w-[60%]">
              {opening ? (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                    Opening
                  </div>
                  <div className="text-[30px] font-extrabold leading-none text-brand-500">
                    OPENING
                  </div>
                  <div className="mt-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-text-2">
                    {recap}
                  </div>
                  <div className="mt-3 h-1 w-[200px] max-w-full overflow-hidden bg-line-strong">
                    <div className="bar-sweep h-full w-1/3 bg-brand-500" />
                  </div>
                </>
              ) : settling ? (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                    Settling
                  </div>
                  <div className="text-[30px] font-extrabold leading-none text-brand-500">
                    SETTLING
                  </div>
                  <div className="mt-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-text-2">
                    {recap}
                  </div>
                  <div className="mt-3 h-1 w-[200px] max-w-full overflow-hidden bg-line-strong">
                    <div className="bar-sweep h-full w-1/3 bg-brand-500" />
                  </div>
                </>
              ) : showReadouts ? (
                <>
                  <div className="flex items-center gap-2">
                    <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                      Live PnL
                    </div>
                    {showZonePill && (
                      <span
                        className={cnm(
                          'inline-flex items-center border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.1em]',
                          inZone
                            ? 'border-brand-500/60 text-brand-500'
                            : 'border-down/60 text-down',
                        )}
                      >
                        {inZone ? 'In zone' : 'Out'}
                      </span>
                    )}
                  </div>
                  <RangePnl
                    livePriceRef={livePriceRef}
                    lower={lower ?? 0}
                    upper={upper ?? 0}
                    stake={playStake}
                    mult={mult}
                    status={live?.status ?? 'open'}
                    finalPnl={pnlNum}
                  />
                  <div className="mt-2.5 grid grid-cols-3 gap-x-3">
                    <Cell label="Mult" value={`${mult.toFixed(2)}x`} />
                    <Cell label="Stake" value={`$${playStake}`} />
                    <Cell label="Win" value={`$${money(playStake * mult)}`} />
                  </div>
                </>
              ) : firstRun ? (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                    Welcome
                  </div>
                  <div className="tnum text-[40px] font-extrabold leading-none text-brand-500">
                    ${formatStringToNumericDecimals(user?.balance ?? '0', 0)}
                  </div>
                  <div className="mt-2.5 font-mono text-[11px] font-semibold uppercase leading-snug tracking-[0.08em] text-text-2">
                    In play chips · size a band, hit{' '}
                    <span className="text-brand-500">PLAY</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                    Pays
                  </div>
                  <div className="tnum text-[40px] font-extrabold leading-none text-brand-500">
                    {idleMult.toFixed(2)}x
                  </div>
                  <div className="mt-2.5 grid grid-cols-2 gap-x-3">
                    <Cell label="Stake" value={`$${stake}`} />
                    <Cell label="Band" value={`±${halfPct.toFixed(1)}%`} />
                  </div>
                  <div className="mt-2.5 font-mono text-[11px] font-semibold uppercase leading-snug tracking-[0.08em] text-text-2">
                    Tighter range, bigger prize
                  </div>
                  <button
                    type="button"
                    onClick={() => { haptic('selection'); setOverlay('board') }}
                    className="mt-3 inline-flex items-center gap-1 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-text-2 transition-colors active:text-brand-500"
                  >
                    Top 10 <span className="text-brand-500">›</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {phase === 'result' && play && (
        <RangeResult play={play} onDismiss={() => setPhase('idle')} />
      )}
      {overlay === 'howto' && <HowTo onClose={() => setOverlay('none')} />}
      {overlay === 'board' && <GameLeaderboardOverlay game="range" title="Range" onClose={() => setOverlay('none')} />}
    </GameScreen>
  )
}

// The live P/L while a band is open. Range settles binary: inside the band at the buzzer wins
// stake x mult (spread-free), outside loses the stake. So the live number is just that outcome
// projected onto where the chart's active dot sits right now: inside the band -> the win profit,
// outside -> -stake. It rides the 60fps dot (livePriceRef) so it flips the instant the line crosses
// an edge, and Stat rolls it between the two. On a terminal status it shows the real settled P/L.
function RangePnl({
  livePriceRef,
  lower,
  upper,
  stake,
  mult,
  status,
  finalPnl,
}: {
  livePriceRef: { current: number }
  lower: number
  upper: number
  stake: number
  mult: number
  status: PlayStatus
  finalPnl: number
}) {
  const terminal = RESULT_TERMINAL.has(status)
  const valid = lower > 0 && upper > lower && stake > 0
  const profit = Math.max(0, stake * (mult - 1)) // walk-away profit if it lands in the zone
  const [inside, setInside] = useState(true)
  const insideRef = useRef(true)

  useEffect(() => {
    if (terminal || !valid) return
    let raf = 0
    const loop = () => {
      const p = livePriceRef.current
      if (p > 0) {
        const now = p > lower && p <= upper // (lower, upper] matches on-chain settlement
        if (now !== insideRef.current) {
          insideRef.current = now
          setInside(now)
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [terminal, valid, lower, upper, livePriceRef])

  const pnl = terminal ? finalPnl : inside ? profit : -stake
  const up = pnl >= 0
  return (
    <div className={cnm('tnum text-[40px] font-extrabold leading-none', up ? 'text-up' : 'text-down')}>
      {up ? '+' : '-'}$<Stat value={Math.abs(pnl)} />
    </div>
  )
}

// The win/loss/cash-out moment. Flat full-screen wash (docs/SCREEN.md: big, flat, momentary, no blur),
// the §10 copy, the signed amount, the band recap, and the explorer link when it is on-chain.
function RangeResult({
  play,
  onDismiss,
}: {
  play: PlayDTO
  onDismiss: () => void
}) {
  const reduced = useReducedMotion()
  const pnl = parseFloat(play.pnl ?? '0')
  const won = play.status === 'won'
  const cashed = play.status === 'cashed_out'
  const positive = won || (cashed && pnl >= 0)
  const head = won ? 'IN THE ZONE' : cashed ? 'CASHED OUT' : 'OUT OF RANGE'
  const lo = play.market.lower ? parseFloat(play.market.lower) : null
  const hi = play.market.upper ? parseFloat(play.market.upper) : null
  const digest = play.txRedeem ?? play.txMint
  const pop = reduced
    ? {}
    : {
        initial: { scale: 0.7, opacity: 0 },
        animate: { scale: 1, opacity: 1 },
        transition: { type: 'spring' as const, stiffness: 440, damping: 24 },
      }
  return (
    <button
      type="button"
      onClick={onDismiss}
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/90 text-center"
    >
      <div
        className={cnm(
          'font-mono text-[13px] font-bold uppercase tracking-[0.2em]',
          positive ? 'text-up' : 'text-down',
        )}
      >
        {head}
      </div>
      <motion.div
        {...pop}
        style={{ textShadow: '0 0 28px currentColor' }}
        className={cnm(
          'tnum text-[56px] font-extrabold leading-none',
          positive ? 'text-up' : 'text-down',
        )}
      >
        {pnl >= 0 ? '+' : '-'}$<Stat value={Math.abs(pnl)} />
      </motion.div>
      {lo != null && hi != null && (
        <div className="font-mono text-[12px] uppercase tracking-[0.12em] text-text-3">
          Band {compact(lo)} – {compact(hi)}
        </div>
      )}
      {!positive && (
        <div className="font-mono text-[12px] uppercase tracking-[0.12em] text-text-3">
          Play again
        </div>
      )}
      {digest && (
        <a
          href={explorerTxUrl(digest)}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="mt-1 font-mono text-[11px] uppercase tracking-[0.08em] text-text-3 underline underline-offset-4 transition-colors hover:text-text-2"
        >
          View on explorer
        </a>
      )}
      <span className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-text-3">
        Tap to continue
      </span>
    </button>
  )
}

// HOW TO: a flat in-screen card of the rules. Plain terminology only, no banned words.
function HowTo({ onClose }: { onClose: () => void }) {
  const lines: Array<[string, string]> = [
    ['BAND', 'Turn the knob to size your price band. Tighter pays more.'],
    ['PLAY', 'Locks the band around the live price.'],
    ['WIN', 'Land inside the band at the buzzer to win stake × multiple.'],
    ['CASH OUT', 'Take the live value any time before the buzzer.'],
  ]
  return (
    <button
      type="button"
      onClick={onClose}
      className="absolute inset-0 z-20 flex flex-col justify-center gap-4 bg-black/95 p-[var(--screen-rim,24px)] text-left"
    >
      <div className="font-mono text-[13px] font-bold uppercase tracking-[0.2em] text-brand-500">
        How to play
      </div>
      <div className="flex max-w-[80%] flex-col gap-3">
        {lines.map(([k, v]) => (
          <div key={k}>
            <div className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-text">
              {k}
            </div>
            <div className="text-[14px] leading-snug text-text-2">{v}</div>
          </div>
        ))}
      </div>
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-3">
        Tap to close
      </span>
    </button>
  )
}
