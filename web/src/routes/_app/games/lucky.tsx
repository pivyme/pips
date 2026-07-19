import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useConsoleControls } from '@/components/console/controls'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { useLiveMarkets } from '@/hooks/useLiveMarkets'
import { GameLeaderboardOverlay } from '@/components/game/GameLeaderboardOverlay'
import {
  FooterStatusPanel,
  InstructionOverlay,
  LiveVerdictPanel,
  ResultOverlay,
} from '@/components/game/gamePanels'
import { GameScreen, ScreenMessage, Cell } from '@/components/game/screen'
import { TradeConfirmSheet, useTradeConfirm } from '@/components/game/tradeConfirm'
import { LivePrice } from '@/components/game/LivePrice'
import { Chart } from '@/components/game/Chart'
import { DirectionWheel, MultiplierWheel } from '@/components/game/lucky/LuckyWheels'
import {
  mergeSnapshotMarket,
  usePhaseElapsed,
  usePlayResolutionWatch,
  useRestoreOpenPlay,
  useRoundCountdown,
} from '@/hooks/useGameRound'
import { haptic } from '@/lib/haptics'
import { slotSpin, slotTick, slotPick, startLuckyBgm, stopLuckyBgm, luckyWin, luckyCashout, luckyLose } from '@/lib/sound'
import { api, type LuckyParams, type PlayDTO, type PlayStatus, type Side } from '@/lib/api'
import { placePlay, cashOut } from '@/lib/sui/predict'
import { betLadder } from '@/lib/sui/config'
import { toastError } from '@/lib/errors'
import { useTopUp } from '@/lib/chipGrant'
import { useAuth } from '@/lib/auth'
import { useActivePlay } from '@/lib/activePlay'
import { formatExactDecimal, formatStringToNumericDecimals } from '@/utils/format'
import { cnm } from '@/utils/style'

// LUCKY, the hero: SPIN deals two reels (direction, multiplier) from a server-dealt pull, opens
// a real Predict position with a TARGET line, then ride the value to CASH OUT or the buzzer for a spread-free WIN/LOSE. Demo mirrors the flow. Layout/style: header+slot, bounded chart, footer, docs/SCREEN.md.
export const Route = createFileRoute('/_app/games/lucky')({ component: LuckyScreen })

// Persisted stake index shared with the home idle wheel (same key, see ConsoleCanvas); ladder sized
// live via betLadder().
const STAKE_KEY = 'pips_stake_idx'
const SPIN_STOPS = [720, 980] // staggered wheel stops (ms): direction, then multiplier
const WHEEL_BIG = 148 // big prize-wheel diameter (px) while dealing
const DEAL_ZONE_H = 200 // deal-zone height with the wheels up
const LOCKED_ZONE_H = 66 // collapsed height once the hand morphs to the compact strip
const SPIN_TOTAL = 1060
// Beat between the last reel locking and the TARGET landing on the chart, so the deal reads before the stake does.
const LOCKIN_MS = 450
// Safety auto-advance for an idle player (result is normally dismissed via CONTINUE); generous so it never cuts a read short.
const RESULT_MS = 6500
const ROUND_SEC = 15 // fallback only; the play's real on-chain expiry drives the countdown
// Safety-net poll independent of the live SSE (which carries the smooth PnL), whose socket can silently
// drop (expired token, proxy timeout) and strand the screen on OPENING/SETTLING forever. Guarantees the terminal frame lands.
const WATCHDOG_MS = 3000
const SETTLE_EXPECT_MS = 12000 // the settle progress bar eases toward (never to) full over this window
// Min settling dwell; redeem can land in ~120ms (demo, too fast to read), so doCashOut holds the beat and the bar eases over it.
const CASHOUT_SETTLE_MS = 1100
// Cash-out is a pre-expiry redeem; a tap in the final beat could land after the buzzer when the oracle
// is no longer quoteable (EOracleExpired), so CASH OUT disarms a tx round-trip ahead of expiry and the round auto-settles.
const CASHOUT_LOCKOUT_MS = 1500
const TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out', 'error'])
// Terminal states that resolve to a win/loss RESULT screen. 'error' is excluded: it's a background
// mint that could not open (chips safe), handled as a clean re-rack, not a result.
const RESULT_TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out'])

