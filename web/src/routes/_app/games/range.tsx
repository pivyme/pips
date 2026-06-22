import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import type { BandOverlay } from '@/components/game/Chart'
import type { PlayDTO, PlayStatus } from '@/lib/api'
import { useConsoleControls } from '@/components/console/controls'
import { Chart } from '@/components/game/Chart'
import {
  Cell,
  GameScreen,
  ScreenMessage,
  ScreenOverlay,
} from '@/components/game/screen'
import { GameLeaderboardOverlay } from '@/components/game/GameLeaderboardOverlay'
import { Stat } from '@/components/Stat'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { useLiveMarkets } from '@/hooks/useLiveMarkets'
import { haptic } from '@/lib/haptics'
import {
  rangeBuzzer,
  rangeCross,
  rangeLock,
  rangeLose,
  rangeWin,
  startRangeBgm,
  stopRangeBgm,
} from '@/lib/sound'
import { api, streamPlay } from '@/lib/api'
import { cashOut, placePlay } from '@/lib/sui/predict'
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
// Shared persisted stake index (Lucky + the home idle wheel write the same key), so the chosen chip
// stays put across navigation and reloads instead of resetting to a default each mount.
const STAKE_KEY = 'pips_stake_idx'
// Band ladder: the ± half-band sizes the knob steps through (percent). Tighter pays more.
const BAND_LADDER = [0.1, 0.2, 0.5, 1, 1.5] as const
const FALLBACK_ASSETS = ['BTC', 'ETH', 'SUI', 'SOL', 'DEEP']
const TOKEN_LOGOS: Record<string, string> = {
  BTC: '/assets/images/coins/btc-logo.png',
  ETH: '/assets/images/coins/eth-logo.png',
  SUI: '/assets/images/coins/sui-logo.png',
}
const NOMINAL_ROUND_SEC = 30 // the idle multiplier preview's reference; the real round = oracle expiry
// The result is dismissed with CONTINUE, so this is only a safety auto-advance for an idle player.
// Generous, so it never yanks the result away mid-read but still recovers an AFK screen (Lucky parity).
const RESULT_MS = 6500
// The settlement price freezes ~EXPIRY_SAFETY_MS (backend, 5000) before the buzzer: the price-pusher
// stops pushing an oracle once it is within that window of expiry, so the on-chain settle value is
// locked seconds before the countdown hits zero while the chart keeps walking. From this lead in we
// stop showing a live "am I winning" (it no longer reflects what settles) and disarm cash-out, then
// reveal the real settle price at the end. Matches PIPS_EXPIRY_SAFETY_MS; if they drift the reveal is
// still exact (it reads play.settlePrice), only the lock label timing shifts a touch.
const SETTLE_LOCK_MS = 5000
// The settle progress bar eases toward (never to) full over this window once past the buzzer.
const SETTLE_EXPECT_MS = 12000
// Safety-net poll of the play, independent of the live SSE: its socket can silently drop (expired
// stream token, proxy timeout), which is what stranded the screen on OPENING / SETTLING forever. This
// guarantees the terminal frame always lands. Same pattern as Lucky.
const WATCHDOG_MS = 3000
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

  const [widthIdx, setWidthIdx] = useState(3) // knob index into BAND_LADDER (default ±1.0%)
  // One persistent stake shared with Lucky + the home wheel (same ladder), so it stays put across nav.
  const [stakeIdx, setStakeIdx] = useLocalStorage(STAKE_KEY, 2)
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null) // the player's pick, by symbol
  const [phase, setPhase] = useState<Phase>('idle')
  const [play, setPlay] = useState<PlayDTO | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [spot, setSpot] = useState<number | null>(null)
  const [secsLeft, setSecsLeft] = useState<number | null>(null)
  const [remainingMs, setRemainingMs] = useState<number | null>(null) // ms to the real buzzer, drives the lock/settle states
  const [settleMs, setSettleMs] = useState(0) // time past the buzzer, drives the SETTLING progress bar
  const [overlay, setOverlay] = useState<Overlay>('none')
  // The chart's live active price captured the instant PLAY is hit, drawn as the grey ENTRY line while
  // the band is still locking. Once the play opens the ENTRY line switches to play.entrySpot (the oracle
  // spot the band was actually solved around), so entry, band, and settlement share one price space.
  const [entryPrice, setEntryPrice] = useState<number | null>(null)

  const finalized = useRef(false)
  const watchdogRun = useRef(0)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wasInside = useRef<boolean | null>(null) // last in/out band state, for the crossing tick
  // The chart price captured at the press, used to paint a "locking" band instantly while the backend
  // resolves the real bounds (the reels-equivalent that makes PLAY feel immediate).
  const pressSpot = useRef<number | null>(null)
  // The chart's eased leading price (the active dot), written every frame by the Chart. The live P/L
  // reads it to track the line at 60fps instead of the laggy ~2s backend mark.
  const livePriceRef = useRef(0)

  // Shared feed: fast poll + grace so a ladder roll never flashes "no markets" at the player.
  const {
    liveAssets,
    noLiveMarket,
    isLoading: marketsLoading,
    isError: marketsError,
  } = useLiveMarkets()
  const statsQ = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() })
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

  const halfPct = BAND_LADDER[Math.min(widthIdx, BAND_LADDER.length - 1)]
  const canPlay = liveAssets.length > 0
  const roundLive =
    phase === 'open' || phase === 'cashing' || phase === 'result'

  // Multiplier quotes for the whole band ladder, off the real Predict ask. Fetched once per asset on
  // select and cached, so every band size shows its true locked multiple the instant the knob lands on
  // it, with no flicker to a rough estimate. One batched call prices all bands off one oracle snapshot
  // (consistent + cheap). Refreshed as spot/vault drift; paused while a round is live (the locked mult
  // drives then). The old client-side estimate was off by multiples on tight bands, so it is only the
  // cold-start fallback until the cache warms.
  const bandWidthsPct = BAND_LADDER.map((h) => h * 2)
  const quotesQ = useQuery({
    queryKey: ['rangeQuotes', activeAsset],
    queryFn: () => api.rangeQuotes(activeAsset, bandWidthsPct),
    enabled: canPlay && !!activeAsset && !roundLive,
    placeholderData: (prev) => prev,
    staleTime: 4_000,
    refetchInterval: 8_000,
    retry: false,
  })
  const quotedMult = quotesQ.data?.quotes[widthIdx]?.multiplier

  const liveMult = live?.multiplier ?? play?.multiplier
  // Idle preview reads the cached real multiple for the selected band; the rough estimate is only the
  // cold-start fallback (and a guard against an unmintable 0 from the chain).
  const idleMult =
    quotedMult && quotedMult > 0
      ? quotedMult
      : estimateMultiplier(halfPct, NOMINAL_ROUND_SEC)
  const mult = liveMult ?? idleMult

  // Band overlay: a live ±halfPct preview while idle (the chart centers it on the smoothed price and
  // it tracks the live edge), locked to the play's strike bounds only while a round is live. The lock
  // is gated on the phase (roundLive, defined above), not just on `play`, because `play` lingers after
  // a settle; without the gate the band would freeze at the finished round's bounds instead of
  // resuming the live preview.
  const lower = play?.market.lower ? parseFloat(play.market.lower) : null
  const upper = play?.market.upper ? parseFloat(play.market.upper) : null
  // The instant PLAY is pressed the backend still has to resolve the real oracle bounds (~a few sec).
  // Paint a "locking" band frozen at the press spot right away, then snap to the real strike bounds when
  // the play opens. That, plus the LOCKING readout, is what makes the press feel immediate instead of
  // dead while the resolve runs.
  const placingBand: BandOverlay | null =
    phase === 'placing' && pressSpot.current != null
      ? {
          lower: pressSpot.current * (1 - halfPct / 100),
          upper: pressSpot.current * (1 + halfPct / 100),
          locked: true,
        }
      : null
  const band: BandOverlay | undefined =
    roundLive && lower != null && upper != null
      ? { lower, upper, locked: true }
      : placingBand
        ? placingBand
        : spot != null
          ? { pct: halfPct }
          : undefined
  const showBand = phase !== 'result' || play != null

  // Entry reference: play.entrySpot, the oracle spot the band was solved around, so the ENTRY line, the
  // band, and the on-chain settlement all sit in one price space. The old client capture floated in the
  // chart's feed (a different sample of the same walk), which is part of why the line could read inside
  // while the round settled outside. Falls back to the press capture while the band is still locking.
  const entrySpotNum = play?.entrySpot ? parseFloat(play.entrySpot) : NaN
  const bandCenter = lower != null && upper != null ? (lower + upper) / 2 : null
  const entryLevel =
    Number.isFinite(entrySpotNum) && entrySpotNum > 0
      ? entrySpotNum
      : (entryPrice ?? bandCenter)
  const showEntryLine = entryLevel != null && (roundLive || phase === 'placing')

  // Round-start + settle dots on the line, anchored at the entry level. The settle dot lands at the real
  // on-chain buzzer (play.market.expiry), not openedAt+duration, which overshoots past the real settle by
  // the mint latency. Gated on roundLive so the dots clear with the band once the round ends.
  const openedAtMs = play?.openedAt ? Date.parse(play.openedAt) : 0
  const buzzerMs =
    play?.market.expiry ||
    (openedAtMs
      ? openedAtMs + (play?.params.duration || NOMINAL_ROUND_SEC) * 1000
      : 0)
  const markers =
    roundLive && play && entryLevel != null && openedAtMs
      ? [
          { t: openedAtMs, p: entryLevel },
          { t: buzzerMs, p: entryLevel },
        ]
      : undefined

  // Is the live price inside the locked band right now? Drives the open-state IN ZONE / OUT pill and
  // the tactile crossing tick. (lower, upper] matches the on-chain settlement rule.
  const inZone =
    lower != null && upper != null && spot != null
      ? spot > lower && spot <= upper
      : null

  // Phase machine, derived from the live status + the countdown. The settlement price freezes
  // SETTLE_LOCK_MS before the buzzer, so the round has a clear lock-in window:
  //   opening  - the mint is still landing (band locked, not open on-chain yet)
  //   liveHold - open and far enough from expiry that the live line still reflects what will settle
  //   sealing  - inside the lock window: the outcome is already frozen on-chain, so we stop the live
  //              read and disarm cash-out, the result is just being sealed
  //   settling - past the buzzer, waiting on the on-chain settle frame
  const confirmed = live?.status === 'open'
  const opening = phase === 'open' && live?.status === 'pending'
  const settling = phase === 'open' && remainingMs != null && remainingMs <= 0
  const sealing =
    phase === 'open' &&
    confirmed &&
    remainingMs != null &&
    remainingMs > 0 &&
    remainingMs <= SETTLE_LOCK_MS
  const liveHold =
    phase === 'open' &&
    confirmed &&
    remainingMs != null &&
    remainingMs > SETTLE_LOCK_MS
  const cashing = phase === 'cashing'

  const clearResetTimer = () => {
    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = null
  }

  const finishResult = useCallback(
    (final: PlayDTO) => {
      finalized.current = true
      watchdogRun.current += 1
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

  // Resolve a round from a status, idempotent via `finalized` so the SSE and the watchdog below can both
  // feed it and only the first acts. 'error' = the background mint never opened (chips safe), so re-rack
  // cleanly. A win/loss/cashout refetches the finalized play for the payout + the real settle price.
  const resolveTerminal = useCallback(
    (status: PlayStatus, playId: string) => {
      if (finalized.current) return
      if (status === 'error') {
        finalized.current = true
        watchdogRun.current += 1
        toast.error(
          'Could not open that play. Your chips are safe, play again.',
          { id: 'range-play-error' },
        )
        clearResetTimer()
        pressSpot.current = null
        setPlay(null)
        setLive(null)
        setPhase('idle')
        return
      }
      if (RESULT_TERMINAL.has(status)) {
        finalized.current = true
        watchdogRun.current += 1
        void api
          .getPlay(playId)
          .then(({ play: final }) => finishResult(final))
          .catch(() => setPhase('idle'))
      }
    },
    [finishResult],
  )

  // Live value while a play is open. The play comes back 'pending' the instant it's placed; the real
  // mint_range lands a moment later and the stream flips it to 'open', then to a terminal frame at the
  // buzzer settle.
  useEffect(() => {
    if (!play || phase !== 'open') return
    const id = play.id
    return streamPlay(
      id,
      (tick) => {
        setLive({
          markValue: tick.markValue,
          pnl: tick.pnl,
          multiplier: tick.multiplier,
          status: tick.status,
        })
        resolveTerminal(tick.status, id)
      },
      () => {
        // SSE dropped: keep the last readout. EventSource retries, and the watchdog below still resolves.
      },
    )
  }, [play, phase, resolveTerminal])

  // Watchdog: poll the play directly on a steady cadence, independent of the SSE socket. This is what
  // makes OPENING / SETTLING deterministic, the result lands even if the stream silently died. Reads are
  // cheap (the backend caches the live mark and skips it entirely once past the buzzer). Mirrors Lucky.
  useEffect(() => {
    if (!play || phase !== 'open') return
    const id = play.id
    const run = ++watchdogRun.current
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      if (run !== watchdogRun.current || finalized.current) return
      try {
        const { play: cur } = await api.getPlay(id)
        if (run !== watchdogRun.current) return
        setLive({
          markValue: cur.markValue,
          pnl: cur.pnl,
          multiplier: cur.multiplier,
          status: cur.status,
        })
        resolveTerminal(cur.status, id)
      } catch {
        // transient; the next tick retries
      }
      if (run === watchdogRun.current)
        timer = setTimeout(() => void poll(), WATCHDOG_MS)
    }
    timer = setTimeout(() => void poll(), WATCHDOG_MS)
    return () => {
      if (watchdogRun.current === run) watchdogRun.current += 1
      clearTimeout(timer)
    }
  }, [play, phase, resolveTerminal])

  useEffect(() => () => clearResetTimer(), [])

  // The cinematic tension bed rides the whole active window: it fades in the instant PLAY is pressed
  // (placing), through the open hold, and out the moment the phase leaves it (cash out, settle, re-rack,
  // or navigating away). finishResult also cuts it so the win/lose sting lands over silence.
  const rangeActive = phase === 'placing' || phase === 'open'
  useEffect(() => {
    if (!rangeActive) return
    startRangeBgm()
    return () => stopRangeBgm()
  }, [rangeActive])

  const doPlay = useCallback(async () => {
    // Idle only: a finished round must be dismissed back to the default screen first (CONTINUE), never
    // re-played straight from the result. That keeps the post-round always landing on the live screen.
    if (phase !== 'idle') return
    if (!canPlay) {
      toast.error('No live market right now. Try again in a sec.', {
        id: 'no-market',
      })
      return
    }
    clearResetTimer()
    finalized.current = false
    wasInside.current = null
    setOverlay('none')
    // The chart's eased active price (the dot the player is watching) at the press. The band locks here
    // visually (placingBand) and the grey ENTRY line sits on it until the real entrySpot arrives.
    const entryAt = livePriceRef.current > 0 ? livePriceRef.current : spot
    const px = entryAt && entryAt > 0 ? entryAt : null
    pressSpot.current = px
    setEntryPrice(px)
    setPhase('placing')
    // Fire the committal confirm AT the press, not after the await: this is what makes PLAY feel
    // immediate instead of dead for the few seconds the backend takes to resolve the band.
    haptic('heavy')
    rangeLock()
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
      haptic('selection') // a light tick as the position lands; the heavy confirm already fired on press
    } catch (e) {
      toastError(e)
      pressSpot.current = null
      setPhase('idle')
    }
  }, [phase, canPlay, stake, asset, halfPct, spot])

  const doCashOut = useCallback(async () => {
    // Armed only during the live hold (the button is hidden once the round is sealing/settling).
    if (!liveHold || !play) return
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
  }, [liveHold, play, finishResult])

  // Leave the result on any console button: drops straight back to the default idle screen, it does NOT
  // re-play. The auto-advance timer lands in the same place, a button just gets there sooner.
  const dismissResult = useCallback(() => {
    clearResetTimer()
    haptic('selection')
    pressSpot.current = null
    setPhase('idle')
  }, [])

  // Round countdown to the real on-chain buzzer (play.market.expiry, the oracle expiry the round settles
  // at), not openedAt+duration: the mint lands a beat after PLAY, so openedAt+duration runs PAST the real
  // expiry and showed phantom seconds. Drives the lock-in window + the SETTLING progress off remainingMs.
  // At 0 it flips to SETTLING and the settle worker drives the win/lose; the streams above catch it.
  useEffect(() => {
    if (phase !== 'open' || !play) {
      setSecsLeft(null)
      setRemainingMs(null)
      setSettleMs(0)
      return
    }
    const endAt =
      play.market.expiry ||
      (play.openedAt ? Date.parse(play.openedAt) : Date.now()) +
        (play.params.duration || NOMINAL_ROUND_SEC) * 1000
    const tick = () => {
      const remaining = endAt - Date.now()
      setSecsLeft(Math.max(0, Math.ceil(remaining / 1000)))
      setRemainingMs(remaining)
      setSettleMs(remaining < 0 ? -remaining : 0)
    }
    tick()
    const iv = setInterval(tick, 250)
    return () => clearInterval(iv)
  }, [phase, play])

  // A tactile tick whenever the live price crosses into or out of your band, only during the live hold
  // (not once the outcome is sealing, where a late chart wiggle no longer changes the result).
  useEffect(() => {
    if (!liveHold || inZone == null) return
    if (wasInside.current != null && wasInside.current !== inZone) {
      haptic('selection')
      rangeCross(inZone)
    }
    wasInside.current = inZone
  }, [inZone, liveHold])

  const cycleAsset = useCallback(() => {
    haptic('selection')
    if (!assets.length) return
    const i = assets.indexOf(activeAsset)
    setSelectedAsset(assets[(i + 1) % assets.length])
  }, [assets, activeAsset])
  // The left cap is a rotary through the info screens: game -> how to -> leaderboard -> game. Each
  // press advances one step and the label names where the NEXT press lands, so it reads as a dial
  // between the two info pages and back to the live game. Tapping an open overlay's backdrop also
  // resets to 'none', which lands the cap back on HOW TO, so the two ways out stay in sync.
  const rotateInfo = useCallback(() => {
    haptic('selection')
    setOverlay((o) =>
      o === 'none' ? 'howto' : o === 'howto' ? 'board' : 'none',
    )
  }, [])
  const infoLabel =
    overlay === 'none' ? 'HOW TO' : overlay === 'howto' ? 'RANKS' : 'GAME'

  const isResult = phase === 'result'
  const resultPositive =
    isResult &&
    play != null &&
    (play.status === 'won' ||
      (play.status === 'cashed_out' && parseFloat(play.pnl) >= 0))
  const resultColor: 'up' | 'down' = resultPositive ? 'up' : 'down'
  useConsoleControls({
    knob: {
      label: 'RANGE',
      min: 0,
      max: BAND_LADDER.length - 1, // step through the ±0.1% .. ±1.5% ladder
      step: 1,
      value: widthIdx,
      onChange: setWidthIdx,
      format: (v) =>
        `±${BAND_LADDER[Math.min(v, BAND_LADDER.length - 1)].toFixed(1)}%`,
    },
    numberWheel: {
      label: 'DUSDC',
      min: 0,
      max: maxBetIdx,
      step: 1,
      value: safeBetIdx,
      onChange: setStakeIdx,
      format: (v) => `$${STAKE_LADDER[Math.min(v, maxBetIdx)]}`,
    },
    action1: isResult
      ? { label: '', color: resultColor, onPress: dismissResult, pulse: true }
      : { label: infoLabel, color: 'neutral', onPress: rotateInfo },
    action2: isResult
      ? { label: '', color: resultColor, onPress: dismissResult, pulse: true }
      : {
          label: asset,
          color: 'neutral',
          onPress: cycleAsset,
          display: {
            mode: 'token',
            ticker: asset,
            logoSrc: TOKEN_LOGOS[asset],
          },
        },
    main: isResult
      ? { label: 'CONTINUE', color: 'amber', onPress: dismissResult }
      : settling
        ? {
            label: 'SETTLING',
            color: 'amber',
            onPress: () => {},
            loading: true,
          }
        : sealing
          ? {
              label: 'LOCKING IN',
              color: 'amber',
              onPress: () => {},
              loading: true,
            }
          : liveHold
            ? {
                label: 'CASH OUT',
                color: 'up',
                onPress: () => void doCashOut(),
              }
            : opening
              ? {
                  label: 'OPENING',
                  color: 'up',
                  onPress: () => {},
                  loading: true,
                }
              : cashing
                ? {
                    label: 'CASHING OUT',
                    color: 'up',
                    onPress: () => {},
                    loading: true,
                  }
                : phase === 'placing'
                  ? {
                      label: 'LOCKING IN',
                      color: 'amber',
                      onPress: () => {},
                      loading: true,
                    }
                  : {
                      label: 'PLAY',
                      color: 'amber',
                      onPress: () => void doPlay(),
                    },
  })

  const pnlNum = live ? parseFloat(live.pnl) : 0
  const showReadouts =
    play != null &&
    (phase === 'open' || phase === 'cashing' || phase === 'result')
  const showZonePill = liveHold && inZone != null
  const settleSecs = Math.floor(settleMs / 1000)
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
      {marketsLoading ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="shimmer h-24 w-2/3" />
        </div>
      ) : marketsError ? (
        <ScreenMessage title="Could not load markets" />
      ) : noLiveMarket ? (
        <ScreenMessage title="No live markets right now." />
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
            {/* COUNTDOWN — a big faded watermark behind the chart line (the canvas clears to transparent,
                so this shows through). Only while a round runs, tracking the real on-chain buzzer. */}
            {showReadouts && secsLeft != null && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
                <span className="tnum font-black leading-none text-text opacity-15 text-[clamp(64px,18vh,128px)]">
                  {secsLeft}
                </span>
              </div>
            )}
            {asset ? (
              <Chart
                asset={asset}
                overlays={
                  showBand && band
                    ? {
                        band,
                        markers,
                        entry: showEntryLine ? entryLevel : undefined,
                      }
                    : undefined
                }
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
              {phase === 'placing' ? (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                    Locking band
                  </div>
                  <div className="text-[30px] font-extrabold leading-none text-brand-500">
                    LOCKING IN
                  </div>
                  <div className="mt-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-text-2">
                    {recap}
                  </div>
                  <div className="mt-3 h-1 w-[200px] max-w-full overflow-hidden bg-line-strong">
                    <div className="bar-sweep h-full w-1/3 bg-brand-500" />
                  </div>
                </>
              ) : opening ? (
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
                    Settling · {settleSecs}s
                  </div>
                  <div className="text-[30px] font-extrabold leading-none text-brand-500">
                    SETTLING
                  </div>
                  <div className="mt-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-text-2">
                    {recap}
                  </div>
                  <div className="mt-3 h-1 w-[200px] max-w-full overflow-hidden bg-line-strong">
                    <div
                      className="h-full bg-brand-500 transition-[width] duration-300 ease-out"
                      style={{
                        width: `${Math.min(94, (settleMs / SETTLE_EXPECT_MS) * 100)}%`,
                      }}
                    />
                  </div>
                </>
              ) : sealing ? (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                    Price locked · {secsLeft ?? 0}s
                  </div>
                  <div className="text-[30px] font-extrabold leading-none text-brand-500">
                    LOCKING IN
                  </div>
                  <div className="mt-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-text-2">
                    {recap}
                  </div>
                  <div className="mt-3 h-1 w-[200px] max-w-full overflow-hidden bg-line-strong">
                    <div
                      className="h-full bg-brand-500 transition-[width] duration-300 ease-out"
                      style={{
                        width: `${Math.min(
                          96,
                          ((SETTLE_LOCK_MS - remainingMs) / SETTLE_LOCK_MS) *
                            100,
                        )}%`,
                      }}
                    />
                  </div>
                </>
              ) : cashing ? (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                    Cashing out
                  </div>
                  <div className="text-[30px] font-extrabold leading-none text-up">
                    CASHING OUT
                  </div>
                  <div className="mt-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-text-2">
                    {recap}
                  </div>
                  <div className="mt-3 h-1 w-[200px] max-w-full overflow-hidden bg-line-strong">
                    <div className="bar-sweep h-full w-1/3 bg-up" />
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
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {phase === 'result' && play && <RangeResult play={play} />}
      {overlay === 'howto' && <HowTo />}
      {overlay === 'board' && (
        <GameLeaderboardOverlay game="range" title="Range" />
      )}
    </GameScreen>
  )
}

// The live P/L while a band is open. Range settles binary: inside the band at the buzzer returns
// stake x mult (spread-free), outside loses the stake. Shown gross: inside the band -> the full
// return (stake back + profit), outside -> -stake. It rides the 60fps dot (livePriceRef) so it flips
// the instant the line crosses an edge, and Stat rolls it between the two. On a terminal status it
// shows the real settled outcome, also gross (a win adds the stake back onto the net pnl).
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
  const gross = stake * mult // full return if it lands in the zone: stake back + profit
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

  // Win shows the gross return (net pnl + stake back), a loss shows the amount lost.
  const pnl = terminal
    ? finalPnl >= 0
      ? finalPnl + stake
      : finalPnl
    : inside
      ? gross
      : -stake
  const up = pnl >= 0
  return (
    <div
      className={cnm(
        'tnum text-[40px] font-extrabold leading-none',
        up ? 'text-up' : 'text-down',
      )}
    >
      {up ? '+' : '-'}$<Stat value={Math.abs(pnl)} />
    </div>
  )
}

// The win/loss/cash-out moment. The verdict comes from the settled play status. The gauge only explains
// where the backend's frozen settlement price landed relative to the actual on-chain band.
function RangeResult({ play }: { play: PlayDTO }) {
  const reduced = useReducedMotion()
  const pnl = parseFloat(play.pnl)
  const stake = parseFloat(play.stake)
  const won = play.status === 'won'
  const cashed = play.status === 'cashed_out'
  const positive = won || (cashed && pnl >= 0)
  // Gross framing: a win shows the full return (stake back + profit), a loss shows the amount lost.
  const shown = pnl >= 0 ? pnl + stake : pnl
  const head = won ? 'IN THE ZONE' : cashed ? 'CASHED OUT' : 'OUT OF RANGE'
  const lo = play.market.lower ? parseFloat(play.market.lower) : null
  const hi = play.market.upper ? parseFloat(play.market.upper) : null
  const settled = play.settlePrice ? parseFloat(play.settlePrice) : null
  const hasGauge =
    lo != null &&
    hi != null &&
    settled != null &&
    Number.isFinite(lo) &&
    Number.isFinite(hi) &&
    Number.isFinite(settled) &&
    hi > lo
  const relation = hasGauge
    ? settled <= lo
      ? 'below'
      : settled > hi
        ? 'above'
        : 'inside'
    : null
  const pop = reduced
    ? {}
    : {
        initial: { scale: 0.7, opacity: 0 },
        animate: { scale: 1, opacity: 1 },
        transition: { type: 'spring' as const, stiffness: 440, damping: 24 },
      }
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/90 text-center">
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
        {shown >= 0 ? '+' : '-'}$<Stat value={Math.abs(shown)} />
      </motion.div>
      {hasGauge ? (
        <SettlementGauge
          lower={lo}
          upper={hi}
          price={settled}
          relation={relation}
          label={cashed ? 'Exit' : 'Settled'}
        />
      ) : (
        lo != null &&
        hi != null && (
          <div className="font-mono text-[12px] uppercase tracking-[0.12em] text-text-3">
            Band {compact(lo)} – {compact(hi)}
          </div>
        )
      )}
      <span className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-text-3">
        Any button to continue
      </span>
    </div>
  )
}

