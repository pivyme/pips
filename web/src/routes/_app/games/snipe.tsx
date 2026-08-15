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
import { api, type PlayDTO, type PlayStatus, type Side, type SnipeModel } from '@/lib/api'
import { cashOut, placePlay } from '@/lib/sui/predict'
import { betLadder } from '@/lib/sui/config'
import { errorCode, toastError } from '@/lib/errors'
import { useLabGate } from '@/lib/lab'
import { useTopUp } from '@/lib/chipGrant'
import { useAuth } from '@/lib/auth'
import { useActivePlay } from '@/lib/activePlay'
import { cnm } from '@/utils/style'
import { formatExactDecimal, formatStringToNumericDecimals } from '@/utils/format'

// SNIPE: one wall, one button, and the decision is purely WHEN. The knob plants a wall above or below spot
// and it holds there while the market drifts toward it, so the gap closes (or does not) under the clock.
// GAP is the one headline number in the wave that is EXACT: spot minus a known strike, no estimate in it.
// Design: docs/games-ideation/CONCEPTS.md §6. ADMIN-only lab game, the server answers 404 for anyone else.
export const Route = createFileRoute('/_app/games/snipe')({ component: SnipeScreen })

const STAKE_KEY = 'pips_stake_idx' // shared with the other games so the chip stays put across screens
const WALL_KEY = 'pips_snipe_wall'

// The wall ladder, signed. The lower half plants below spot (farthest first), the upper half above, so
// turning through the middle crosses sides and there is never an ambiguous centre position.
const WALL_PER_SIDE = 6
const WALL_STEPS = WALL_PER_SIDE * 2
const DEFAULT_WALL_IDX = WALL_PER_SIDE + 2 // a mid-distance wall above spot

// Cold start only, until the server model lands. The travel is the server's solved reach, verified mintable
// end to end by scripts/verify-snipe-walls.ts; annualVol is a seed the real model overwrites within a fetch.
const FALLBACK_MODEL: Pick<SnipeModel, 'annualVol' | 'minWallSigma' | 'maxWallSigma' | 'admissionTick'> = {
  annualVol: 0.2,
  minWallSigma: 0.15,
  maxWallSigma: 0.94,
  admissionTick: 1,
}

const SECONDS_PER_YEAR = 365.25 * 24 * 3600
const NOMINAL_ROUND_SEC = 30
const RESULT_MS = 6000
const SETTLE_LOCK_MS = 5000
const CASHOUT_SETTLE_MS = 1100
const SETTLE_EXPECT_MS = 12000
const WATCHDOG_MS = 3000
const QUOTE_HAIRCUT = 0.04 // matches the server's REAL_RANGE_QUOTE_HAIRCUT so the estimate agrees before the snap
const TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out', 'error'])
const RESULT_TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out'])

type Phase = 'idle' | 'placing' | 'open' | 'cashing' | 'result'
type Live = { markValue: string; pnl: string; multiplier: number; entryValue?: string; maxPayout?: string; status: PlayStatus }
type Overlay = 'none' | 'howto' | 'board'

// The same normal CDF the server prices with, so the pre-mint estimate is the number the server would quote.
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2)
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return x >= 0 ? 1 - p : p
}

/** A ladder index as a side plus a distance in sigma. Index 0 is the farthest wall below spot. */
function wallAt(idx: number, minSigma: number, maxSigma: number): { side: Side; distSigma: number } {
  const i = Math.max(0, Math.min(WALL_STEPS - 1, idx))
  const above = i >= WALL_PER_SIDE
  // Rank away from the middle: nearest wall on each side sits next to the crossover.
  const rank = above ? i - WALL_PER_SIDE : WALL_PER_SIDE - 1 - i
  const t = WALL_PER_SIDE > 1 ? rank / (WALL_PER_SIDE - 1) : 0
  return { side: above ? 'up' : 'down', distSigma: minSigma + (maxSigma - minSigma) * t }
}

const fmtPrice = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 0 })