type Phase = 'idle' | 'placing' | 'spinning' | 'open' | 'cashing' | 'result'
type Live = {
  markValue: string
  pnl: string
  multiplier: number
  entryValue?: string
  maxPayout?: string
  status: PlayStatus
}
type Overlay = 'none' | 'howto' | 'board'

const money = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtMult = (n: number): string =>
  `${n.toFixed(2).replace(/\.?0+$/, '')}x`
const sideLabel = (s: Side): string => (s === 'up' ? 'UP' : 'DOWN')

function LuckyScreen() {
  const { refresh, user } = useAuth()
  const qc = useQueryClient()
  const { track } = useActivePlay()

  // One persistent stake shared with the home wheel (same ladder), so it stays put across navigation.
  const [betIdx, setBetIdx] = useLocalStorage(STAKE_KEY, 2)
  const [phase, setPhase] = useState<Phase>('idle')
  const [play, setPlay] = useState<PlayDTO | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [spot, setSpot] = useState<number | null>(null)
  const [overlay, setOverlay] = useState<Overlay>('none')
  // Entry/target overlays hold off for a beat after the reels lock, so they land on the chart as the payoff, not the instant the round opens.
  const [revealOverlays, setRevealOverlays] = useState(false)
  // A round rehydrated from the chain (hub return / hard refresh) never spun, so it skips the reel-commit beep and big-wheel morph and lands straight on the dealt strip, matching a settled fresh round.
  const [restored, setRestored] = useState(false)
  // Exact oracle settlement price at the buzzer; pins the frozen chart onto the true result. Null until the settlement tx lands.
  const [lockPrice, setLockPrice] = useState<string | null>(null)
  // Live on-target read off the 60fps chart line: whether the price currently sits past the target in the dealt direction.
  const [onTarget, setOnTarget] = useState<boolean | null>(null)

  const finalized = useRef(false)
  const onTargetRef = useRef<boolean | null>(null) // mirrors onTarget so the rAF only re-renders on a real flip
  const wasOnTarget = useRef<boolean | null>(null) // last state, for the crossing haptic
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const balanceSyncedPlayId = useRef<string | null>(null)
  // Latest chart spot, mirrored for the DEV deal log; the ENTRY line is never derived from this display feed, only the backend's real oracle entrySpot.
  const spotRef = useRef<number | null>(null)
  // Chart's eased leading price, written every frame for visual tracking only; financial values come from the backend's Predict quote.
  const livePriceRef = useRef(0)

  // spotByAsset seeds each chart's initial price on mount; allAssets pads the stack when fewer than three
  // are live. Both come from the shared feed, which graces brief chain blips so a ladder roll never flashes "Market catching up".
  const { liveAssets, allAssets, spotByAsset, noLiveMarket, playsPaused, isLoading: marketsLoading, isError: marketsError } = useLiveMarkets()
  const statsQ = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() })
  const canPlay = liveAssets.length > 0
  const streak = statsQ.data?.stats.currentStreak ?? 0

  // BET clamps to what the balance affords, so the wheel never offers an unplayable bet.
  const BET_LADDER = betLadder()
  const balance = parseFloat(user?.balance ?? '0') || 0
  const maxBetIdx = Math.max(0, BET_LADDER.reduce((acc, v, i) => (v <= balance ? i : acc), 0))
  const safeBetIdx = Math.min(betIdx, maxBetIdx)
  const bet = BET_LADDER[safeBetIdx]
  // Below the cheapest rung: SPIN would just round-trip INSUFFICIENT_DUSDC, so the button becomes TOP UP instead of a dead-end toast.
  const cantAfford = balance < BET_LADDER[0]

  const lp = play ? (play.params as LuckyParams) : null
  // The chart follows the dealt asset (BTC in real mode, whatever the demo lottery dealt otherwise);
  // at rest it shows the primary live market. Fallbacks only bite before markets load, which the render already gates.
  const focusAsset = lp?.asset ?? liveAssets[0] ?? allAssets[0] ?? 'BTC'
  // The position is real on-chain only once status leaves 'pending' (a failed mint goes 'error'); gate
  // the entry/target on this, never the optimistic 'pending' window, so the line only shows for a play that actually opened.
  const status = live?.status ?? play?.status
  const entered = status != null && status !== 'pending' && status !== 'error'
  // Entry line shows only while confirmed open, not in 'result': the screen behind the overlay resets to the default stack.
  const showEntry = entered && (phase === 'open' || phase === 'cashing')
  const strike = play?.market.strike ? parseFloat(play.market.strike) : undefined
  const side = lp?.side // the dealt direction, drives the live on-target verdict
  const spinning = phase === 'spinning'
  // Reels tumble from SPIN press through the snap ('placing' server deal + 'spinning' window), masking the deal latency.
  const reelsCycling = phase === 'placing' || phase === 'spinning'
  // Live round readout (header price, footer P/L, expanded chart); excludes 'result', which falls back to the default stack + masked header.
  const showReadouts = play != null && (phase === 'open' || phase === 'cashing')
  // Reels carry the dealt direction/multiplier only while a round is genuinely in play, else reset to '?'.
  const roundActive = phase === 'spinning' || phase === 'open' || phase === 'cashing'
  const multiplier = live?.multiplier ?? play?.multiplier ?? 0
  // Big prize wheels own the top through idle + the deal + the lock-in beat, then morph out to a compact
  // dealt strip the moment the round reveals, handing the freed height back to the chart.
  const bigWheels = phase === 'idle' || reelsCycling || (showReadouts && !revealOverlays)
  // Entry reference: the real on-chain spot the strike was solved against (read live at the tap), so
  // ENTRY, TARGET, and settlement all agree. Never a client-guessed display value, same rule as RANGE and MOONSHOT.
  const entrySpotNum = play?.entrySpot ? parseFloat(play.entrySpot) : NaN
  const entryVal = Number.isFinite(entrySpotNum) && entrySpotNum > 0 ? entrySpotNum : null
  const { secsLeft, remainingMs, settleMs } = useRoundCountdown({
    enabled: phase === 'open',
    play,
    fallbackDurationSec: ROUND_SEC,
  })
  const cashMs = usePhaseElapsed(phase === 'cashing')
  const closeLocked =
    phase === 'open' && remainingMs != null && remainingMs <= CASHOUT_LOCKOUT_MS
  // The mint is still landing: reels snapped on the dealt deal, the position is not open on-chain yet.
  const opening = phase === 'open' && live?.status === 'pending'
  // The round hit the buzzer and we are waiting on the on-chain settle (won/lost) frame.
  const settling = phase === 'open' && live?.status === 'open' && secsLeft != null && secsLeft <= 0
  const settleSecs = Math.floor(settleMs / 1000)
  // Exact on-chain settlement price at the buzzer; pins the frozen chart tip onto the true result while settling.
  const lockNum = lockPrice ? parseFloat(lockPrice) : null
  const settleLine = settling && lockNum != null && lockNum > 0 ? lockNum : undefined
  // Chart overlays: the ENTRY line, the directional TARGET + winning-zone shading, and the settle line at the buzzer.
  const overlays =
    showEntry && entryVal != null
      ? {
          entry: entryVal,
          ...(strike != null && lp ? { target: { price: strike, side: lp.side } } : {}),
          ...(settleLine != null ? { settle: settleLine } : {}),
        }
      : undefined
  // A mid-round cash-out is in flight: play the same settling beat as the buzzer.
  const cashingOut = phase === 'cashing'
  // The dealt pick, shown under OPENING / SETTLING so the round always reads back what's in flight.
  const dealLine = lp
    ? `${lp.asset} ${sideLabel(lp.side)} · ${fmtMult(multiplier)} · Cost $${money(
        parseFloat(live?.entryValue ?? play?.entryValue ?? '0'),
      )}`
    : '—'
  // First-run welcome: no plays on record yet.
  const firstRun = !statsQ.isLoading && (statsQ.data?.stats.gamesPlayed ?? 0) === 0

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
      stopLuckyBgm() // cut the bed the instant it resolves, so the sting lands clean
      haptic(final.status === 'lost' ? 'error' : 'success')
      if (final.status === 'won') luckyWin()
      else if (final.status === 'cashed_out') luckyCashout()
      else luckyLose()
      void refresh()
      // Settle/cashout moved the record: freshen stats (streak), achievements, and history.
      for (const key of ['stats', 'achievements', 'plays']) void qc.invalidateQueries({ queryKey: [key] })
      clearResetTimer()
      resetTimer.current = setTimeout(() => setPhase('idle'), RESULT_MS)
    },
    [refresh, qc],
  )

  // Resolves a round from a status, idempotent via `finalized` so the SSE and the watchdog can both feed it.
  // 'error' = the mint never opened (chips safe, clean re-rack); a win/loss/cashout refetches the finalized play.
  const resolveTerminal = useCallback(
    (status: PlayStatus, playId: string) => {
      if (finalized.current) return
      if (status === 'error') {
        finalized.current = true
        toast.error('Could not open that play. Your chips are safe, spin again.', {
          id: 'lucky-play-error',
        })
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
      // Snap the deal to the real minted market if a mid-flight re-route/restrike moved the strike/entry.
      setPlay((cur) => (cur ? mergeSnapshotMarket(cur, snapshot) : cur))
    },
    onTerminal: resolveTerminal,
  })

  useEffect(() => () => clearResetTimer(), [])

  // Restore a live round on (re)mount from the durable open-plays list, so leaving to Home and back, or a hard
  // refresh, drops you straight back onto the running position (chart, TARGET, countdown, CASH OUT) instead of
  // idle. Skips the reel deal (the round already opened); the SSE watch + countdown take over from 'open'.
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
      setRestored(true)
      setRevealOverlays(true) // reveal the dealt strip + chart overlays at once; there was no spin to lead into them
      setPhase('open')
      track({ id: p.id, game: 'lucky' })
    },
    [track],
  )
  const { restorePending } = useRestoreOpenPlay({ game: 'lucky', active: phase !== 'idle', onRestore: restoreOpenPlay })

  // Bed rides the whole round: fades in as reels deal, out the moment the phase leaves the live window.
  // finishResult also cuts it so the sting lands over silence. Bright + bouncy, the counterpart to Range's tension.
  const bedPlaying = reelsCycling || roundActive
  useEffect(() => {
    if (!bedPlaying) return
    startLuckyBgm()
    return () => stopLuckyBgm()
  }, [bedPlaying])

  // Quiet tick stream while the reels tumble, ended the moment they settle; one stream for the whole slot keeps it subtle.
  useEffect(() => {
    if (!reelsCycling) return
    const iv = setInterval(() => slotTick(), 70)
    return () => clearInterval(iv)
  }, [reelsCycling])

  // The single chart reports its ticks here: drives the header price and the DEV deal log. No per-asset
  // stash anymore, the chart is always the dealt/live asset. Financial values still come from the backend quote.
  const handlePrice = useCallback((p: number) => {
    spotRef.current = p
    setSpot(p)
  }, [])

  // Holds a beat after the reels lock (with a confirm beep), then reveals the entry/target overlays so the
  // TARGET lands on the chart as the payoff. Resets the instant we leave a round so the next spin replays clean.
  useEffect(() => {
    if (showReadouts && lp?.asset) {
      if (restored) return // rehydrated round: already revealed, no spin to commit
      slotPick() // the slot commits: a short ascending confirm under the lock-in
      const reveal = setTimeout(() => setRevealOverlays(true), LOCKIN_MS)
      return () => clearTimeout(reveal)
    }
    setRevealOverlays(false)
    setRestored(false)
  }, [showReadouts, lp?.asset, restored])

  // Live on-target verdict off the 60fps eased chart price (the backend mark is neutral during an open round),
  // so "if it ends now" swings with the line like Range's in/out. Tracks right up to the buzzer (Lucky has no seal
  // branch, so the readout must stay truthful through the cash-out lockout); it clears only once settling. A light tick on each cross.
  useEffect(() => {
    const holding = phase === 'open' && status === 'open' && !settling
    if (!holding || strike == null || side == null) {
      onTargetRef.current = null
      wasOnTarget.current = null
      setOnTarget(null)
      return
    }
    let raf = 0
    const loop = () => {
      const p = livePriceRef.current
      const now = p > 0 ? (side === 'up' ? p >= strike : p <= strike) : null
      if (now !== onTargetRef.current) {
        onTargetRef.current = now
        if (wasOnTarget.current != null && wasOnTarget.current !== now) haptic('selection')
        wasOnTarget.current = now
        setOnTarget(now)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [phase, status, settling, strike, side])

  const doPlay = useCallback(async () => {
    // Idle only: a finished round must be dismissed (CONTINUE) before spinning again, never straight from the result.
    // restorePending holds the first tap after a cold refresh until we know whether a live round is being restored, so it never opens a second.
    if (phase !== 'idle' || restorePending) return
    if (playsPaused) {
      toast.error('Plays paused while we top up. Back in a moment.', { id: 'paused' })
      return
    }
    if (!canPlay) {
      toast.error('No live market right now. Try again in a sec.', { id: 'no-market' })
      return
    }
    clearResetTimer()
    finalized.current = false
    setLockPrice(null)
    setOverlay('none')
    setPhase('placing')
    haptic('rigid')
    slotSpin()
    try {
      const { play: p } = await placePlay('lucky', { stake: bet })
      setPlay(p)
      track({ id: p.id, game: 'lucky' })
      // Price debug: compares the chart's dealt-asset display price against what the backend solved the
      // round on. entrySpot/target read the live on-chain spot at the tap, so any gap is just display micro-motion, not staleness.
      if (import.meta.env.DEV) {
        const d = p.params as LuckyParams
        console.debug('[lucky] dealt', {
          asset: d.asset,
          side: d.side,
          mult: p.multiplier,
          bet,
          chartLive: spotRef.current,
          entrySpot: p.entrySpot,
          target: p.market.strike,
        })
      }
      setLive({
        markValue: p.markValue,
        pnl: p.pnl,
        multiplier: p.multiplier,
        entryValue: p.entryValue,
        maxPayout: p.maxPayout,
        status: p.status,
      })
      setPhase('spinning')
      haptic('heavy')
      setTimeout(() => setPhase((cur) => (cur === 'spinning' ? 'open' : cur)), SPIN_TOTAL)
    } catch (e) {
      toastError(e)
      setPhase('idle')
    }
  }, [phase, canPlay, bet, playsPaused, track, restorePending])

  // Trade confirmation (opt-in, off by default): SPIN arms, CONFIRM places; the reel deals the
  // asset/side/multiplier so the sheet only guards the stake commitment. Off, press() short-circuits straight to doPlay().
  const confirm = useTradeConfirm(
    () => void doPlay(),
    () => ({ stake: bet, headline: 'I Feel Lucky', note: 'Reel deals the play' }),
  )
  // Disarms the moment placement would be blocked or idle ends, so CONFIRM can't fire a play the ready-state rejected.
  useEffect(() => {
    if (phase !== 'idle' || cantAfford || !canPlay || playsPaused) confirm.disarm()
  }, [phase, cantAfford, canPlay, playsPaused, confirm.disarm])

  const doCashOut = useCallback(async () => {
    if (phase !== 'open' || !play || closeLocked) return
    setPhase('cashing')
    haptic('rigid')
    const started = Date.now()
    try {
      const { play: p } = await cashOut(play.id)
      // Hold the settling beat open so it always reads, even when the redeem lands in ~120ms (demo).
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
  }, [phase, play, finishResult, closeLocked])

  // Any console button leaves the result straight to idle (the 3-up stack + masked header), never a
  // re-spin; the auto-advance timer lands the same place, sooner. Touches only refs/setters, so a stable identity is fine.
  const dismissResult = useCallback(() => {
    clearResetTimer()
    haptic('selection')
    setPhase('idle')
  }, [])

  // TOP UP: hand the player a starter grant (popup + coin sound), falling back to the deposit drawer when the
  // grant is on cooldown or the treasury is dry, so a broke player is never a dead-end.
  const topUp = useTopUp()
  const goTopUp = useCallback(() => {
    haptic('rigid')
    void topUp()
  }, [topUp])

  const toggleHowto = useCallback(() => {
    haptic('selection')
    setOverlay((o) => (o === 'howto' ? 'none' : 'howto'))
  }, [])
  const toggleBoard = useCallback(() => {
    haptic('selection')
    setOverlay((o) => (o === 'board' ? 'none' : 'board'))
  }, [])

  // CASH OUT arms only once the play confirms 'open' on-chain (cashing a not-yet-minted play would revert); until then it reads OPENING.
  const confirmed = live?.status === 'open'
  // Cash-out arms only pre-expiry; in the final beat (closeLocked) the button flips to SETTLING so a redeem never lands in the expiry gap.
  const isOpen = phase === 'open' && confirmed && !closeLocked
  const isOpening = phase === 'open' && !confirmed
  const closing = phase === 'open' && confirmed && closeLocked
  // On the result screen every button just continues (the player never hunts for the right one); all three drop back to idle.
  const isResult = phase === 'result'
  // Side buttons blink the outcome's color on the result screen (green win/red lose), so CONTINUE reads at a glance.
  const resultPositive =
    isResult && play != null && (play.status === 'won' || (play.status === 'cashed_out' && parseFloat(play.pnl ?? '0') >= 0))
  const resultColor: 'up' | 'down' = resultPositive ? 'up' : 'down'
  useConsoleControls({
    numberWheel: {
      label: 'AMOUNT',
      min: 0,
      max: maxBetIdx,
      step: 1,
      value: safeBetIdx,
      onChange: setBetIdx,
      format: (v) => `$${BET_LADDER[Math.min(v, maxBetIdx)]}`,
    },
    action1: isResult
      ? { label: '', color: resultColor, onPress: dismissResult, pulse: true }
      : confirm.armed
        ? { label: 'CANCEL', color: 'neutral', onPress: confirm.cancel } // escape hatch while armed
        : { label: 'HOW TO', color: 'neutral', onPress: toggleHowto },
    action2: isResult
      ? { label: '', color: resultColor, onPress: dismissResult, pulse: true }
      : { label: 'RANKS', color: 'neutral', onPress: toggleBoard },
    main: isResult
      ? { label: 'CONTINUE', color: 'amber', onPress: dismissResult }
      : settling || closing
        ? { label: 'SETTLING', color: 'amber', onPress: () => { }, loading: true }
        : isOpen
          ? { label: 'CASH OUT', color: 'up', onPress: () => void doCashOut() }
          : isOpening
            ? { label: 'OPENING', color: 'up', onPress: () => { }, loading: true }
            : phase === 'cashing'
              ? { label: 'CASH OUT', color: 'up', onPress: () => { }, loading: true }
              : cantAfford
                ? { label: 'TOP UP', color: 'amber', onPress: goTopUp }
                : confirm.armed
                  ? { label: 'CONFIRM', color: 'amber', onPress: confirm.press } // 2nd press places
                  : {
                    label: 'SPIN',
                    color: 'amber',
                    onPress: confirm.press, // 1st press arms (or places immediately if the gate is off)
                    loading: phase === 'placing' || phase === 'spinning',
                  },
  })

  // Layout: header (price/balance over the reel cluster) hairline-divided from the chart, so the live
  // line never runs behind the slot. Chart bleeds full width to the bottom; readout hangs bottom-left as a flat black panel.
  return (
    <GameScreen>
      {marketsLoading ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="shimmer h-24 w-2/3" />
        </div>
      ) : marketsError ? (
        <ScreenMessage title="Something slipped" />
      ) : playsPaused && phase === 'idle' ? (
        <ScreenMessage title="Plays paused" hint="Topping up gas" />
      ) : noLiveMarket ? (
        <ScreenMessage title="Market catching up" />
      ) : (
        <div className="relative flex h-full flex-col">
          {/* HEADER: persistent price/balance context; the deal zone (wheels, then dealt strip) sits below it. */}
          <div className="shrink-0 bg-black pt-[calc(var(--screen-rim,24px)+12px)]">
            <div className="flex items-start justify-between gap-3 px-[var(--screen-rim,24px)] pb-2">
              <div className="min-w-0">
                {/* The asset is no secret (one live market), so the live price shows at rest too, over the chart underneath. */}
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-text-3">{focusAsset}</div>
                <div className="tnum text-[34px] font-extrabold leading-none text-text"><LivePrice price={spot} /></div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                  {showReadouts && secsLeft != null ? 'Time' : 'Available'}
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

          {/* DEAL ZONE: big prize wheels through idle + the deal, morphing out to a compact dealt strip once the */}
          {/* round is live so the chart reclaims the height. Height collapses while the two layers cross-fade. */}
          <div
            className="relative shrink-0 overflow-hidden border-y border-white/25 bg-black"
            style={{
              height: bigWheels ? DEAL_ZONE_H : LOCKED_ZONE_H,
              transition: 'height 460ms cubic-bezier(0.4,0,0.2,1)',
            }}
          >
            {/* Wheels: fade + settle up as they hand off. pointer-events off, the console buttons drive them. */}
            <div
              className="absolute inset-0 flex"
              style={{
                opacity: bigWheels ? 1 : 0,
                transform: bigWheels ? 'translateY(0) scale(1)' : 'translateY(-10px) scale(0.7)',
                transformOrigin: 'center top',
                transition: 'opacity 300ms ease, transform 420ms cubic-bezier(0.4,0,0.2,1)',
                pointerEvents: 'none',
              }}
            >
              <DirectionWheel
                index={0}
                size={WHEEL_BIG}
                side={roundActive && lp ? lp.side : undefined}
                cycling={reelsCycling}
                landing={spinning}
                stopAt={SPIN_STOPS[0]}
              />
              <MultiplierWheel
                index={1}
                size={WHEEL_BIG}
                multiplier={roundActive && play ? play.multiplier : undefined}
                cycling={reelsCycling}
                landing={spinning}
                stopAt={SPIN_STOPS[1]}
                last
              />
            </div>

            {/* Compact dealt strip: the direction + multiplier the wheels landed on, the readout the chart rides under. */}
            <div
              className="absolute inset-0 flex items-center justify-center gap-8 px-[var(--screen-rim,24px)]"
              style={{ opacity: bigWheels ? 0 : 1, transition: 'opacity 300ms ease 120ms', pointerEvents: 'none' }}
            >
              {lp && (
                <>
                  <div className="text-center">
                    <div className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-text-3">Up Down</div>
                    <div
                      className={cnm('tnum text-[26px] font-extrabold leading-none', lp.side === 'up' ? 'text-up' : 'text-down')}
                      style={{ textShadow: `0 0 14px var(--color-${lp.side === 'up' ? 'up' : 'down'})` }}
                    >
                      {lp.side === 'up' ? '▲ UP' : '▼ DOWN'}
                    </div>
                  </div>
                  <div className="h-9 w-px bg-line-strong" />
                  <div className="text-center">
                    <div className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-text-3">Multiplier</div>
                    <div
                      className="tnum text-[26px] font-extrabold leading-none text-brand-500"
                      style={{ textShadow: '0 0 14px var(--color-brand-500)' }}
                    >
                      {fmtMult(multiplier)}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* CHART: one full-bleed chart on the dealt/live asset, bounded between the slot header and the footer. */}
          <div className="relative min-h-0 flex-1">
            {/* COUNTDOWN: big faded watermark behind the chart line (canvas clears via clearRect, so it shows through). */}
            {/* Only while a round runs, tracking the real on-chain buzzer the timer counts to. */}
            {showReadouts && secsLeft != null && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
                <span className="tnum font-black leading-none text-text opacity-15 text-[clamp(64px,18vh,128px)]">{secsLeft}</span>
              </div>
            )}
            <Chart
              asset={focusAsset}
              overlays={revealOverlays ? overlays : undefined}
              livePriceRef={livePriceRef}
              initialPrice={spotByAsset[focusAsset]}
              onPrice={handlePrice}
              frozen={settling}
              className="absolute inset-0"
            />
            {/* Dims the chart while the reels tumble so attention sits on the slot; the un-dim is the first frame of the landing beat. */}
            <div
              className={cnm(
                'pointer-events-none absolute inset-0 bg-black transition-opacity duration-150',
                reelsCycling ? 'opacity-40' : 'opacity-0',
              )}
            />
          </div>

          {/* FOOTER: full-width readout under the chart, live VALUE while running, bet + how-to-start at rest. Content hugs the left, clear of the PLAY body. */}
          {/* Tall enough that the chart ends at this band's top, so the bottom-most chart never runs under the PLAY button. */}
          <div className="shrink-0 border-t border-line-strong bg-black px-[var(--screen-rim,24px)] pb-[var(--screen-rim,24px)] pt-3.5 min-h-[var(--screen-notch,21%)]">
            {/* Height tracks the device's occluded bottom-right, projected as --screen-notch by ConsoleCanvas, so this */}
            {/* readout's top meets the PLAY button's top at any scale/zoom (a fixed px would drift); 21% is the pre-projection fallback. */}
            <div className="max-w-[60%]">
              {confirm.armed ? (
                <TradeConfirmSheet details={confirm.armed} remainingMs={confirm.remainingMs} />
              ) : opening ? (
                <FooterStatusPanel
                  kicker="Opening"
                  head="OPENING"
                  recap={dealLine}
                  sweep
                />
              ) : settling ? (
                <FooterStatusPanel
                  kicker={`Settling · ${settleSecs}s`}
                  head="SETTLING"
                  recap={dealLine}
                  progress={Math.min(94, (settleMs / SETTLE_EXPECT_MS) * 100)}
                />
              ) : cashingOut ? (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Cashing out</div>
                  <div className="tnum text-[40px] font-extrabold leading-none text-text">
                    ${formatExactDecimal(live?.markValue ?? play?.markValue ?? '0')}
                  </div>
                  <div className="mt-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-text-2">{dealLine}</div>
                  <div className="mt-3 h-1 w-[200px] max-w-full overflow-hidden bg-line-strong">
                    <div
                      className="h-full bg-brand-500 transition-[width] duration-300 ease-out"
                      style={{ width: `${Math.min(92, (cashMs / CASHOUT_SETTLE_MS) * 100)}%` }}
                    />
                  </div>
                </>
              ) : showReadouts ? (
                <>
                  <div className="flex items-center gap-2">
                    <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                      If it ends now
                    </div>
                    {onTarget != null && (
                      <span
                        className={cnm(
                          'inline-flex items-center border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.1em]',
                          onTarget ? 'border-up/60 text-up' : 'border-down/60 text-down',
                        )}
                      >
                        {onTarget ? 'On target' : 'Off'}
                      </span>
                    )}
                  </div>
                  <LiveVerdictPanel
                    winning={onTarget}
                    payout={live?.maxPayout ?? play?.maxPayout ?? '0'}
                    cashoutPnl={live?.pnl ?? play?.pnl ?? '0'}
                  />
                  <div className="mt-2.5 grid grid-cols-3 gap-x-3">
                    <Cell label="Mult" value={fmtMult(multiplier)} />
                    <Cell label="Cost" value={`$${formatExactDecimal(live?.entryValue ?? play?.entryValue ?? '0')}`} />
                    <Cell label="Win" value={`$${formatExactDecimal(live?.maxPayout ?? play?.maxPayout ?? '0')}`} />
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
                    <span className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-text-3">Amount</span>
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

      {phase === 'result' && play && (
        <ResultOverlay
          play={play}
          streak={streak}
          winTitle="YOU WON"
          cashoutTitle="CASHED OUT"
          loseTitle="MISSED"
        />
      )}
      {overlay === 'howto' && (
        <InstructionOverlay
          lines={[
            ['SPIN', 'Deals a direction (up or down) and a multiplier.'],
            ['TARGET', 'The price to reach, in your direction. A 2x sits just past your entry, so a small move your way wins. Bigger multipliers sit further out.'],
            ['WIN', 'Land past the target at the buzzer to win your play amount x the multiplier. A touch on the way does not count, only where it ends.'],
            ['CASH OUT', 'Take the live value any time before the buzzer. Ahead? Cash out to lock it in before it can turn.'],
          ]}
        />
      )}
      {overlay === 'board' && <GameLeaderboardOverlay game="lucky" title="Lucky" />}
    </GameScreen>
  )
}