function SettlementGauge({
  lower,
  upper,
  price,
  relation,
  label,
}: {
  lower: number
  upper: number
  price: number
  relation: 'below' | 'inside' | 'above'
  label: 'Exit' | 'Settled'
}) {
  const span = upper - lower
  // The band owns the middle half of the gauge. Far misses clamp to an edge, while the exact price
  // remains visible in the label below.
  const pricePct = Math.max(4, Math.min(96, 25 + ((price - lower) / span) * 50))
  const relationCopy =
    relation === 'inside'
      ? `${label} inside your band`
      : `${label} ${relation} your band`

  return (
    <div className="mt-3 w-[280px] max-w-[72%]">
      <div className="relative h-5 border-y border-line-strong">
        <div className="absolute inset-y-0 left-1/4 w-1/2 bg-brand-500/20" />
        <div className="absolute inset-y-0 left-1/4 w-px bg-brand-500" />
        <div className="absolute inset-y-0 left-3/4 w-px bg-brand-500" />
        <div
          className={cnm(
            'absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 border-2 border-black',
            relation === 'inside' ? 'bg-up' : 'bg-down',
          )}
          style={{ left: `${pricePct}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-text-3">
        <span>{compact(lower)}</span>
        <span>{compact(upper)}</span>
      </div>
      <div
        className={cnm(
          'mt-2 font-mono text-[11px] font-bold uppercase tracking-[0.1em]',
          relation === 'inside' ? 'text-up' : 'text-down',
        )}
      >
        {relationCopy} · {priceLabel(price)}
      </div>
    </div>
  )
}

// HOW TO: a flat in-screen card of the rules. Plain terminology only, no banned words.
function HowTo() {
  const lines: Array<[string, string]> = [
    ['BAND', 'Turn the knob to size your price band. Tighter pays more.'],
    ['PLAY', 'Locks the band around the live price.'],
    ['WIN', 'Land inside the band at the buzzer to win stake × multiple.'],
    ['CASH OUT', 'Take the live value any time before the buzzer.'],
  ]
  return (
    <ScreenOverlay title="How to play">
      <div className="flex w-full flex-col gap-4">
        {lines.map(([k, v]) => (
          <div key={k}>
            <div className="font-mono text-[16px] font-bold uppercase tracking-[0.12em] text-text">
              {k}
            </div>
            <div className="mt-1 text-[15px] leading-snug text-text-2">{v}</div>
          </div>
        ))}
      </div>
    </ScreenOverlay>
  )
}
