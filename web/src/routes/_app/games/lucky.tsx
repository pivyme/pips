import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useConsoleControls } from '@/components/console/controls'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { Chart } from '@/components/game/Chart'
import { Cell, GameScreen, ScreenMessage } from '@/components/game/screen'
import { Stat } from '@/components/Stat'
import { haptic } from '@/lib/haptics'
import { sound, slotSpin, slotTick, slotLock } from '@/lib/sound'
import { api, streamPlay, type LuckyParams, type PlayDTO, type PlayStatus, type Side } from '@/lib/api'
import { placePlay, cashOut } from '@/lib/sui/predict'
import { explorerTxUrl } from '@/lib/sui/config'
import { toastError } from '@/lib/errors'
import { notifyUnlocks } from '@/lib/achievements'
import { useAuth } from '@/lib/auth'
import { cnm } from '@/utils/style'
import { formatStringToNumericDecimals } from '@/utils/format'

// LUCKY, the hero. Hit SPIN: three reels (asset, direction, multiplier) snap to a server-dealt slot
// pull, the position opens on the chart with a TARGET line, then ride the live value and CASH OUT, or
// hold to the buzzer for a spread-free WIN/LOSE. Every round is a real Predict mint/redeem; demo mode
// runs the same flow on the in-memory model. The screen layout, top to bottom: a header (live price,
// balance) over a full-width slot band, a bounded chart, then a full-width readout footer (the device
// body owns the bottom-right). Teenage Engineering language throughout (docs/SCREEN.md): flat black,
// mono labels, one amber accent, green/red for facts.
export const Route = createFileRoute('/_app/games/lucky')({ component: LuckyScreen })

// BET ladder, scrubbed on the number wheel and clamped to the live USDC balance.
const BET_LADDER = [1, 5, 10, 25, 50, 100] as const
// Reel cycle pools (cosmetic blur before the snap). The real targets come from the dealt play.
const REEL_ASSETS = ['BTC', 'SUI', 'ETH']
const DIR_POOL = ['UP', 'DOWN']
const MULT_POOL = ['2x', '3x', '5x', '10x', '25x']
const SPIN_STOPS = [720, 980, 1240] // staggered reel stops (ms)
const SPIN_TOTAL = 1320
const RESULT_MS = 4200
const ROUND_SEC = 15 // fallback only; the play's real on-chain expiry drives the countdown
// Safety-net poll of the play, independent of the live SSE. The SSE carries the smooth PnL but its
// socket can silently drop (expired stream token, proxy timeout), which is what stranded the screen
// on OPENING / SETTLING forever. This guarantees the terminal frame always lands.
const WATCHDOG_MS = 3000
const SETTLE_EXPECT_MS = 12000 // the settle progress bar eases toward (never to) full over this window
const TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out', 'error'])
// Terminal states that resolve to a win/loss RESULT screen. 'error' is excluded: an errored play is
// a background mint that could not open (chips safe), handled as a clean re-rack, not a result.
const RESULT_TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out'])

type Phase = 'idle' | 'placing' | 'spinning' | 'open' | 'cashing' | 'result'
type Live = { markValue: string; pnl: string; multiplier: number; status: PlayStatus }
type Overlay = 'none' | 'howto' | 'history'

const money = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtMult = (n: number): string => `${Number.isInteger(n) ? n : Number(n.toFixed(1))}x`
const sideLabel = (s: Side): string => (s === 'up' ? 'UP' : 'DOWN')
const priceLabel = (p: number): string =>
  `$${p.toLocaleString('en-US', { maximumFractionDigits: p >= 1000 ? 0 : p >= 1 ? 2 : 4 })}`

// Live cash-out estimate model. A binary's fair value = max payout x P(finish on the winning side of
// TARGET). Standard normal CDF (Zelen & Severo); the same shape the backend prices against, so the
// smooth client number tracks the eventual settle and converges to the full win / zero at the buzzer.
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  const u = 0.39894228 * Math.exp((-x * x) / 2) * poly
  return x >= 0 ? 1 - u : u
}
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
// Fallback round vol for the estimate when the target sits at the money (a ~2x coinflip), where the
// vol can't be backed out of the strike distance. Display only: the real cash-out is the on-chain
// redeem, and the win/loss is decided purely by price vs TARGET (vol-independent).
const LIVE_VOL = 0.03

