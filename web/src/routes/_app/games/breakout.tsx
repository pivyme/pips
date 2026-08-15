import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
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
import { api, type BreakoutRung, type PlayDTO, type PlayStatus } from '@/lib/api'
import { cashOut, placePlay } from '@/lib/sui/predict'
import { betLadder } from '@/lib/sui/config'
import { errorCode, toastError } from '@/lib/errors'
import { useLabGate } from '@/lib/lab'
import { useTopUp } from '@/lib/chipGrant'
import { useAuth } from '@/lib/auth'
import { useActivePlay } from '@/lib/activePlay'
import { cnm } from '@/utils/style'
import { formatExactDecimal, formatStringToNumericDecimals } from '@/utils/format'

// BREAKOUT: the only game here that does not ask which way. It asks WHETHER. Two binaries mint in ONE PTB,
// an up above spot and a down below it, so both land or neither does and you are never left holding half a
// play. A flat market is the enemy, which inverts the emotional polarity of everything else in the product.
// Design: docs/games-ideation/CONCEPTS.md §2. ADMIN-only lab game, the server answers 404 for anyone else.
export const Route = createFileRoute('/_app/games/breakout')({ component: BreakoutScreen })

const STAKE_KEY = 'pips_stake_idx' // shared with the other games so the chip stays put across screens
const BREAK_KEY = 'pips_breakout_break'
const LEAN_KEY = 'pips_breakout_lean'

const SECONDS_PER_YEAR = 365.25 * 24 * 3600
const NOMINAL_ROUND_SEC = 40
const RESULT_MS = 6000
const SETTLE_LOCK_MS = 5000
const CASHOUT_SETTLE_MS = 1100
const SETTLE_EXPECT_MS = 12000
const WATCHDOG_MS = 3000
const TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out', 'error'])
const RESULT_TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out'])

const LEANS = [0, 1, -1] as const
const LEAN_LABEL: Record<number, string> = { 0: 'EVEN', 1: 'LEAN ▲', [-1]: 'LEAN ▼' }

// Cold start only, until the server model lands, so the knob has something coherent to move before the first
// fetch. Every rung it draws is replaced by the server's own ladder, which is what the mint is sized from.
const FALLBACK_RUNGS: BreakoutRung[] = [0.26, 0.19, 0.14, 0.1, 0.07, 0.05].flatMap((base, i) =>
  LEANS.map((lean) => {
    const skew = lean > 0 ? 1.4 : lean < 0 ? 1 / 1.4 : 1
    const leg = (p: number) => ({ prob: p, sigmaMult: Math.max(0.3, 1 / Math.sqrt(p)) })
    return { break: i, lean, up: leg(Math.min(0.38, base * skew)), down: leg(Math.min(0.38, base / skew)) }
  }),
)

type Phase = 'idle' | 'placing' | 'open' | 'cashing' | 'result'
type Live = { markValue: string; pnl: string; multiplier: number; entryValue?: string; maxPayout?: string; status: PlayStatus }
type Overlay = 'none' | 'howto' | 'board'

const fmtPrice = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 0 })

