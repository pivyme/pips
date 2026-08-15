import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import NumberFlow from '@number-flow/react'
import toast from 'react-hot-toast'
import type { ChartOverlays } from '@/components/game/Chart'
import { Chart } from '@/components/game/Chart'
import { GameLeaderboardOverlay } from '@/components/game/GameLeaderboardOverlay'
import { FooterStatusPanel, InstructionOverlay, LiveVerdictPanel, ResultOverlay } from '@/components/game/gamePanels'
import { GameScreen, ScreenMessage, SCREEN_STATES, Cell } from '@/components/game/screen'
import { LivePrice } from '@/components/game/LivePrice'
import { useConsoleControls } from '@/components/console/controls'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { useLiveMarkets } from '@/hooks/useLiveMarkets'
import {
  mergeSnapshotMarket,
  usePhaseElapsed,
  usePlayResolutionWatch,
  useRestoreOpenPlay,
  useRoundCountdown,
} from '@/hooks/useGameRound'
import { haptic, hapticPattern } from '@/lib/haptics'
// Aliased: this file already destructures a `track` from useActivePlay (the open-round tracker).
import { track as trackEvent, trackSettled } from '@/lib/track'
import { sound } from '@/lib/sound'
import { api, type PinModel, type PlayDTO, type PlayStatus } from '@/lib/api'
import { cashOut, placePlay } from '@/lib/sui/predict'
import { betLadder } from '@/lib/sui/config'
import { errorCode, toastError } from '@/lib/errors'
import { useLabGate } from '@/lib/lab'
import { useTopUp } from '@/lib/chipGrant'
import { useAuth } from '@/lib/auth'
import { useActivePlay } from '@/lib/activePlay'
import { cnm } from '@/utils/style'
import { formatExactDecimal, formatStringToNumericDecimals } from '@/utils/format'

// PIN: name the price. The knob scrubs a pin up and down the price axis, A2 picks how much slack sits
// around it, PLAY mints one real Predict range at (pin - window, pin + window]. Binary payout: you are in
// the box at the buzzer or you are not. The miss distance is the story and the ranking, never the money.
// Design: docs/games-ideation/CONCEPTS.md §3. ADMIN-only lab game, the server answers 404 for anyone else.
export const Route = createFileRoute('/_app/games/pin')({ component: PinScreen })

const STAKE_KEY = 'pips_stake_idx' // shared with Lucky + Range + Moonshot so the chip stays put across screens
const WINDOW_KEY = 'pips_pin_window'
const DEFAULT_WINDOW_IDX = 1

// The pin ladder: clicks from spot to the edge of the usable range, per side. The curve makes the steps
// fine near spot and coarse far out, so the whole mintable range is a few clicks (CONTROLS rule 2).
const PIN_HALF_STEPS = 10
const PIN_STEPS = PIN_HALF_STEPS * 2 + 1
const PIN_CENTER = PIN_HALF_STEPS
const PIN_CURVE = 1.6

// Cold start only, until the server model lands. sigmaMult is z((1+p)/2) and travelSigma the server's solved
// reach for each window; both are fixed, annualVol is a seed the real model overwrites within a fetch.
const FALLBACK_MODEL: Pick<PinModel, 'annualVol' | 'windows'> = {
  annualVol: 0.2,
  windows: [
    { tier: 0, prob: 0.5, sigmaMult: 0.6745, travelSigma: 1.27, halfPct: 0 },
    { tier: 1, prob: 0.28, sigmaMult: 0.3585, travelSigma: 1.08, halfPct: 0 },
    { tier: 2, prob: 0.14, sigmaMult: 0.1764, travelSigma: 0.88, halfPct: 0 },
    { tier: 3, prob: 0.07, sigmaMult: 0.0878, travelSigma: 0.65, halfPct: 0 },
  ],
}