// Inverse standard normal CDF (Acklam). Used to back the implied round vol out of a strike's distance
// and odds, so the live estimate reads ~0 P/L at entry and converges to the full win / zero at the
// buzzer no matter how the target was placed (real path prices at IMPLIED_VOL, demo a touch tighter).
function invNorm(p: number): number {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.75928510446969e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const plow = 0.02425
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p <= 1 - plow) {
    const q = p - 0.5
    const r = q * q
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  }
  const q = Math.sqrt(-2 * Math.log(1 - p))
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
}

export function LuckyScreen() {
  const { refresh, user } = useAuth()
  const qc = useQueryClient()

  const [betIdx, setBetIdx] = useState(2)
  const [phase, setPhase] = useState<Phase>('idle')
  const [play, setPlay] = useState<PlayDTO | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [spot, setSpot] = useState<number | null>(null)
  const [entryPrice, setEntryPrice] = useState<number | null>(null)
  const [secsLeft, setSecsLeft] = useState<number | null>(null)
  const [settleMs, setSettleMs] = useState(0)
  const [overlay, setOverlay] = useState<Overlay>('none')

  const finalized = useRef(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Entry line marks the dealt asset's first live price. Track the latest spot and the asset it
  // belongs to (set together in onPrice) so a round on a new asset never marks entry at the old one.
  const spotRef = useRef<number | null>(null)
  const spotAssetRef = useRef<string | null>(null)
  const chartAssetRef = useRef<string>('')
  // The chart's eased leading price, written every frame by the Chart. The live P/L reads it to
  // track the line at 60fps instead of the laggy ~2.5s backend mark.
  const livePriceRef = useRef(0)

  const marketsQ = useQuery({ queryKey: ['markets'], queryFn: () => api.markets(), refetchInterval: 10_000 })
  const statsQ = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() })
  const markets = marketsQ.data?.markets ?? []
  const liveAssets = markets.filter((m) => m.live).map((m) => m.asset)
  const noLiveMarket = !marketsQ.isLoading && !marketsQ.isError && liveAssets.length === 0
  const canPlay = liveAssets.length > 0
  const streak = statsQ.data?.stats.currentStreak ?? 0

  // BET clamps to what the balance affords, so the wheel never offers an unplayable bet.
  const balance = parseFloat(user?.balance ?? '0') || 0
  const maxBetIdx = Math.max(0, BET_LADDER.reduce((acc, v, i) => (v <= balance ? i : acc), 0))
  const safeBetIdx = Math.min(betIdx, maxBetIdx)
  const bet = BET_LADDER[safeBetIdx]

  const lp = play ? (play.params as LuckyParams) : null
  const chartAsset = lp?.asset ?? liveAssets[0] ?? 'BTC'
  chartAssetRef.current = chartAsset
  // The entry line shows once a round is live (placed through to the result), marking where you got in.
  const showEntry = play != null && (phase === 'spinning' || phase === 'open' || phase === 'cashing' || phase === 'result')
  const strike = play?.market.strike ? parseFloat(play.market.strike) : undefined
  const spinning = phase === 'spinning'
  // Reels tumble from the instant SPIN is pressed through to the snap: the 'placing' wait (the
  // server deal) and the 'spinning' window. This is what makes the multi-second deal feel instant.
  const reelsCycling = phase === 'placing' || phase === 'spinning'
  const showReadouts = play != null && (phase === 'open' || phase === 'cashing' || phase === 'result')
  const multiplier = live?.multiplier ?? play?.multiplier ?? 0
  const playBet = play ? parseFloat(play.stake) : bet
  const entryCost = play ? parseFloat(play.entryValue) : bet
  // Entry reference: the spot the strike was solved against, so the ENTRY line, the TARGET line, and
  // the settlement all agree. Falls back to the chart's first captured price if entrySpot is absent.
  const entrySpotNum = play?.entrySpot ? parseFloat(play.entrySpot) : NaN
  const entryVal = Number.isFinite(entrySpotNum) && entrySpotNum > 0 ? entrySpotNum : entryPrice
  // The round window (open -> buzzer), for the time-decay in the live cash-out estimate.
  const expiryMs = play ? play.market.expiry : 0
  const openedAtMs = play?.openedAt ? Date.parse(play.openedAt) : lp ? expiryMs - lp.duration * 1000 : 0
  // Chart overlays: the ENTRY line plus the directional TARGET line + winning-zone shading.
  const overlays =
    showEntry && entryVal != null
      ? { entry: entryVal, ...(strike != null && lp ? { target: { price: strike, side: lp.side } } : {}) }
      : undefined
  // The mint is still landing: reels snapped on the dealt deal, the position is not open on-chain yet.
  const opening = phase === 'open' && live?.status === 'pending'
  // The round hit the buzzer and we are waiting on the on-chain settle (won/lost) frame.
  const settling = phase === 'open' && live?.status === 'open' && secsLeft != null && secsLeft <= 0
  const settleSecs = Math.floor(settleMs / 1000)
  // The dealt pick, shown under OPENING / SETTLING so the round always reads back what's in flight.
  const dealLine = lp ? `${lp.asset} ${sideLabel(lp.side)} · ${fmtMult(multiplier)} · Bet $${money(playBet)}` : '—'
  // First-run welcome: no plays on record yet.
  const firstRun = !statsQ.isLoading && (statsQ.data?.stats.gamesPlayed ?? 0) === 0

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
      // Settle/cashout moved the record: freshen stats (streak), achievements, and history.
      for (const key of ['stats', 'achievements', 'plays']) void qc.invalidateQueries({ queryKey: [key] })
      clearResetTimer()
      resetTimer.current = setTimeout(() => setPhase('idle'), RESULT_MS)
    },
    [refresh, qc],
  )

  // Resolve a round from a status, idempotent via `finalized` so the SSE and the watchdog below can
  // both feed it and only the first one acts. 'error' = the background mint never opened (chips safe,
  // a failed mint debits nothing), so we re-rack cleanly. A win/loss/cashout refetches the finalized
  // play for the payout + redeem digest (the result screen + explorer link).
  const resolveTerminal = useCallback(
    (status: PlayStatus, playId: string) => {
      if (finalized.current) return
      if (status === 'error') {
        finalized.current = true
        toast.error('Could not open that play. Your chips are safe, spin again.')
        clearResetTimer()
        setPlay(null)
        setLive(null)
        setPhase('idle')
        return
      }
      if (RESULT_TERMINAL.has(status)) {
        finalized.current = true
        void api
          .getPlay(playId)
          .then(({ play: final }) => finishResult(final, []))
          .catch(() => setPhase('idle'))
      }
    },
    [finishResult],
  )

  // Live PnL while a play is open. The play comes back 'pending' the instant it's dealt (the reels
  // snap right away); the real Predict mint lands a moment later and the stream flips it to 'open',
  // then to a terminal frame at the buzzer settle.
  useEffect(() => {
    if (!play || phase !== 'open') return
    const id = play.id
    return streamPlay(
      id,
      (tick) => {
        setLive({ markValue: tick.markValue, pnl: tick.pnl, multiplier: tick.multiplier, status: tick.status })
        resolveTerminal(tick.status, id)
      },
      () => {
        // SSE dropped: keep the last readout. EventSource retries, and the watchdog below still resolves.
      },
    )
  }, [play, phase, resolveTerminal])

  // Watchdog: poll the play directly on a steady cadence, independent of the SSE socket. This is what
  // makes OPENING / SETTLING deterministic, the result lands even if the stream silently died. Reads
  // are cheap (the backend caches the live mark and skips it entirely once past the buzzer).
  useEffect(() => {
    if (!play || phase !== 'open') return
    const id = play.id
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      if (stopped || finalized.current) return
      try {
        const { play: cur } = await api.getPlay(id)
        if (stopped || finalized.current) return
        setLive({ markValue: cur.markValue, pnl: cur.pnl, multiplier: cur.multiplier, status: cur.status })
        resolveTerminal(cur.status, id)
      } catch {
        // transient; the next tick retries
      }
      if (!stopped && !finalized.current) timer = setTimeout(() => void poll(), WATCHDOG_MS)
    }
    timer = setTimeout(() => void poll(), WATCHDOG_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [play, phase, resolveTerminal])

  useEffect(() => () => clearResetTimer(), [])

  // Ratchet under the spin: a quiet tick stream while the reels tumble, ended the moment they
  // settle. One stream for the whole slot (not per reel) keeps the texture subtle.
  useEffect(() => {
    if (!reelsCycling) return
    const iv = setInterval(() => slotTick(), 70)
    return () => clearInterval(iv)
  }, [reelsCycling])

  // Mark the entry line at the dealt asset's first live price. Waits until the chart has switched
  // to the round's asset (spotAssetRef matches) so it never anchors at the previous asset's price.
  useEffect(() => {
    if (entryPrice != null || !play) return
    if (spotAssetRef.current === play.market.asset && spotRef.current != null) {
      setEntryPrice(spotRef.current)
    }
  }, [spot, play, entryPrice])

  const doPlay = useCallback(async () => {
    if (phase !== 'idle' && phase !== 'result') return
    if (!canPlay) {
      toast.error('No live market right now. Try again in a sec.')
      return
    }
    clearResetTimer()
    finalized.current = false
    setOverlay('none')
    setPhase('placing')
    setEntryPrice(null) // re-marked at the dealt asset's first live price (capture effect below)
    haptic('rigid')
    slotSpin()
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
      // The buzzer may have beaten the cash-out. Reconcile against the chain before complaining.
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

  // Round countdown for the TIME readout. At the buzzer the settle worker (or the demo stream)
  // produces the terminal frame; the stream effect above catches it. No auto-cash here.
  useEffect(() => {
    if (phase !== 'open' || !play) {
      setSecsLeft(null)
      setSettleMs(0)
      return
    }
    // Count down to the real on-chain buzzer (the oracle expiry the round settles at), not
    // openedAt+duration: the mint lands a beat after the reels snap, so openedAt+duration runs PAST
    // the real expiry and left the timer showing seconds that no longer existed. At 0 it flips to SETTLING.
    const endAt = play.market.expiry || Date.now() + ROUND_SEC * 1000
    const tick = () => {
      const remaining = endAt - Date.now()
      setSecsLeft(Math.max(0, Math.ceil(remaining / 1000)))
      // Time spent past the buzzer drives the deterministic settle progress (so it never looks frozen).
      setSettleMs(remaining < 0 ? -remaining : 0)
    }
    tick()
    const iv = setInterval(tick, 250)
    return () => clearInterval(iv)
  }, [phase, play])

  const toggleHowto = useCallback(() => {
    haptic('selection')
    setOverlay((o) => (o === 'howto' ? 'none' : 'howto'))
  }, [])
  const toggleHistory = useCallback(() => {
    haptic('selection')
    setOverlay((o) => (o === 'history' ? 'none' : 'history'))
  }, [])

  // The mint lands a beat after the reels snap, so CASH OUT only arms once the play is confirmed
  // 'open' on-chain; until then the button reads OPENING (cashing a not-yet-minted play would revert).
  const confirmed = live?.status === 'open'
  const isOpen = phase === 'open' && confirmed
  const isOpening = phase === 'open' && !confirmed
  useConsoleControls({
    numberWheel: {
      label: 'BET',
      min: 0,
      max: maxBetIdx,
      step: 1,
      value: safeBetIdx,
      onChange: setBetIdx,
      format: (v) => `$${BET_LADDER[Math.min(v, maxBetIdx)]}`,
    },
    action1: { label: 'HOW TO', color: 'neutral', onPress: toggleHowto },
    action2: { label: 'HISTORY', color: 'neutral', onPress: toggleHistory },
    main: settling
      ? { label: 'SETTLING', color: 'amber', onPress: () => {}, loading: true }
      : isOpen
        ? { label: 'CASH OUT', color: 'up', onPress: () => void doCashOut() }
        : isOpening
          ? { label: 'OPENING', color: 'up', onPress: () => {}, loading: true }
          : phase === 'cashing'
            ? { label: 'CASH OUT', color: 'up', onPress: () => {}, loading: true }
            : {
                label: 'SPIN',
                color: 'amber',
                onPress: () => void doPlay(),
                loading: phase === 'placing' || phase === 'spinning',
              },
  })

  // Layout: a solid header (price/balance over the reel cluster) divides off the chart with a foot
  // hairline, so the live line never runs behind the slot. The chart then bleeds full width to the
  // very bottom, and the readout hangs off the bottom-left as a flat black panel over it.
  return (
    <GameScreen>
      {marketsQ.isLoading ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="shimmer h-24 w-2/3" />
        </div>
      ) : marketsQ.isError ? (
        <ScreenMessage title="Something slipped" action="Retry" onAction={() => void marketsQ.refetch()} />
      ) : noLiveMarket ? (
        <ScreenMessage title="Market catching up" action="Retry" onAction={() => void marketsQ.refetch()} />
      ) : (
        <div className="relative flex h-full flex-col">
          {/* HEADER — persistent context (price · balance) over the slot band. No foot hairline; the
              full-width slot runs straight into the chart to save vertical room. */}
          <div className="shrink-0 bg-black pt-[calc(var(--screen-rim,24px)+12px)]">
            <div className="flex items-start justify-between gap-3 px-[var(--screen-rim,24px)] pb-4">
              <div className="min-w-0">
                <div className="tnum text-[34px] font-extrabold leading-none text-text">{spot != null ? priceLabel(spot) : '—'}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                  {showReadouts && secsLeft != null ? 'Time' : 'Balance'}
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

            {/* The three reels: one full-width slot band, hairline-divided cells, no foot border. */}
            <div className="flex border-t border-line-strong">
              <Reel index={0} label="Asset" pool={REEL_ASSETS} target={lp?.asset} cycling={reelsCycling} landing={spinning} stopAt={SPIN_STOPS[0]} />
              <Reel
                index={1}
                label="Up Down"
                pool={DIR_POOL}
                target={lp ? sideLabel(lp.side) : undefined}
                cycling={reelsCycling}
                landing={spinning}
                stopAt={SPIN_STOPS[1]}
                accent={lp?.side === 'up' ? 'up' : lp?.side === 'down' ? 'down' : undefined}
              />
              <Reel
                index={2}
                label="Multiplier"
                pool={MULT_POOL}
                target={play ? fmtMult(play.multiplier) : undefined}
                cycling={reelsCycling}
                landing={spinning}
                stopAt={SPIN_STOPS[2]}
                accent="amber"
              />
            </div>
          </div>

          {/* CHART — its own band, bounded between the slot header and the footer so the leading
              dot never spills behind either zone (no full-bleed overflow). */}
          <div className="relative min-h-0 flex-1">
            {chartAsset ? (
              <Chart
                asset={chartAsset}
                overlays={overlays}
                livePriceRef={livePriceRef}
                onPrice={(p) => {
                  spotRef.current = p
                  spotAssetRef.current = chartAssetRef.current
                  setSpot(p)
                }}
                className="absolute inset-0"
              />
            ) : null}
          </div>

          {/* FOOTER — full-width readout bar under the chart, one top hairline. The live VALUE while
              a round runs, the bet + how-to-start at rest. Content hugs the left, clear of the PLAY
              body in the bottom-right. */}
          <div className="shrink-0 border-t border-line-strong bg-black px-[var(--screen-rim,24px)] pb-[var(--screen-rim,24px)] pt-3.5">
            {/* Fixed height: the readout swaps between bet / dealing / value, but the card must not
                jump size as the copy changes, so the tallest state sets the floor for all of them. */}
            <div className="max-w-[60%] min-h-[120px]">
              {opening ? (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Opening</div>
                  <div className="text-[30px] font-extrabold leading-none text-brand-500">OPENING</div>
                  <div className="mt-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-text-2">{dealLine}</div>
                  <div className="mt-3 h-1 w-[200px] max-w-full overflow-hidden bg-line-strong">
                    <div className="bar-sweep h-full w-1/3 bg-brand-500" />
                  </div>
                </>
              ) : settling ? (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Settling · {settleSecs}s</div>
                  <div className="text-[30px] font-extrabold leading-none text-brand-500">SETTLING</div>
                  <div className="mt-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-text-2">{dealLine}</div>
                  <div className="mt-3 h-1 w-[200px] max-w-full overflow-hidden bg-line-strong">
                    <div
                      className="h-full bg-brand-500 transition-[width] duration-300 ease-out"
                      style={{ width: `${Math.min(94, (settleMs / SETTLE_EXPECT_MS) * 100)}%` }}
                    />
                  </div>
                </>
              ) : showReadouts ? (
                <>
                  <LivePnl
                    key={play?.id}
                    livePriceRef={livePriceRef}
                    side={lp?.side ?? 'up'}
                    target={strike ?? 0}
                    entry={entryVal ?? 0}
                    entryCost={entryCost}
                    mult={play?.multiplier ?? multiplier}
                    status={live?.status ?? 'open'}
                    finalPnl={live ? parseFloat(live.pnl) : 0}
                    openedAtMs={openedAtMs}
                    expiryMs={expiryMs}
                  />
                  <div className="mt-2.5 grid grid-cols-3 gap-x-3">
                    <Cell label="Multiplier" value={fmtMult(multiplier)} />
                    <Cell label="Target" value={strike != null ? priceLabel(strike) : '—'} />
                    <Cell label="Bet" value={`$${money(playBet)}`} />
                  </div>
                </>
              ) : reelsCycling ? (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Dealing</div>
                  <div className="text-[30px] font-extrabold leading-none text-brand-500">
                    SPINNING<span className="animate-pulse">...</span>
                  </div>
                  <div className="mt-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-text-2">Dealing your reels</div>
                </>
              ) : (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">{firstRun ? 'Welcome' : 'Lucky'}</div>
                  <div className="text-[22px] font-extrabold uppercase leading-none tracking-[0.02em] text-text">I Feel Lucky</div>
                  <div className="mt-3 flex items-baseline gap-2">
                    <span className="tnum text-[30px] font-extrabold leading-none text-brand-500">${bet}</span>
                    <span className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-text-3">Bet</span>
                  </div>
                  <div className="mt-2.5 font-mono text-[11px] font-semibold uppercase leading-snug tracking-[0.08em] text-text-2">
                    Press the button on the right to spin
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {phase === 'result' && play && <LuckyResult play={play} streak={streak} onDismiss={() => setPhase('idle')} />}
      {overlay === 'howto' && <HowTo onClose={() => setOverlay('none')} />}
      {overlay === 'history' && <History onClose={() => setOverlay('none')} />}
    </GameScreen>
  )
}

// One reel. It flickers through its pool the whole time the deal is in flight (`cycling`, which
// covers both the server round trip and the spin window), so SPIN feels instant even while the
// backend resolves. Once the play lands and the reels are `landing`, it snaps to the dealt target
// at its staggered stop time with a haptic tick. Sits flush in the connected slot strip (shared
// hairline dividers), big and punchy (docs/SCREEN.md, no rounded cards).
function Reel({
  index,
  label,
  pool,
  target,
  cycling,
  landing,
  stopAt,
  accent,
}: {
  index: number
  label: string
  pool: string[]
  target?: string
  cycling: boolean
  landing: boolean
  stopAt: number
  accent?: 'amber' | 'up' | 'down'
}) {
  const [shown, setShown] = useState<string>('—')
  const poolRef = useRef(pool)
  poolRef.current = pool

  useEffect(() => {
    if (!cycling) {
      setShown(target ?? '—')
      return
    }
    let stopped = false
    const iv = setInterval(() => {
      if (!stopped) {
        const p = poolRef.current
        setShown(p[Math.floor(Math.random() * p.length)])
      }
    }, 60)
    // Only schedule the snap once we know the dealt target and the spin window has begun.
    const to =
      landing && target
        ? setTimeout(() => {
            stopped = true
            clearInterval(iv)
            setShown(target)
            haptic('rigid')
            slotLock(index)
          }, stopAt)
        : undefined
    return () => {
      clearInterval(iv)
      if (to) clearTimeout(to)
    }
  }, [cycling, landing, target, stopAt, index])

  // Role palette: each window owns one tone, shared across the locked value, its halo, the foot bar,
  // and a faint cell wash, so the slot reads in color instead of three plain black boxes. Neutral
  // (the asset window, anything undealt) stays white-on-black.
  const palette =
    accent === 'amber'
      ? { text: 'text-brand-500', bar: 'bg-brand-500', wash: 'bg-brand-500/10', glow: 'var(--color-brand-500)' }
      : accent === 'up'
        ? { text: 'text-up', bar: 'bg-up', wash: 'bg-up/10', glow: 'var(--color-up)' }
        : accent === 'down'
          ? { text: 'text-down', bar: 'bg-down', wash: 'bg-down/10', glow: 'var(--color-down)' }
          : { text: 'text-text', bar: 'bg-text-3', wash: '', glow: 'var(--color-text)' }
  const locked = !cycling && shown !== '—'
  return (
    <div
      className={cnm(
        'relative flex flex-1 flex-col items-center justify-center gap-2 overflow-hidden border-l border-line-strong bg-black px-2 py-4 first:border-l-0',
        locked && palette.wash,
      )}
    >
      <span className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-text-3">{label}</span>
      <span
        className={cnm('tnum text-[28px] font-extrabold leading-none transition-colors duration-200', cycling ? 'text-text-2' : palette.text)}
        style={locked ? { textShadow: `0 0 16px ${palette.glow}` } : undefined}
      >
        {shown}
      </span>
      {/* foot bar: the slot band's colored baseline, lit when the window lands. */}
      <span className={cnm('absolute inset-x-0 bottom-0 h-[3px] transition-opacity duration-200', palette.bar, locked ? 'opacity-100' : 'opacity-25')} />
    </div>
  )
}

// The win/loss/cash-out moment. Flat full-screen wash (docs/SCREEN.md: big, flat, momentary, no blur),
// the §10 copy, the signed amount, the streak on a win, and the explorer link when it is on-chain.
function LuckyResult({ play, streak, onDismiss }: { play: PlayDTO; streak: number; onDismiss: () => void }) {
  const reduced = useReducedMotion()
  const pnl = parseFloat(play.pnl ?? '0')
  const won = play.status === 'won'
  const cashed = play.status === 'cashed_out'
  const positive = won || (cashed && pnl >= 0)
  const head = won ? 'YOU WON' : cashed ? 'CASHED OUT' : 'MISSED'
  const digest = play.txRedeem ?? play.txMint
  const pop = reduced
    ? {}
    : { initial: { scale: 0.7, opacity: 0 }, animate: { scale: 1, opacity: 1 }, transition: { type: 'spring' as const, stiffness: 440, damping: 24 } }
  return (
    <button
      type="button"
      onClick={onDismiss}
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/90 text-center"
    >
      <div className={cnm('font-mono text-[13px] font-bold uppercase tracking-[0.2em]', positive ? 'text-up' : 'text-down')}>{head}</div>
      <motion.div
        {...pop}
        style={{ textShadow: '0 0 28px currentColor' }}
        className={cnm('tnum text-[56px] font-extrabold leading-none', positive ? 'text-up' : 'text-down')}
      >
        {pnl >= 0 ? '+' : '-'}$<Stat value={Math.abs(pnl)} />
      </motion.div>
      {won && streak > 0 && (
        <div className="mt-1 inline-flex items-center border border-brand-500/60 px-2 py-0.5 font-mono text-[12px] font-bold uppercase tracking-[0.1em] text-brand-500">
          Streak {streak}
        </div>
      )}
      {!positive && <div className="font-mono text-[12px] uppercase tracking-[0.12em] text-text-3">Spin again</div>}
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
      <span className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-text-3">Tap to continue</span>
    </button>
  )
}

// The live readout while a round is open: a smooth, chart-synced P/L. With directional targets the
// sign now matches the move (price going your way reads green, against you red), and it converges to
// the real win/loss at the buzzer. The number rides the chart's eased price (livePriceRef) at 60fps,
// written imperatively so the screen never re-renders on a tick. On a terminal status it shows the
// settled result. CASH OUT is the live early-exit estimate; WIN is the full upside if you hold and land.
function LivePnl({
  livePriceRef,
  side,
  target,
  entry,
  entryCost,
  mult,
  status,
  finalPnl,
  openedAtMs,
  expiryMs,
}: {
  livePriceRef: { current: number }
  side: Side
  target: number
  entry: number
  entryCost: number
  mult: number
  status: PlayStatus
  finalPnl: number
  openedAtMs: number
  expiryMs: number
}) {
  const terminal = RESULT_TERMINAL.has(status)
  const valid = entry > 0 && target > 0 && entryCost > 0
  const winAmt = Math.max(0, entryCost * (mult - 1))
  const [pos, setPos] = useState(true) // P/L sign, drives the hero color (flips only at the target)
  const posRef = useRef(true)
  const pnlSpan = useRef<HTMLSpanElement>(null)
  const cashSpan = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (terminal || !valid) return
    const dir = side === 'up' ? 1 : -1
    // Back the round vol out of where the target actually sits, so the estimate reads ~0 P/L at entry
    // and converges to the full win / zero at the buzzer. z = the tier's normal quantile; at-the-money
    // (~2x) the distance is ~0 and the vol can't be inferred, so fall back to LIVE_VOL.
    const distFrac = Math.abs(target - entry) / entry
    const z = -invNorm(Math.min(0.5, Math.max(1e-4, 1 / mult)))
    const sigmaFull = distFrac > 1e-6 && z > 1e-3 ? distFrac / z : LIVE_VOL
    let raf = 0
    const loop = () => {
      const price = livePriceRef.current
      if (price > 0) {
        const gap = (dir * (price - target)) / entry // > 0 = on the winning side of TARGET
        const remaining = clamp01((expiryMs - Date.now()) / Math.max(1, expiryMs - openedAtMs))
        const sigma = sigmaFull * Math.sqrt(Math.max(remaining, 0.0015))
        const value = entryCost * mult * clamp01(normCdf(gap / sigma)) // live fair / cash-out value
        const pnl = value - entryCost
        const nowPos = pnl >= -1e-9
        if (nowPos !== posRef.current) {
          posRef.current = nowPos
          setPos(nowPos)
        }
        if (pnlSpan.current) pnlSpan.current.textContent = `${nowPos ? '+' : '-'}$${money(Math.abs(pnl))}`
        if (cashSpan.current) cashSpan.current.textContent = money(Math.max(0, value))
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [terminal, valid, side, target, entry, entryCost, mult, openedAtMs, expiryMs, livePriceRef])

  if (terminal) {
    const won = status === 'won' || (status === 'cashed_out' && finalPnl >= 0)
    const label = status === 'won' ? 'Won' : status === 'cashed_out' ? 'Cashed out' : 'Missed'
    return (
      <>
        <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">{label}</div>
        <div className={cnm('text-[40px] font-extrabold leading-none', won ? 'text-up' : 'text-down')}>
          {finalPnl >= 0 ? '+' : '-'}$<Stat value={Math.abs(finalPnl)} />
        </div>
        <div className="mt-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-text-2">
          {side === 'up' ? 'UP' : 'DOWN'} · {fmtMult(mult)}
        </div>
      </>
    )
  }

  return (
    <>
      <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Profit / Loss</div>
      <div className={cnm('tnum text-[40px] font-extrabold leading-none', pos ? 'text-up' : 'text-down')}>
        <span ref={pnlSpan}>{valid ? '+$0.00' : '—'}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] font-bold uppercase tracking-[0.06em]">
        <span className="text-text-2">
          Cash out <span className="tnum text-text">$<span ref={cashSpan}>{money(valid ? entryCost : 0)}</span></span>
        </span>
        <span className="text-text-3">·</span>
        <span className="text-text-2">
          Win <span className="tnum text-up">+${money(winAmt)}</span>
        </span>
      </div>
    </>
  )
}

// HOW TO: a flat in-screen card of the rules. Plain terminology only, no banned words.
function HowTo({ onClose }: { onClose: () => void }) {
  const lines: Array<[string, string]> = [
    ['SPIN', 'Deals an asset, a direction (up or down), and a multiplier.'],
    ['TARGET', 'A price set in your direction: up sits above, down sits below.'],
    ['WIN', 'Price reaches the target by the buzzer to win bet × multiplier.'],
    ['CASH OUT', 'Take the live value any time before the buzzer.'],
  ]
  return (
    <button
      type="button"
      onClick={onClose}
      className="absolute inset-0 z-20 flex flex-col justify-center gap-4 bg-black/95 p-[var(--screen-rim,24px)] text-left"
    >
      <div className="font-mono text-[13px] font-bold uppercase tracking-[0.2em] text-brand-500">How to play</div>
      <div className="flex max-w-[80%] flex-col gap-3">
        {lines.map(([k, v]) => (
          <div key={k}>
            <div className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-text">{k}</div>
            <div className="text-[14px] leading-snug text-text-2">{v}</div>
          </div>
        ))}
      </div>
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-3">Tap to close</span>
    </button>
  )
}

// HISTORY: the player's recent Lucky rounds, newest first. Flat rows split by hairlines.
function History({ onClose }: { onClose: () => void }) {
  const q = useQuery({ queryKey: ['plays'], queryFn: () => api.plays({ limit: 30 }) })
  const plays = (q.data?.plays ?? []).filter((p) => p.game === 'lucky' && p.status !== 'open' && p.status !== 'pending').slice(0, 6)
  return (
    <button
      type="button"
      onClick={onClose}
      className="absolute inset-0 z-20 flex flex-col gap-3 bg-black/95 p-[var(--screen-rim,24px)] text-left"
    >
      <div className="flex items-center justify-between">
        <div className="font-mono text-[13px] font-bold uppercase tracking-[0.2em] text-brand-500">History</div>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-3">Tap to close</span>
      </div>
      {q.isLoading ? (
        <div className="flex flex-col gap-3 pt-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="shimmer h-4 w-3/4" />
          ))}
        </div>
      ) : plays.length === 0 ? (
        <div className="text-[14px] text-text-2">No plays yet. Hit SPIN to start.</div>
      ) : (
        <div className="flex max-w-[88%] flex-col divide-y divide-line-strong">
          {plays.map((p) => (
            <HistoryRow key={p.id} play={p} />
          ))}
        </div>
      )}
    </button>
  )
}

function HistoryRow({ play }: { play: PlayDTO }) {
  const lp = play.params as LuckyParams
  const pnl = parseFloat(play.pnl ?? '0')
  const won = play.status === 'won' || (play.status === 'cashed_out' && pnl >= 0)
  const label = play.status === 'won' ? 'WON' : play.status === 'cashed_out' ? 'CASHED' : 'LOST'
  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="flex items-center gap-3">
        <span className="font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-text">{lp.asset}</span>
        <span className="font-mono text-[12px] font-bold uppercase tracking-[0.06em] text-brand-500">{fmtMult(play.multiplier)}</span>
      </div>
      <div className="text-right">
        <div className={cnm('font-mono text-[11px] font-bold uppercase tracking-[0.08em]', won ? 'text-up' : 'text-down')}>{label}</div>
        <div className={cnm('tnum text-[14px] font-bold', pnl >= 0 ? 'text-up' : 'text-down')}>
          {pnl >= 0 ? '+' : '-'}${money(Math.abs(pnl))}
        </div>
      </div>
    </div>
  )
}