function BreakoutScreen() {
  const isLabUser = useLabGate()

  useEffect(() => {
    trackEvent('game.open', { game: 'breakout' })
  }, [])

  const { refresh, user } = useAuth()
  const qc = useQueryClient()
  const { track } = useActivePlay()

  const [stakeIdx, setStakeIdx] = useLocalStorage(STAKE_KEY, 2)
  const [breakIdx, setBreakIdx] = useLocalStorage(BREAK_KEY, 1)
  const [leanIdx, setLeanIdx] = useLocalStorage(LEAN_KEY, 0)

  const [phase, setPhase] = useState<Phase>('idle')
  const [play, setPlay] = useState<PlayDTO | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [spot, setSpot] = useState<number | null>(null)
  const [overlay, setOverlay] = useState<Overlay>('none')
  const [lockPrice, setLockPrice] = useState<string | null>(null)
  const [broken, setBroken] = useState<boolean | null>(null)

  const finalized = useRef(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const balanceSyncedPlayId = useRef<string | null>(null)
  const livePriceRef = useRef(0)
  const brokenRef = useRef<boolean | null>(null)
  const wasBroken = useRef<boolean | null>(null)
  const lastCrossRef = useRef(0)

  const { noLiveMarket, playsPaused, isLoading: marketsLoading, isError: marketsError } = useLiveMarkets()
  const statsQ = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() })
  const streak = statsQ.data?.stats.currentStreak ?? 0

  const modelQ = useQuery({
    queryKey: ['breakoutModel'],
    queryFn: () => api.breakoutModel(),
    enabled: isLabUser,
    placeholderData: (prev) => prev,
    staleTime: 4_000,
    refetchInterval: 5_000,
    retry: false,
  })
  const model = modelQ.data ?? null
  const rungs = model?.rungs?.length ? model.rungs : FALLBACK_RUNGS
  const annualVol = model?.annualVol ?? 0.2
  const admissionTick = model?.admissionTick ?? 1
  const legs = model?.legs ?? 2

  const breakSteps = Math.max(1, new Set(rungs.map((r) => r.break)).size)
  const lean = LEANS[Math.max(0, Math.min(LEANS.length - 1, leanIdx))]
  const safeBreakIdx = Math.max(0, Math.min(breakSteps - 1, breakIdx))
  const rung = rungs.find((r) => r.break === safeBreakIdx && r.lean === lean) ?? rungs[0]

  // The zones tighten as the clock runs off, so the walls are re-solved every tick rather than on the refetch.
  const [nowMs, setNowMs] = useState(() => Date.now())
  const between = phase === 'idle' || phase === 'placing'
  useEffect(() => {
    if (!between) return
    const id = setInterval(() => setNowMs(Date.now()), 250)
    return () => clearInterval(id)
  }, [between])

  const secondsToExpiry = model ? Math.max(1, (model.expiryMs - nowMs) / 1000) : NOMINAL_ROUND_SEC
  const sigmaFrac = annualVol * Math.sqrt(secondsToExpiry / SECONDS_PER_YEAR)
  const shotSecs = model ? Math.max(0, Math.ceil((model.expiryMs - nowMs) / 1000)) : null

  const STAKE_LADDER = betLadder()
  const balance = parseFloat(user?.balance ?? '0') || 0
  // Both legs come out of the same balance, so affordability is against the TOTAL, not one leg's chip.
  const maxBetIdx = Math.max(0, STAKE_LADDER.reduce((acc, v, i) => (v * legs <= balance ? i : acc), 0))
  const safeBetIdx = Math.min(stakeIdx, maxBetIdx)
  const legStake = STAKE_LADDER[safeBetIdx]
  const totalStake = legStake * legs
  const cantAfford = balance < STAKE_LADDER[0] * legs

  const asset = 'BTC'
  const canPlay = !noLiveMarket

  // Where the two walls sit right now. Snapped to the $1 admission grid away from the winning side, the way
  // the server snaps them, so the drawn zone edge is the price that actually has to be crossed.
  const snap = (raw: number, side: 'up' | 'down') =>
    admissionTick * (side === 'up' ? Math.ceil(raw / admissionTick) : Math.floor(raw / admissionTick))
  const upWall = spot != null && rung ? snap(spot * (1 + rung.up.sigmaMult * sigmaFrac), 'up') : null
  const downWall = spot != null && rung ? snap(spot * (1 - rung.down.sigmaMult * sigmaFrac), 'down') : null
  const breakSize = upWall != null && downWall != null ? (upWall - downWall) / 2 : null

  // The pre-commit estimate. Only one leg can pay, so this is the SMALLER payout over the whole play's cost,
  // i.e. the floor a break is guaranteed to return. Tagged `est` and snapped from OrderMinted on mint (L-012).
  const estMultiple = rung ? Math.max(1.01, 1 / ((rung.up.prob + rung.down.prob) * 1.06)) : null
  const breakChance = rung ? rung.up.prob + rung.down.prob : null

  // The play's own walls once it is riding: params carries the pair, so the drawn zones are the minted ones.
  const playBand = play && 'lower' in play.params ? play.params : null
  const playUp = playBand ? parseFloat(playBand.upper) : null
  const playDown = playBand ? parseFloat(playBand.lower) : null
  const liveUp = playUp ?? upWall
  const liveDown = playDown ?? downWall

  const roundLive = phase === 'open' || phase === 'cashing'
  const showReadouts = play != null && roundLive
  const status = live?.status ?? play?.status
  const positioned = status != null && status !== 'error'
  const multiplier = live?.multiplier ?? play?.multiplier ?? 0

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

  // ESCAPE: how far the price still has to travel to clear the NEARER wall. Negative means it already has.
  const escape =
    spot != null && liveUp != null && liveDown != null ? Math.min(liveUp - spot, spot - liveDown) : null

  // Two directional lines, one per leg, each shading its own winning side. What is left unshaded between them
  // IS the dead zone, drawn by what the bet is rather than by a decorative box.
  const overlayOn = positioned && (phase === 'open' || phase === 'cashing' || phase === 'result')
  // No explicit state: `targets` already lights each line off the live price, which is the whole picture here.
  const zones = (up: number, down: number) => [
    { price: up, side: 'up' as const },
    { price: down, side: 'down' as const },
  ]
  const overlays: ChartOverlays | undefined =
    overlayOn && playUp != null && playDown != null
      ? {
          ...(entryVal != null ? { entry: entryVal } : {}),
          targets: zones(playUp, playDown),
          ...(settleLine != null ? { settle: settleLine } : {}),
        }
      : (phase === 'idle' || phase === 'placing') && upWall != null && downWall != null
        ? { targets: zones(upWall, downWall) }
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
      if (final.status === 'cashed_out') trackEvent('game.cashout_done', { game: 'breakout', pnl: final.pnl ?? '0' })
      else trackEvent('game.settled', { game: 'breakout', result: final.status, pnl: final.pnl ?? '0' })
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
        toast.error('That one did not land. Both legs are off and your chips are safe.', { id: 'breakout-play-error' })
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
      track({ id: p.id, game: 'breakout' })
      trackEvent('game.restore', { game: 'breakout' })
    },
    [track],
  )
  const { restorePending } = useRestoreOpenPlay({
    game: 'breakout',
    active: phase !== 'idle',
    fallbackDurationSec: NOMINAL_ROUND_SEC,
    onRestore: restoreOpenPlay,
  })

  // Escaped or not, off the 60fps chart price, with a tick on every crossing either way. This is the one
  // signal the game has: the moment the line leaves the dead zone, and the moment it crawls back in.
  useEffect(() => {
    if (!liveHold || playUp == null || playDown == null) {
      brokenRef.current = null
      wasBroken.current = null
      setBroken(null)
      return
    }
    let raf = 0
    const loop = () => {
      const p = livePriceRef.current
      const out = p > 0 ? p > playUp || p < playDown : null
      if (out !== brokenRef.current) {
        brokenRef.current = out
        if (wasBroken.current != null && wasBroken.current !== out) {
          const t = performance.now()
          if (t - lastCrossRef.current > 400) {
            lastCrossRef.current = t
            haptic(out ? 'rigid' : 'low')
          }
        }
        wasBroken.current = out
        setBroken(out)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [liveHold, playUp, playDown])

  const doPlay = useCallback(async () => {
    if (phase !== 'idle' || restorePending) return
    if (playsPaused) {
      trackEvent('friction.sponsor_paused', { game: 'breakout' })
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
    trackEvent('game.play_tap', { game: 'breakout', stake: totalStake, tier: `b${safeBreakIdx}l${lean}` })
    const tapAt = Date.now()
    try {
      // `stake` is the TOTAL: the server splits it across the legs and floors the play at 2 x MIN_STAKE.
      const { play: p } = await placePlay('breakout', { stake: totalStake, asset, break: safeBreakIdx, lean })
      setPlay(p)
      track({ id: p.id, game: 'breakout' })
      trackEvent('game.play_open', { game: 'breakout', latencyms: Date.now() - tapAt })
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
      trackEvent('game.play_error', { game: 'breakout', code: errorCode(e) })
      toastError(e)
      setPhase('idle')
    }
  }, [phase, canPlay, spot, totalStake, safeBreakIdx, lean, playsPaused, track, restorePending])

  const doCashOut = useCallback(async () => {
    if (!liveHold || !play) return
    trackEvent('game.cashout_tap', { game: 'breakout' })
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
    setPhase('idle')
  }, [])

  const topUp = useTopUp()
  const goTopUp = useCallback(() => void topUp(), [topUp])

  const armed = phase === 'idle' || phase === 'placing'
  // Both dials only move between rounds: the walls a play minted at are fixed on chain, so a control that
  // could still turn would be pretending to move a bet that cannot move.
  const moveBreak = useCallback(
    (next: number) => {
      if (!armed) return
      setBreakIdx(Math.max(0, Math.min(breakSteps - 1, next)))
    },
    [armed, breakSteps, setBreakIdx],
  )
  const cycleLean = useCallback(() => {
    if (!armed) return
    setLeanIdx((i) => (i + 1) % LEANS.length)
    haptic('selection')
    trackEvent('game.lean', { game: 'breakout', side: LEAN_LABEL[LEANS[(leanIdx + 1) % LEANS.length]] })
  }, [armed, leanIdx, setLeanIdx])

  const isResult = phase === 'result'
  const resultPositive = isResult && play != null && (play.status === 'won' || (play.status === 'cashed_out' && parseFloat(play.pnl ?? '0') >= 0))
  const resultColor: 'up' | 'down' = resultPositive ? 'up' : 'down'

  useConsoleControls({
    knob: {
      label: 'BREAK',
      min: 0,
      max: breakSteps - 1,
      step: 1,
      value: safeBreakIdx,
      onChange: (v: number) => {
        moveBreak(v)
        trackSettled('game.knob_change', { game: 'breakout', tier: String(v) })
      },
      format: () => (breakSize == null ? `±${safeBreakIdx + 1}` : `±$${Math.round(breakSize)}`),
    },
    numberWheel: {
      label: 'DUSDC',
      min: 0,
      max: maxBetIdx,
      step: 1,
      value: safeBetIdx,
      onChange: setStakeIdx,
      // The wheel picks ONE leg's chip and says so, because the play bills twice this.
      format: (v) => `$${STAKE_LADDER[Math.min(v, maxBetIdx)]}x${legs}`,
    },
    action1: isResult
      ? { label: '', color: resultColor, onPress: dismissResult, pulse: true }
      : {
          label: overlay === 'none' ? 'HOW TO' : overlay === 'howto' ? 'RANKS' : 'CLOSE',
          color: 'neutral',
          onPress: () => setOverlay((o) => (o === 'none' ? 'howto' : o === 'howto' ? 'board' : 'none')),
        },
    action2: isResult
      ? { label: '', color: resultColor, onPress: dismissResult, pulse: true }
      : { label: LEAN_LABEL[lean], color: 'neutral', onPress: cycleLean },
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
                  ? { label: 'ARMING', color: 'amber', onPress: () => {}, loading: true }
                  : cantAfford
                    ? { label: 'TOP UP', color: 'amber', onPress: goTopUp }
                    : { label: 'PLAY', color: 'amber', onPress: () => void doPlay() },
  })

  if (!isLabUser) return null

  const firstRun = !statsQ.isLoading && (statsQ.data?.stats.gamesPlayed ?? 0) === 0
  const recap = liveUp != null && liveDown != null ? `${asset} · <${fmtPrice(liveDown)} or >${fmtPrice(liveUp)}` : asset
  const escapeText = escape == null ? '—' : escape <= 0 ? 'BROKEN OUT' : `$${Math.round(escape)}`

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
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-text-3">Breakout · {asset}</div>
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

          {/* CHART — two pay zones with the dead zone bare between them. */}
          <div className="relative min-h-0 flex-1">
            {/* ESCAPE is the hero: how far the price still has to run to clear the nearer wall. */}
            <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex flex-col items-center">
              <div className="font-mono text-[10px] font-bold uppercase tracking-[0.24em] text-text-3">
                {escape != null && escape <= 0 ? 'Paying' : 'Escape'}
              </div>
              <div
                className={cnm(
                  'tnum text-[clamp(36px,10vh,62px)] font-black leading-none',
                  escape != null && escape <= 0 ? 'text-up' : 'text-text',
                )}
              >
                {escapeText}
              </div>
              {/* The dead zone, drawn as the run still left on each side. Both bars empty means it has broken. */}
              <div className="mt-2 flex h-1.5 w-32 gap-px">
                {Array.from({ length: 12 }, (_, i) => {
                  const lit = escape != null && breakSize != null && breakSize > 0 ? Math.max(0, Math.min(1, escape / breakSize)) : 0
                  return (
                    <span
                      key={i}
                      className={cnm('flex-1', i / 12 < lit ? 'bg-line-strong' : escape != null && escape <= 0 ? 'bg-up' : 'bg-brand-500')}
                    />
                  )
                })}
              </div>
            </div>
            <Chart asset={asset} overlays={overlays} livePriceRef={livePriceRef} onPrice={(p) => setSpot(p)} frozen={settling} className="absolute inset-0" />
          </div>

          {/* FOOTER — full-width readout band, left-only (clear of the knob + PLAY body). */}
          <div className="shrink-0 border-t border-line-strong bg-black px-[var(--screen-rim,24px)] pb-[var(--screen-rim,24px)] pt-3.5 min-h-[var(--screen-notch,21%)]">
            <div className="max-w-[60%]">
              {phase === 'placing' ? (
                <FooterStatusPanel kicker="Arming both legs" head="ARMING" recap={recap} sweep />
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
                    {broken != null && (
                      <span
                        className={cnm(
                          'inline-flex items-center border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.1em]',
                          broken ? 'border-up/60 text-up' : 'border-down/60 text-down',
                        )}
                      >
                        {broken ? 'Broken out' : 'Dead zone'}
                      </span>
                    )}
                  </div>
                  <LiveVerdictPanel winning={broken} payout={live?.maxPayout ?? play?.maxPayout ?? '0'} cashoutPnl={live?.pnl ?? play?.pnl ?? '0'} />
                  <div className="mt-2.5 grid grid-cols-3 gap-x-3">
                    <Cell label="Zones" value={liveUp != null && liveDown != null ? `${fmtPrice(liveDown)}/${fmtPrice(liveUp)}` : '—'} />
                    <Cell label="Mult" value={`${multiplier.toFixed(2)}x`} />
                    <Cell label="Win" value={`$${formatExactDecimal(live?.maxPayout ?? play?.maxPayout ?? '0')}`} />
                  </div>
                </>
              ) : firstRun ? (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Welcome</div>
                  <div className="text-[22px] font-extrabold uppercase leading-none tracking-[0.02em] text-text">Breakout</div>
                  <div className="mt-2.5 font-mono text-[11px] font-semibold uppercase leading-snug tracking-[0.08em] text-text-2">
                    Bet that <span className="text-brand-500">something happens</span>. Flat kills you.
                  </div>
                </>
              ) : (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Your break</div>
                  <div className="flex items-baseline gap-2">
                    <span className="tnum text-[36px] font-extrabold leading-none text-brand-500">
                      {breakSize == null ? '—' : `±$${Math.round(breakSize)}`}
                    </span>
                    <span className="font-mono text-[13px] font-bold uppercase tracking-[0.08em] text-text-2">{LEAN_LABEL[lean]}</span>
                  </div>
                  <div className="mt-2.5 grid grid-cols-3 gap-x-3">
                    {/* The true floor cost, stated before a chip is committed: this play is TWO mints (L-034). */}
                    <Cell label={`Cost ${legs} legs`} value={`$${totalStake.toFixed(2)}`} />
                    <Cell label="Pays est" value={estMultiple == null ? '—' : `${estMultiple.toFixed(2)}x`} />
                    <Cell label="Ends" value={shotSecs == null ? '—' : shotSecs <= 0 ? 'New round' : `${shotSecs}s`} />
                  </div>
                  <div className="mt-2.5 font-mono text-[11px] font-semibold uppercase leading-snug tracking-[0.08em] text-text-2">
                    {breakChance == null ? 'Two mints, one tx' : `Breaks ~${Math.round(breakChance * 100)}% of rounds`} ·{' '}
                    <span className="text-text-3">both legs or neither, est snaps on mint</span>
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
          winTitle="IT MOVED"
          cashoutTitle="CASHED OUT"
          loseTitle="DEAD FLAT"
          detail={
            play.settlePrice && playUp != null && playDown != null ? (
              <div className="mt-2 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-text-2">
                <div>
                  Zones {fmtPrice(playDown)} / {fmtPrice(playUp)} · Closed {fmtPrice(parseFloat(play.settlePrice))}
                </div>
              </div>
            ) : null
          }
        />
      )}
      {overlay === 'howto' && (
        <InstructionOverlay
          compact
          lines={[
            ['BREAK', 'Turn the knob to set how big a move you demand. Wider pays more and lands less.'],
            ['COST', 'Two mints in one transaction, so a play is two chips. Both legs land or neither does.'],
            ['LEAN', 'Pull one wall closer when you have a hunch. That side gets likelier and pays less.'],
            ['WIN', 'End outside either zone at the buzzer. Sit in the dead middle and both legs die.'],
          ]}
        />
      )}
      {overlay === 'board' && <GameLeaderboardOverlay game="breakout" title="Breakout" />}
    </GameScreen>
  )
}