const SECONDS_PER_YEAR = 365.25 * 24 * 3600
const NOMINAL_ROUND_SEC = 30
const RESULT_MS = 7000
// Cash-out safety window: a redeem submitted this late may land after the oracle expires, so cash-out disarms
// and the round auto-settles. Not a verdict, just a closed window (mirrors Range and Moonshot).
const SETTLE_LOCK_MS = 5000
const CASHOUT_SETTLE_MS = 1100
const SETTLE_EXPECT_MS = 12000
const WATCHDOG_MS = 3000
// The estimate's haircut, matching the server's REAL_RANGE_QUOTE_HAIRCUT so the two agree before the snap.
const QUOTE_HAIRCUT = 0.04
const MAX_WIN_PROB = 0.85 // the server's REAL_RANGE_MAX_PROB; the estimate may not promise better odds than it mints
const TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out', 'error'])
const RESULT_TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out'])

type Phase = 'idle' | 'placing' | 'open' | 'cashing' | 'result'
type Live = { markValue: string; pnl: string; multiplier: number; entryValue?: string; maxPayout?: string; status: PlayStatus }
type Overlay = 'none' | 'howto' | 'board'

// Abramowitz-Stegun normal CDF, the same approximation the server prices the estimate with, so the number on
// screen before the mint is the same number the server would have quoted.
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2)
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return x >= 0 ? 1 - p : p
}

// The dollar offset a ladder index sits at, given the round's usable travel.
function pinOffsetUsd(idx: number, travelUsd: number): number {
  const k = (idx - PIN_CENTER) / PIN_HALF_STEPS
  return Math.sign(k) * Math.abs(k) ** PIN_CURVE * travelUsd
}

// The inverse, so switching window keeps the named price instead of teleporting the pin: each window solves
// its own reach, so the same ladder index means a different price under a different window.
function pinIdxForOffset(offsetUsd: number, travelUsd: number): number {
  if (!(travelUsd > 0)) return PIN_CENTER
  const k = Math.min(1, Math.abs(offsetUsd) / travelUsd) ** (1 / PIN_CURVE)
  return Math.max(0, Math.min(PIN_STEPS - 1, Math.round(PIN_CENTER + Math.sign(offsetUsd) * k * PIN_HALF_STEPS)))
}

const fmtPrice = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 0 })
const UsdFlow = ({ value }: { value: number }) => (
  <NumberFlow value={value} prefix="$" format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} />
)