function SnipeScreen() {
  const isLabUser = useLabGate()

  useEffect(() => {
    trackEvent('game.open', { game: 'snipe' })
  }, [])

  const { refresh, user } = useAuth()
  const qc = useQueryClient()
  const { track } = useActivePlay()

  const [stakeIdx, setStakeIdx] = useLocalStorage(STAKE_KEY, 2)
  const [wallIdx, setWallIdx] = useLocalStorage(WALL_KEY, DEFAULT_WALL_IDX)

  const [phase, setPhase] = useState<Phase>('idle')
  const [play, setPlay] = useState<PlayDTO | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [spot, setSpot] = useState<number | null>(null)
  const [overlay, setOverlay] = useState<Overlay>('none')
  const [lockPrice, setLockPrice] = useState<string | null>(null)
  const [winning, setWinning] = useState<boolean | null>(null)
  // The wall is planted against the spot at the START of the round and holds there: the market comes to it.
  // Re-anchors when the market rolls to a new expiry, which is what makes the wall roll with the round.
  const [anchor, setAnchor] = useState<{ price: number; sigmaFrac: number; expiryMs: number } | null>(null)

  const finalized = useRef(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const balanceSyncedPlayId = useRef<string | null>(null)
  const livePriceRef = useRef(0)
  const winRef = useRef<boolean | null>(null)
  const wasWinning = useRef<boolean | null>(null)
  const lastCrossRef = useRef(0)

  const { noLiveMarket, playsPaused, isLoading: marketsLoading, isError: marketsError } = useLiveMarkets()
  const statsQ = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() })
  const streak = statsQ.data?.stats.currentStreak ?? 0

  const modelQ = useQuery({
    queryKey: ['snipeModel'],
    queryFn: () => api.snipeModel(),
    enabled: isLabUser,
    placeholderData: (prev) => prev,
    staleTime: 4_000,
    refetchInterval: 5_000,
    retry: false,
  })
  const model = modelQ.data ?? null
  const annualVol = model?.annualVol ?? FALLBACK_MODEL.annualVol
  const minWallSigma = model?.minWallSigma ?? FALLBACK_MODEL.minWallSigma
  const maxWallSigma = model?.maxWallSigma ?? FALLBACK_MODEL.maxWallSigma
  const admissionTick = model?.admissionTick ?? FALLBACK_MODEL.admissionTick

  // The shot clock. Waiting is the whole game, so the screen always says how long is left to take this wall,
  // and the estimate decays under the thumb instead of stepping every time the model refetches.
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
  const maxBetIdx = Math.max(0, STAKE_LADDER.reduce((acc, v, i) => (v <= balance ? i : acc), 0))
  const safeBetIdx = Math.min(stakeIdx, maxBetIdx)
  const stake = STAKE_LADDER[safeBetIdx]
  const cantAfford = balance < STAKE_LADDER[0]

  const asset = 'BTC'
  const canPlay = !noLiveMarket

  // Plant (or re-plant) the wall whenever the round rolls, so every round starts with a fresh gap to close.
  useEffect(() => {
    if (!model || spot == null || spot <= 0) return
    setAnchor((cur) => (cur?.expiryMs === model.expiryMs ? cur : { price: spot, sigmaFrac, expiryMs: model.expiryMs }))
  }, [model?.expiryMs, spot, sigmaFrac, model])

  const { side, distSigma } = wallAt(wallIdx, minWallSigma, maxWallSigma)
  const planted = anchor ? anchor.price * (1 + (side === 'up' ? 1 : -1) * distSigma * anchor.sigmaFrac) : (spot ?? 0)
  // Held inside the band the chain will admit, against the LIVE sigma, exactly as the server does. Sigma
  // shrinks with the clock, so a far wall goes unmintable late in a round and the server would pull it in
  // after the press: that is how a 13x estimate comes back as 5x. Planted stays planted, only an unbuyable
  // wall moves, so what is on screen is always what mints.
  const bandHalf = spot != null ? spot * maxWallSigma * sigmaFrac : null
  const wallRaw = bandHalf != null && spot != null ? Math.min(spot + bandHalf, Math.max(spot - bandHalf, planted)) : planted
  // Snapped to the admission grid ($1) away from the winning side, which is both where the strike lands and
  // how a wall reads out loud.
  const wall = anchor
    ? admissionTick * (side === 'up' ? Math.ceil(wallRaw / admissionTick) : Math.floor(wallRaw / admissionTick))
    : Math.round(wallRaw)

  const playWall = play?.market.strike ? parseFloat(play.market.strike) : undefined
  // params is a union; a binary play carries the side, a band play does not.
  const playSide: Side = play && 'side' in play.params ? play.params.side : side
  const liveWall = playWall ?? wall
  const activeSide: Side = play ? playSide : side

  // GAP is exact: the live spot against a known strike. No estimate anywhere in this number, which is why it
  // is the one headline in the wave rendered with no `est` tag.
  const gap = spot != null ? (activeSide === 'up' ? liveWall - spot : spot - liveWall) : null
  const plantGap = anchor ? anchor.price * distSigma * anchor.sigmaFrac : null
  // Fills as the market closes on the wall, and tops out once the price has run past it.
  const pressure = gap != null && plantGap != null && plantGap > 0 ? Math.max(0, Math.min(1, 1 - gap / plantGap)) : 0

  // The estimate the player is timing against. Analytic off the live gap, tagged `est`, and it snaps from
  // OrderMinted the moment the mint lands (L-012).
  const estMultiple = (() => {
    if (spot == null || gap == null || sigmaFrac <= 0) return null
    const p = Math.min(0.95, Math.max(0.01, normCdf(-gap / spot / sigmaFrac)))
    return Math.max(1.01, (1 / p) * (1 - QUOTE_HAIRCUT))
  })()

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

  // The wall is the picture: a bold line at the strike with the winning side shaded, whether or not a
  // position is riding, so the player can see exactly what they are timing against before they commit.
  const roundOverlayOn = positioned && (phase === 'open' || phase === 'cashing' || phase === 'result')
  const overlays: ChartOverlays | undefined =
    roundOverlayOn && playWall != null
      ? {
          ...(entryVal != null ? { entry: entryVal } : {}),
          target: { price: playWall, side: playSide, sealed: settling },
          ...(settleLine != null ? { settle: settleLine } : {}),
        }
      : (phase === 'idle' || phase === 'placing') && anchor != null
        ? { target: { price: wall, side } }
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
      if (final.status === 'cashed_out') trackEvent('game.cashout_done', { game: 'snipe', pnl: final.pnl ?? '0' })
      else trackEvent('game.settled', { game: 'snipe', result: final.status, pnl: final.pnl ?? '0' })
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
        toast.error('That shot did not land. Your chips are safe, line up another.', { id: 'snipe-play-error' })
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
      track({ id: p.id, game: 'snipe' })
      trackEvent('game.restore', { game: 'snipe' })
    },
    [track],
  )
  const { restorePending } = useRestoreOpenPlay({
    game: 'snipe',
    active: phase !== 'idle',
    fallbackDurationSec: NOMINAL_ROUND_SEC,
    onRestore: restoreOpenPlay,
  })

  // Which side of the wall the line is on, off the 60fps chart price, with a light tick on each crossing.
  useEffect(() => {
    if (!liveHold || playWall == null) {
      winRef.current = null
      wasWinning.current = null
      setWinning(null)
      return
    }
    let raf = 0
    const loop = () => {
      const p = livePriceRef.current
      const now = p > 0 ? (playSide === 'up' ? p > playWall : p < playWall) : null
      if (now !== winRef.current) {
        winRef.current = now
        if (wasWinning.current != null && wasWinning.current !== now) {
          const t = performance.now()
          if (t - lastCrossRef.current > 400) {
            lastCrossRef.current = t
            haptic('low')
          }
        }
        wasWinning.current = now
        setWinning(now)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [liveHold, playWall, playSide])

  const doPlay = useCallback(async () => {
    if (phase !== 'idle' || restorePending) return
    if (playsPaused) {
      trackEvent('friction.sponsor_paused', { game: 'snipe' })
      toast.error('Plays paused while we top up. Back in a moment.', { id: 'paused' })
      return
    }
    if (!canPlay || !spot || !anchor) {
      toast.error('No game running right now. Try again in a sec.', { id: 'no-market' })
      return
    }
    clearResetTimer()
    finalized.current = false
    setLockPrice(null)
    setOverlay('none')
    setPhase('placing')
    haptic('rigid')
    trackEvent('game.play_tap', { game: 'snipe', stake, tier: `${side}${distSigma.toFixed(2)}` })
    const tapAt = Date.now()
    try {
      const { play: p } = await placePlay('snipe', { stake, asset, wall, side })
      setPlay(p)
      track({ id: p.id, game: 'snipe' })
      trackEvent('game.play_open', { game: 'snipe', latencyms: Date.now() - tapAt })
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
      trackEvent('game.play_error', { game: 'snipe', code: errorCode(e) })
      toastError(e)
      setPhase('idle')
    }
  }, [phase, canPlay, spot, anchor, stake, wall, side, distSigma, playsPaused, track, restorePending])

  const doCashOut = useCallback(async () => {
    if (!liveHold || !play) return
    trackEvent('game.cashout_tap', { game: 'snipe' })
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

  // The knob only plants the wall between rounds: once a position is riding, the wall it was minted at is
  // fixed on chain, so the control reads as locked rather than pretending to move it.
  const moveWall = useCallback(
    (next: number) => {
      if (phase !== 'idle' && phase !== 'placing') return
      setWallIdx(Math.max(0, Math.min(WALL_STEPS - 1, next)))
    },
    [phase, setWallIdx],
  )

  const isResult = phase === 'result'
  const resultPositive = isResult && play != null && (play.status === 'won' || (play.status === 'cashed_out' && parseFloat(play.pnl ?? '0') >= 0))
  const resultColor: 'up' | 'down' = resultPositive ? 'up' : 'down'
  const wallLabel = `${side === 'up' ? '▲' : '▼'} ${fmtPrice(wall)}`

  useConsoleControls({
    knob: {
      label: 'WALL',
      min: 0,
      max: WALL_STEPS - 1,
      step: 1,
      value: Math.max(0, Math.min(WALL_STEPS - 1, wallIdx)),
      onChange: (v: number) => {
        moveWall(v)
        trackSettled('game.knob_change', { game: 'snipe', tier: String(v) })
      },
      format: () => wallLabel,
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
    // Snipe is the one game with a spare button, so help and ranks get one each instead of sharing a rotary.
    action1: isResult
      ? { label: '', color: resultColor, onPress: dismissResult, pulse: true }
      : { label: 'HOW TO', color: 'neutral', onPress: () => setOverlay((o) => (o === 'howto' ? 'none' : 'howto')) },
    action2: isResult
      ? { label: '', color: resultColor, onPress: dismissResult, pulse: true }
      : { label: 'RANKS', color: 'neutral', onPress: () => setOverlay((o) => (o === 'board' ? 'none' : 'board')) },
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
                  ? { label: 'SNIPING', color: 'amber', onPress: () => {}, loading: true }
                  : cantAfford
                    ? { label: 'TOP UP', color: 'amber', onPress: goTopUp }
                    : { label: 'SNIPE', color: 'amber', onPress: () => void doPlay() },
  })

  if (!isLabUser) return null

  const firstRun = !statsQ.isLoading && (statsQ.data?.stats.gamesPlayed ?? 0) === 0
  const recap = `${asset} · ${activeSide === 'up' ? '▲' : '▼'} ${fmtPrice(liveWall)}`
  const gapText = gap == null ? '—' : gap <= 0 ? 'PAST IT' : `$${Math.round(gap)}`

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
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-text-3">Snipe · {asset}</div>
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

          {/* CHART — the wall, and the gap closing on it. */}
          <div className="relative min-h-0 flex-1">
            {/* GAP is the hero and it is exact, so it sits over the chart at full confidence, no est tag. */}
            <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex flex-col items-center">
              <div className="font-mono text-[10px] font-bold uppercase tracking-[0.24em] text-text-3">Gap</div>
              <div
                className={cnm(
                  'tnum text-[clamp(40px,11vh,68px)] font-black leading-none',
                  gap != null && gap <= 0 ? 'text-up' : 'text-text',
                )}
              >
                {gapText}
              </div>
              {/* Pressure: fills as the market closes on the wall. Chrome sits still, only the fill moves. */}
              <div className="mt-2 flex h-1.5 w-32 gap-px">
                {Array.from({ length: 12 }, (_, i) => (
                  <span
                    key={i}
                    className={cnm('flex-1', i / 12 < pressure ? (pressure >= 0.999 ? 'bg-up' : 'bg-brand-500') : 'bg-line-strong')}
                  />
                ))}
              </div>
            </div>
            <Chart asset={asset} overlays={overlays} livePriceRef={livePriceRef} onPrice={(p) => setSpot(p)} frozen={settling} className="absolute inset-0" />
          </div>

          {/* FOOTER — full-width readout band, left-only (clear of the knob + PLAY body). */}
          <div className="shrink-0 border-t border-line-strong bg-black px-[var(--screen-rim,24px)] pb-[var(--screen-rim,24px)] pt-3.5 min-h-[var(--screen-notch,21%)]">
            <div className="max-w-[60%]">
              {phase === 'placing' ? (
                <FooterStatusPanel kicker="Taking the shot" head="SNIPING" recap={recap} sweep />
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
                    {winning != null && (
                      <span
                        className={cnm(
                          'inline-flex items-center border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.1em]',
                          winning ? 'border-up/60 text-up' : 'border-down/60 text-down',
                        )}
                      >
                        {winning ? 'Past the wall' : 'Short'}
                      </span>
                    )}
                  </div>
                  <LiveVerdictPanel winning={winning} payout={live?.maxPayout ?? play?.maxPayout ?? '0'} cashoutPnl={live?.pnl ?? play?.pnl ?? '0'} />
                  <div className="mt-2.5 grid grid-cols-3 gap-x-3">
                    <Cell label="Wall" value={fmtPrice(liveWall)} />
                    <Cell label="Mult" value={`${multiplier.toFixed(2)}x`} />
                    <Cell label="Win" value={`$${formatExactDecimal(live?.maxPayout ?? play?.maxPayout ?? '0')}`} />
                  </div>
                </>
              ) : firstRun ? (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Welcome</div>
                  <div className="text-[22px] font-extrabold uppercase leading-none tracking-[0.02em] text-text">Snipe</div>
                  <div className="mt-2.5 font-mono text-[11px] font-semibold uppercase leading-snug tracking-[0.08em] text-text-2">
                    Plant a wall, wait for it, then <span className="text-brand-500">SNIPE</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Your wall</div>
                  <div className="flex items-baseline gap-2">
                    <span className="tnum text-[36px] font-extrabold leading-none text-brand-500">{fmtPrice(wall)}</span>
                    <span className="font-mono text-[13px] font-bold uppercase tracking-[0.08em] text-text-2">
                      {side === 'up' ? 'Above' : 'Below'}
                    </span>
                  </div>
                  <div className="mt-2.5 grid grid-cols-3 gap-x-3">
                    <Cell label="Cost" value={`$${stake}`} />
                    <Cell label="Pays est" value={estMultiple == null ? '—' : `${estMultiple.toFixed(2)}x`} />
                    {/* The shot clock, so a skipped wall reads as the next one arriving, never as a miss. */}
                    <Cell label="Ends" value={shotSecs == null ? '—' : shotSecs <= 0 ? 'New wall' : `${shotSecs}s`} />
                  </div>
                  <div className="mt-2.5 font-mono text-[11px] font-semibold uppercase leading-snug tracking-[0.08em] text-text-2">
                    One mint · <span className="text-text-3">wait and it pays less, est snaps on mint</span>
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
          winTitle="CLEARED IT"
          cashoutTitle="CASHED OUT"
          loseTitle="SHORT"
          detail={
            play.settlePrice && playWall != null ? (
              <div className="mt-2 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-text-2">
                <div>
                  Wall {fmtPrice(playWall)} · Closed {fmtPrice(parseFloat(play.settlePrice))}
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
            ['WALL', 'Turn the knob to plant a wall above or below the price. It does not move.'],
            ['GAP', 'The exact distance left. The market comes to you, the gap is not an estimate.'],
            ['WHEN', 'Snipe early for a long shot, or wait and the pay shrinks as it gets safer.'],
            ['WIN', 'End past the wall at the buzzer. Cash out any time before it.'],
          ]}
        />
      )}
      {overlay === 'board' && <GameLeaderboardOverlay game="snipe" title="Snipe" />}
    </GameScreen>
  )
}