function PinScreen() {
  const isLabUser = useLabGate()

  useEffect(() => {
    trackEvent('game.open', { game: 'pin' })
  }, [])

  const { refresh, user } = useAuth()
  const qc = useQueryClient()
  const { track } = useActivePlay()

  const [stakeIdx, setStakeIdx] = useLocalStorage(STAKE_KEY, 2)
  const [windowIdx, setWindowIdx] = useLocalStorage(WINDOW_KEY, DEFAULT_WINDOW_IDX)
  const [pinIdx, setPinIdx] = useState(PIN_CENTER)
  // Captured the first time the knob moves: from then on the pin is a PRICE the player named and it holds
  // still while the market moves under it. Untouched, it rides spot, so PLAY without turning is "name now".
  // The sigma is captured with it, so the ladder does not slide under the thumb as the clock decays the round.
  const [anchor, setAnchor] = useState<{ price: number; sigmaFrac: number } | null>(null)

  const [phase, setPhase] = useState<Phase>('idle')
  const [play, setPlay] = useState<PlayDTO | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [spot, setSpot] = useState<number | null>(null)
  const [overlay, setOverlay] = useState<Overlay>('none')
  const [lockPrice, setLockPrice] = useState<string | null>(null)
  const [inBox, setInBox] = useState<boolean | null>(null)

  const finalized = useRef(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const balanceSyncedPlayId = useRef<string | null>(null)
  const livePriceRef = useRef(0)
  const inBoxRef = useRef<boolean | null>(null)
  const wasInBox = useRef<boolean | null>(null)
  const lastCrossRef = useRef(0)

  const { noLiveMarket, playsPaused, isLoading: marketsLoading, isError: marketsError } = useLiveMarkets()
  const statsQ = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() })
  const streak = statsQ.data?.stats.currentStreak ?? 0

  // The round model: the calibrated vol, the pin's usable travel, and the window ladder. Light cadence, and
  // the client decays the widths off expiryMs between fetches so the box breathes with the clock.
  const modelQ = useQuery({
    queryKey: ['pinModel'],
    queryFn: () => api.pinModel(),
    enabled: isLabUser,
    placeholderData: (prev) => prev,
    staleTime: 4_000,
    refetchInterval: 5_000,
    retry: false,
  })
  const model = modelQ.data ?? null
  const windows = model?.windows ?? FALLBACK_MODEL.windows
  const annualVol = model?.annualVol ?? FALLBACK_MODEL.annualVol

  const winIdx = Math.max(0, Math.min(windows.length - 1, windowIdx))
  const win = windows[winIdx]

  // Sigma for the round the next tap would land in. Decays with the clock, which is what makes the box
  // narrow as the buzzer approaches instead of sitting at its quoted width.
  const secondsToExpiry = model ? Math.max(1, (model.expiryMs - Date.now()) / 1000) : NOMINAL_ROUND_SEC
  const sigmaFrac = annualVol * Math.sqrt(secondsToExpiry / SECONDS_PER_YEAR)
  const halfFrac = win.sigmaMult * sigmaFrac

  const STAKE_LADDER = betLadder()
  const balance = parseFloat(user?.balance ?? '0') || 0
  const maxBetIdx = Math.max(0, STAKE_LADDER.reduce((acc, v, i) => (v <= balance ? i : acc), 0))
  const safeBetIdx = Math.min(stakeIdx, maxBetIdx)
  const stake = STAKE_LADDER[safeBetIdx]
  const cantAfford = balance < STAKE_LADDER[0]

  const asset = 'BTC'
  const canPlay = !noLiveMarket

  // The pin: spot while untouched, otherwise the price the player parked. Snapped to the dollar, which is
  // both the admission grid and the way anyone actually says a price out loud. The ladder maps through the
  // anchor's sigma so a named price holds still; reach is per window, since a tight band planted far out
  // prices under the chain's admission floor.
  const travelUsd = anchor ? anchor.price * win.travelSigma * anchor.sigmaFrac : 0
  const liveTravelUsd = (spot ?? 0) * win.travelSigma * sigmaFrac
  const livePin = anchor ? anchor.price + pinOffsetUsd(pinIdx, travelUsd) : (spot ?? 0)
  const pin = Math.round(livePin)
  const halfUsd = (spot ?? pin) * halfFrac
  const boxLower = pin - halfUsd
  const boxUpper = pin + halfUsd

  // The estimate, and it is only ever an estimate: there is no readable per-band ask, so this is the same
  // analytic the server quotes with, and the real multiple snaps off OrderMinted the moment the mint lands.
  const estMultiple = (() => {
    if (!spot || spot <= 0 || sigmaFrac <= 0) return null
    const d = (pin - spot) / spot
    const p = Math.min(MAX_WIN_PROB, Math.max(0.005, normCdf((d + halfFrac) / sigmaFrac) - normCdf((d - halfFrac) / sigmaFrac)))
    return Math.max(1.01, (1 / p) * (1 - QUOTE_HAIRCUT))
  })()
  // Measured against the LIVE spot, not the anchor: a named price the market has since walked away from is
  // one the server would clamp back on resolve, so say so rather than quoting a number it would not mint.
  const pinOutOfReach = spot != null && liveTravelUsd > 0 && Math.abs(pin - spot) > liveTravelUsd * 1.02

  const roundLive = phase === 'open' || phase === 'cashing'
  const showReadouts = play != null && roundLive
  const status = live?.status ?? play?.status
  const positioned = status != null && status !== 'error'
  const multiplier = live?.multiplier ?? play?.multiplier ?? 0

  const playLower = play?.market.lower ? parseFloat(play.market.lower) : undefined
  const playUpper = play?.market.upper ? parseFloat(play.market.upper) : undefined
  const playPin = play?.market.strike ? parseFloat(play.market.strike) : undefined
  const entrySpotNum = play?.entrySpot ? parseFloat(play.entrySpot) : NaN
  const entryVal = Number.isFinite(entrySpotNum) && entrySpotNum > 0 ? entrySpotNum : null

  const { secsLeft, remainingMs, settleMs } = useRoundCountdown({
    enabled: phase === 'open',
    play,
    fallbackDurationSec: NOMINAL_ROUND_SEC,
  })
  const cashMs = usePhaseElapsed(phase === 'cashing')

  const confirmed = live?.status === 'open'
  const opening = phase === 'open' && (live?.status === 'pending' || remainingMs == null)
  const settling = phase === 'open' && remainingMs != null && remainingMs <= 0
  const sealing = phase === 'open' && confirmed && remainingMs != null && remainingMs > 0 && remainingMs <= SETTLE_LOCK_MS
  const liveHold = phase === 'open' && confirmed && remainingMs != null && remainingMs > SETTLE_LOCK_MS
  const cashing = phase === 'cashing'
  const settleSecs = Math.floor(settleMs / 1000)

  const lockNum = lockPrice ? parseFloat(lockPrice) : null
  const settleLine = settling && lockNum != null && lockNum > 0 ? lockNum : undefined

  // The box is the whole screen: the real minted band once there is a position, the scrubbed preview before.
  const roundOverlayOn = positioned && (phase === 'open' || phase === 'cashing' || phase === 'result')
  const overlays: ChartOverlays | undefined =
    roundOverlayOn && playLower != null && playUpper != null
      ? {
          ...(entryVal != null ? { entry: entryVal } : {}),
          band: { lower: playLower, upper: playUpper, locked: true, sealed: settling, confirming: live?.status === 'pending' },
          ...(settleLine != null ? { settle: settleLine } : {}),
        }
      : (phase === 'idle' || phase === 'placing') && spot != null && halfUsd > 0
        ? { band: { lower: boxLower, upper: boxUpper, locked: true } }
        : undefined

  const clearResetTimer = () => {
    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = null
  }

  const finishResult = useCallback(
    (final: PlayDTO) => {
      finalized.current = true
      setPlay(final)
      setLive({
        markValue: final.markValue,
        pnl: final.pnl,
        multiplier: final.multiplier,
        entryValue: final.entryValue,
        maxPayout: final.maxPayout,
        status: final.status,
      })
      setPhase('result')
      hapticPattern(final.status === 'lost' ? 'lose' : final.status === 'cashed_out' ? 'cashOut' : 'win')
      sound(final.status === 'lost' ? 'lose' : 'win')
      if (final.status === 'cashed_out') trackEvent('game.cashout_done', { game: 'pin', pnl: final.pnl ?? '0' })
      else trackEvent('game.settled', { game: 'pin', result: final.status, pnl: final.pnl ?? '0' })
      void refresh()
      for (const key of ['stats', 'achievements', 'plays']) void qc.invalidateQueries({ queryKey: [key] })
      clearResetTimer()
      resetTimer.current = setTimeout(() => setPhase('idle'), RESULT_MS)
    },
    [refresh, qc],
  )

  const resolveTerminal = useCallback(
    (s: PlayStatus, playId: string) => {
      if (finalized.current) return
      if (s === 'error') {
        finalized.current = true
        toast.error('Could not open that pin. Your chips are safe, name it again.', { id: 'pin-play-error' })
        clearResetTimer()
        setPlay(null)
        setLive(null)
        setPhase('idle')
        return
      }
      if (RESULT_TERMINAL.has(s)) {
        finalized.current = true
        void api
          .getPlay(playId)
          .then(({ play: final }) => finishResult(final))
          .catch(() => setPhase('idle'))
      }
    },
    [finishResult],
  )

  usePlayResolutionWatch({
    enabled: phase === 'open',
    playId: play?.id,
    finalizedRef: finalized,
    watchdogMs: WATCHDOG_MS,
    syncedOpenPlayIdRef: balanceSyncedPlayId,
    refreshOnOpen: refresh,
    onSnapshot: (snapshot) => {
      setLive({
        markValue: snapshot.markValue,
        pnl: snapshot.pnl,
        multiplier: snapshot.multiplier,
        entryValue: snapshot.entryValue,
        maxPayout: snapshot.maxPayout,
        status: snapshot.status,
      })
      setLockPrice(snapshot.lockPrice ?? null)
      setPlay((cur) => (cur ? mergeSnapshotMarket(cur, snapshot) : cur))
    },
    onTerminal: resolveTerminal,
  })

  useEffect(() => () => clearResetTimer(), [])

  const restoreOpenPlay = useCallback(
    (p: PlayDTO) => {
      finalized.current = false
      setLockPrice(null)
      setPlay(p)
      setLive({
        markValue: p.markValue,
        pnl: p.pnl,
        multiplier: p.multiplier,
        entryValue: p.entryValue,
        maxPayout: p.maxPayout,
        status: p.status,
      })
      setPhase('open')
      track({ id: p.id, game: 'pin' })
      trackEvent('game.restore', { game: 'pin' })
    },
    [track],
  )
  const { restorePending } = useRestoreOpenPlay({
    game: 'pin',
    active: phase !== 'idle',
    fallbackDurationSec: NOMINAL_ROUND_SEC,
    onRestore: restoreOpenPlay,
  })

  // Live in/out off the 60fps chart line, so "if it ends now" swings with the price like Range's band. A light
  // tick on each crossing, gated so a price sitting on the edge cannot buzz continuously.
  useEffect(() => {
    if (!liveHold || playLower == null || playUpper == null) {
      inBoxRef.current = null
      wasInBox.current = null
      setInBox(null)
      return
    }
    let raf = 0
    const loop = () => {
      const p = livePriceRef.current
      const now = p > 0 ? p > playLower && p <= playUpper : null
      if (now !== inBoxRef.current) {
        inBoxRef.current = now
        if (wasInBox.current != null && wasInBox.current !== now) {
          const t = performance.now()
          if (t - lastCrossRef.current > 400) {
            lastCrossRef.current = t
            haptic('low')
          }
        }
        wasInBox.current = now
        setInBox(now)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [liveHold, playLower, playUpper])

  const doPlay = useCallback(async () => {
    if (phase !== 'idle' || restorePending) return
    if (playsPaused) {
      trackEvent('friction.sponsor_paused', { game: 'pin' })
      toast.error('Plays paused while we top up. Back in a moment.', { id: 'paused' })
      return
    }
    if (!canPlay || !spot) {
      toast.error('No game running right now. Try again in a sec.', { id: 'no-market' })
      return
    }
    clearResetTimer()
    finalized.current = false
    setLockPrice(null)
    setOverlay('none')
    setPhase('placing')
    haptic('rigid')
    trackEvent('game.play_tap', { game: 'pin', stake, tier: `w${winIdx}` })
    const tapAt = Date.now()
    try {
      const { play: p } = await placePlay('pin', { stake, asset, pin, window: winIdx })
      setPlay(p)
      track({ id: p.id, game: 'pin' })
      trackEvent('game.play_open', { game: 'pin', latencyms: Date.now() - tapAt })
      setLive({
        markValue: p.markValue,
        pnl: p.pnl,
        multiplier: p.multiplier,
        entryValue: p.entryValue,
        maxPayout: p.maxPayout,
        status: p.status,
      })
      haptic('heavy')
      setPhase('open')
    } catch (e) {
      trackEvent('game.play_error', { game: 'pin', code: errorCode(e) })
      toastError(e)
      setPhase('idle')
    }
  }, [phase, canPlay, spot, stake, pin, winIdx, playsPaused, track, restorePending])

  const doCashOut = useCallback(async () => {
    if (!liveHold || !play) return
    trackEvent('game.cashout_tap', { game: 'pin' })
    setPhase('cashing')
    const started = Date.now()
    try {
      const { play: p } = await cashOut(play.id)
      const wait = CASHOUT_SETTLE_MS - (Date.now() - started)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      finishResult(p)
    } catch (e) {
      // The buzzer may have beaten the cash-out. Reconcile against the chain before complaining.
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

  const dismissResult = useCallback(() => {
    clearResetTimer()
    // A finished round hands the pin back to the market, so the next one starts at "now" again.
    setAnchor(null)
    setPinIdx(PIN_CENTER)
    setPhase('idle')
  }, [])

  const topUp = useTopUp()
  const goTopUp = useCallback(() => void topUp(), [topUp])

  // The knob is the game. First turn captures the anchor, so from then on the pin is a price that holds
  // still while the market moves under it.
  const movePin = useCallback(
    (next: number) => {
      if (!anchor && spot != null && spot > 0) setAnchor({ price: spot, sigmaFrac })
      setPinIdx(Math.max(0, Math.min(PIN_STEPS - 1, next)))
    },
    [anchor, spot, sigmaFrac],
  )

  // Each window has its own reach, so the ladder index has to be re-derived rather than carried over: keep the
  // named price where the next window can still reach it, and pull it to that window's edge where it cannot.
  const cycleWindow = useCallback(() => {
    if (phase !== 'idle' && phase !== 'placing') return
    const from = windows[winIdx]
    const to = windows[(winIdx + 1) % windows.length]
    if (anchor && from && to) {
      const held = pinOffsetUsd(pinIdx, anchor.price * from.travelSigma * anchor.sigmaFrac)
      setPinIdx(pinIdxForOffset(held, anchor.price * to.travelSigma * anchor.sigmaFrac))
    }
    setWindowIdx((i) => (i + 1) % windows.length)
  }, [phase, setWindowIdx, windows, winIdx, anchor, pinIdx])

  const rotateInfo = useCallback(() => {
    setOverlay((o) => (o === 'none' ? 'howto' : o === 'howto' ? 'board' : 'none'))
  }, [])
  const infoLabel = overlay === 'none' ? 'HOW TO' : overlay === 'howto' ? 'RANKS' : 'GAME'

  const isResult = phase === 'result'
  const resultPositive = isResult && play != null && (play.status === 'won' || (play.status === 'cashed_out' && parseFloat(play.pnl ?? '0') >= 0))
  const resultColor: 'up' | 'down' = resultPositive ? 'up' : 'down'
  const windowLabel = `±$${fmtPrice(Math.max(1, Math.round(halfUsd)))}`

  useConsoleControls({
    knob: {
      label: 'PIN',
      min: 0,
      max: PIN_STEPS - 1,
      step: 1,
      value: pinIdx,
      onChange: (v: number) => {
        movePin(v)
        trackSettled('game.knob_change', { game: 'pin', tier: String(v - PIN_CENTER) })
      },
      format: () => fmtPrice(pin),
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
    // The window breathes on the chart as you press it. Locked once a position is riding: the band is minted.
    action2: isResult
      ? { label: '', color: resultColor, onPress: dismissResult, pulse: true }
      : { label: windowLabel, color: 'neutral', onPress: cycleWindow },
    main: isResult
      ? { label: 'CONTINUE', color: 'amber', onPress: dismissResult }
      : settling
        ? { label: 'SETTLING', color: 'amber', onPress: () => {}, loading: true }
        : sealing
          ? { label: 'FINAL', color: 'amber', onPress: () => {}, loading: true }
          : liveHold
            ? { label: 'CASH OUT', color: 'up', onPress: () => void doCashOut() }
            : opening
              ? { label: 'OPENING', color: 'up', onPress: () => {}, loading: true }
              : cashing
                ? { label: 'CASHING OUT', color: 'up', onPress: () => {}, loading: true }
                : phase === 'placing'
                  ? { label: 'PINNING', color: 'amber', onPress: () => {}, loading: true }
                  : cantAfford
                    ? { label: 'TOP UP', color: 'amber', onPress: goTopUp }
                    : { label: 'PLAY', color: 'amber', onPress: () => void doPlay() },
  })

  if (!isLabUser) return null

  const firstRun = !statsQ.isLoading && (statsQ.data?.stats.gamesPlayed ?? 0) === 0
  const recap = `${asset} · ${fmtPrice(playPin ?? pin)} · ${windowLabel}`
  const settledPrice = play?.settlePrice ? parseFloat(play.settlePrice) : null
  const missBy = settledPrice != null && playPin != null ? Math.abs(settledPrice - playPin) : null

  return (
    <GameScreen>
      {marketsLoading ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="shimmer h-24 w-2/3" />
        </div>
      ) : marketsError ? (
        <ScreenMessage {...SCREEN_STATES.marketsError} />
      ) : playsPaused && phase === 'idle' ? (
        <ScreenMessage {...SCREEN_STATES.playsPaused} />
      ) : noLiveMarket ? (
        <ScreenMessage {...SCREEN_STATES.noMarket} />
      ) : (
        <div className="relative flex h-full flex-col">
          {/* HEADER — market + live price (left), balance / expiry countdown (right). */}
          <div className="shrink-0 border-b border-line-strong bg-black pt-[calc(var(--screen-rim,24px)+12px)]">
            <div className="flex items-start justify-between gap-3 px-[var(--screen-rim,24px)] pb-4">
              <div className="min-w-0">
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-text-3">Pin · {asset}</div>
                <div className="tnum text-[34px] font-extrabold leading-none text-text">
                  <LivePrice price={spot} />
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                  {sealing || settling ? 'Final' : showReadouts && secsLeft != null ? 'Ends in' : 'Available'}
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

          {/* CHART — the box around the pin is the whole picture. */}
          <div className="relative min-h-0 flex-1">
            {showReadouts && secsLeft != null && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
                <span className="tnum font-black leading-none text-text opacity-15 text-[clamp(64px,18vh,128px)]">{secsLeft}</span>
              </div>
            )}
            <Chart asset={asset} overlays={overlays} livePriceRef={livePriceRef} onPrice={(p) => setSpot(p)} frozen={settling} className="absolute inset-0" />
          </div>

          {/* FOOTER — full-width readout band, left-only (clear of the knob + PLAY body). */}
          <div className="shrink-0 border-t border-line-strong bg-black px-[var(--screen-rim,24px)] pb-[var(--screen-rim,24px)] pt-3.5 min-h-[var(--screen-notch,21%)]">
            <div className="max-w-[60%]">
              {phase === 'placing' ? (
                <FooterStatusPanel kicker="Planting" head="PINNING" recap={recap} sweep />
              ) : opening ? (
                <FooterStatusPanel kicker="Opening" head="OPENING" recap={recap} sweep />
              ) : settling ? (
                <FooterStatusPanel kicker={`Settling · ${settleSecs}s`} head="SETTLING" recap={recap} progress={Math.min(94, (settleMs / SETTLE_EXPECT_MS) * 100)} />
              ) : sealing ? (
                <FooterStatusPanel
                  kicker={`Cash out closed · settles in ${secsLeft ?? 0}s`}
                  head="FINAL SECONDS"
                  recap={recap}
                  progress={Math.min(96, ((SETTLE_LOCK_MS - (remainingMs ?? 0)) / SETTLE_LOCK_MS) * 100)}
                />
              ) : cashing ? (
                <FooterStatusPanel kicker="Cashing out" head="CASHING OUT" tone="up" recap={recap} progress={Math.min(92, (cashMs / CASHOUT_SETTLE_MS) * 100)} />
              ) : showReadouts ? (
                <>
                  <div className="flex items-center gap-2">
                    <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">If it ends now</div>
                    {inBox != null && (
                      <span
                        className={cnm(
                          'inline-flex items-center border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.1em]',
                          inBox ? 'border-up/60 text-up' : 'border-down/60 text-down',
                        )}
                      >
                        {inBox ? 'In the box' : 'Outside'}
                      </span>
                    )}
                  </div>
                  <LiveVerdictPanel winning={inBox} payout={live?.maxPayout ?? play?.maxPayout ?? '0'} cashoutPnl={live?.pnl ?? play?.pnl ?? '0'} />
                  <div className="mt-2.5 grid grid-cols-3 gap-x-3">
                    <Cell label="Pin" value={fmtPrice(playPin ?? pin)} />
                    <Cell label="Mult" value={`${multiplier.toFixed(2)}x`} />
                    <Cell label="Win" value={`$${formatExactDecimal(live?.maxPayout ?? play?.maxPayout ?? '0')}`} />
                  </div>
                </>
              ) : firstRun ? (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Welcome</div>
                  <div className="text-[22px] font-extrabold uppercase leading-none tracking-[0.02em] text-text">Pin</div>
                  <div className="mt-2.5 font-mono text-[11px] font-semibold uppercase leading-snug tracking-[0.08em] text-text-2">
                    Turn the knob to name a price, then <span className="text-brand-500">PLAY</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Your pin</div>
                  <div className="flex items-baseline gap-2">
                    <span className="tnum text-[40px] font-extrabold leading-none text-brand-500">{fmtPrice(pin)}</span>
                    <span className="font-mono text-[13px] font-bold uppercase tracking-[0.08em] text-text-2">{windowLabel}</span>
                  </div>
                  <div className="mt-2.5 grid grid-cols-3 gap-x-3">
                    <Cell label="Cost" value={`$${stake}`} />
                    <Cell
                      label="Pays est"
                      value={pinOutOfReach || estMultiple == null ? '—' : `${estMultiple.toFixed(2)}x`}
                    />
                    <Cell label="Win est" value={estMultiple == null ? '—' : <UsdFlow value={stake * estMultiple} />} />
                  </div>
                  <div className="mt-2.5 font-mono text-[11px] font-semibold uppercase leading-snug tracking-[0.08em] text-text-2">
                    {pinOutOfReach ? (
                      <span className="text-down">Too far out, the round cannot price it</span>
                    ) : (
                      <>
                        One mint · <span className="text-text-3">est snaps on mint</span>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {phase === 'result' && play && (
        <ResultOverlay
          play={play}
          streak={streak}
          winTitle="IN THE BOX"
          cashoutTitle="CASHED OUT"
          loseTitle="MISSED"
          detail={
            missBy != null && settledPrice != null ? (
              <div className="mt-2 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-text-2">
                <div>
                  Pin {fmtPrice(playPin ?? 0)} · Actual {fmtPrice(settledPrice)}
                </div>
                <div className="mt-1 text-text-3">Off by ${missBy.toFixed(2)}</div>
              </div>
            ) : null
          }
        />
      )}
      {overlay === 'howto' && (
        <InstructionOverlay
          compact
          lines={[
            ['PIN', 'Turn the knob to name a price. It holds still while the market moves under it.'],
            ['WINDOW', 'Right button sets the slack around your pin. Tighter pays more.'],
            ['WIN', 'End inside the box at the buzzer and you win. Closer does not pay more.'],
            ['CASH OUT', 'Take the live value any time before the buzzer.'],
          ]}
        />
      )}
      {overlay === 'board' && <GameLeaderboardOverlay game="pin" title="Pin" />}
    </GameScreen>
  )
}
