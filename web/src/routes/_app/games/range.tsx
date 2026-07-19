import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import NumberFlow from '@number-flow/react'
import toast from 'react-hot-toast'
import type { BandOverlay } from '@/components/game/Chart'
import type { PlayDTO, PlayStatus } from '@/lib/api'
import { useConsoleControls } from '@/components/console/controls'
import { Chart } from '@/components/game/Chart'
import { GameLeaderboardOverlay } from '@/components/game/GameLeaderboardOverlay'
import { FooterStatusPanel, InstructionOverlay } from '@/components/game/gamePanels'
import { LivePrice } from '@/components/game/LivePrice'
import { RangePnl, RangeResult } from '@/components/game/range/RangePanels'
import {
  Cell,
  GameScreen,
  ScreenMessage,
} from '@/components/game/screen'
import { TradeConfirmSheet, useTradeConfirm } from '@/components/game/tradeConfirm'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { useLiveMarkets } from '@/hooks/useLiveMarkets'
import {
  usePhaseElapsed,
  usePlayResolutionWatch,
  useRestoreOpenPlay,
  useRoundCountdown,
} from '@/hooks/useGameRound'
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
import { api } from '@/lib/api'
import { cashOut, placePlay } from '@/lib/sui/predict'
import { betLadder, netStakeUsd } from '@/lib/sui/config'
import { rangeDebug, type RangeEntryIntent } from '@/lib/rangeDebug'
import { toastError } from '@/lib/errors'
import { useAuth } from '@/lib/auth'
import { useActivePlay } from '@/lib/activePlay'
import { rv2LivePlayIds } from '@/lib/rangeV2'
import { cnm } from '@/utils/style'
import { formatExactDecimal, formatStringToNumericDecimals } from '@/utils/format'

// RANGE: the knob picks a payout tier (bigger pays = tighter band, longer odds), PLAY locks the band around
// the live price, hold to the buzzer for a real spread-free mint_range settle, or CASH OUT early.
// The tier's multiple is time-independent (1x leverage, ~1/prob); the band width is what tracks the round
// clock, so it visibly tightens as the buzzer nears. Layout: web/CLAUDE.md, style: docs/SCREEN.md.
export const Route = createFileRoute('/_app/games/range')({
  component: RangeScreen,
})

// Persisted stake index shared with Lucky + the home idle wheel (same key), so the chosen chip
// survives navigation and reloads instead of resetting each mount.
const STAKE_KEY = 'pips_stake_idx'
// Cold-start knob ladder until the server tier quotes land: mirrors backend RANGE_TIER_PROBS defaults
// (mult = (1/p)*0.96, sigmaMult = z((1+p)/2), halfPct at a nominal 30s round). Estimate only, snaps on fetch.
const FALLBACK_TIERS: Array<TierView> = [
  { tier: 0, prob: 0.85, multiplier: 1.13, sigmaMult: 1.44, halfPct: 0.077 },
  { tier: 1, prob: 0.65, multiplier: 1.48, sigmaMult: 0.935, halfPct: 0.05 },
  { tier: 2, prob: 0.45, multiplier: 2.13, sigmaMult: 0.598, halfPct: 0.032 },
  { tier: 3, prob: 0.3, multiplier: 3.2, sigmaMult: 0.385, halfPct: 0.021 },
  { tier: 4, prob: 0.18, multiplier: 5.33, sigmaMult: 0.228, halfPct: 0.012 },
  { tier: 5, prob: 0.11, multiplier: 8.73, sigmaMult: 0.138, halfPct: 0.0074 },
  { tier: 6, prob: 0.065, multiplier: 14.77, sigmaMult: 0.082, halfPct: 0.0044 },
]
// Default tier the knob lands on at mount: the middle rung.
const DEFAULT_TIER_IDX = 2
const SECONDS_PER_YEAR = 365.25 * 24 * 3600
const FALLBACK_ASSETS = ['BTC', 'ETH', 'SUI', 'SOL', 'DEEP']
const TOKEN_LOGOS: Record<string, string> = {
  BTC: '/assets/images/coins/btc-logo.png',
  ETH: '/assets/images/coins/eth-logo.png',
  SUI: '/assets/images/coins/sui-logo.png',
}
const NOMINAL_ROUND_SEC = 30 // the idle multiplier preview's reference; the real round = oracle expiry
// Safety auto-advance for an idle player (result is normally dismissed via CONTINUE); generous so it
// never cuts a read short. Matches Lucky.
const RESULT_MS = 6500
// Cash-out safety window: a redeem submitted this late could land after oracle expiry, so cash-out
// disarms here. Not a settled result, only an on-chain settlement_price or the finalized play can claim it.
const SETTLE_LOCK_MS = 5000
// Minimum 'cashing' dwell so the result lands as a deliberate beat, not an instant snap; the main button
// stays a no-op (CASHING OUT) through it, absorbing follow-up taps. Mirrors Lucky.
const CASHOUT_SETTLE_MS = 1100
// The settle progress bar eases toward (never to) full over this window once past the buzzer.
const SETTLE_EXPECT_MS = 12000
// Safety-net poll independent of the live SSE, whose socket can silently drop (expired token, proxy
// timeout) and strand the screen on OPENING/SETTLING forever. Guarantees the terminal frame lands. Same as Lucky.
const WATCHDOG_MS = 3000
const TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out', 'error'])
// Terminal states that resolve to a win/loss RESULT screen. 'error' is excluded: it's a background
// mint that could not open (chips safe), handled as a clean re-rack, not a result.
const RESULT_TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out'])

type Phase = 'idle' | 'placing' | 'open' | 'cashing' | 'result'
// What the knob steps through: a server tier quote, or the cold-start fallback (no expiryMs).
type TierView = {
  tier: number
  prob: number
  multiplier: number
  sigmaMult: number
  halfPct: number
  expiryMs?: number
}
type Live = {
  markValue: string
  pnl: string
  multiplier: number
  entryValue?: string
  maxPayout?: string
  status: PlayStatus
}
type Overlay = 'none' | 'howto' | 'board'

// Compact price for the band recap: 67,210 -> 67.2k, 3.94 -> 3.94.
const compact = (n: number): string =>
  n >= 1000
    ? `${(n / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k`
    : n.toLocaleString('en-US', { maximumFractionDigits: n >= 1 ? 2 : 4 })

// 83000ms -> '1:23' for the round-clock chip.
function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// Digit-easing readouts so a knob tier change eases the multiplier/payout instead of hard-swapping.
const MultFlow = ({ value }: { value: number }) => (
  <NumberFlow value={value} suffix="x" format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} />
)
const UsdFlow = ({ value }: { value: number }) => (
  <NumberFlow value={value} prefix="$" format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} />
)

// Whether the frozen lock price lands in the raw (lower, upper] band, matching on-chain settlement.
// Console-audit only, checks the early verdict against the final result. Null until a lock price exists.
function predictedInZone(play: PlayDTO, lockPrice: string | null): boolean | null {
  if (!lockPrice) return null
  const ln = parseFloat(lockPrice)
  const lo = play.market.lower ? parseFloat(play.market.lower) : NaN
  const hi = play.market.upper ? parseFloat(play.market.upper) : NaN
  if (!Number.isFinite(ln) || !Number.isFinite(lo) || !Number.isFinite(hi)) return null
  return ln > lo && ln <= hi
}

function RangeScreen() {
  const { refresh, user } = useAuth()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { track } = useActivePlay()

  const [tierIdx, setTierIdx] = useLocalStorage('pips_range_tier', DEFAULT_TIER_IDX) // knob index into the payout-tier ladder, persisted so it survives leaving and returning
  // One persistent stake shared with Lucky + the home wheel (same ladder), so it stays put across nav.
  const [stakeIdx, setStakeIdx] = useLocalStorage(STAKE_KEY, 2)
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null) // the player's pick, by symbol
  const [phase, setPhase] = useState<Phase>('idle')
  const [play, setPlay] = useState<PlayDTO | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [spot, setSpot] = useState<number | null>(null)
  const [overlay, setOverlay] = useState<Overlay>('none')
  // In/out of the band is visual context from the same eased price the chart paints. Money values are
  // independent and come from the on-chain redeem quote.
  const [zoneLive, setZoneLive] = useState<boolean | null>(null)
  // Exact oracle settlement_price, sent only after the settlement transaction lands. It may arrive
  // briefly before the play's redeem/DB finalization.
  const [lockPrice, setLockPrice] = useState<string | null>(null)

  const finalized = useRef(false)
  // Set when the result was revealed early from the on-chain settlement price (lockPrice), before our redeem
  // tx finalized. The authoritative terminal frame still lands to refine numbers + credit the balance, it just
  // skips replaying the reveal. Reset each new play.
  const previewed = useRef(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const balanceSyncedPlayId = useRef<string | null>(null)
  const wasInside = useRef<boolean | null>(null) // last in/out band state, for the crossing tick
  const zoneRef = useRef<boolean | null>(null) // mirrors zoneLive so the rAF only re-renders on a real flip
  // The chart's eased leading price (the active dot), written every frame by the Chart. The live P/L
  // reads it to track the line at 60fps instead of the laggy ~2s backend mark.
  const livePriceRef = useRef(0)
  // RANGE console audit (lib/rangeDebug.ts): the UI numbers snapshotted at the press, plus a per-round
  // flag set so each lifecycle line (open / lock / result) logs exactly once.
  const entryIntentRef = useRef<RangeEntryIntent | null>(null)
  const dbgStage = useRef({ open: false, lock: false, result: false })

  // Shared feed: fast poll + grace so a ladder roll never flashes "no markets" at the player.
  const {
    liveAssets,
    noLiveMarket,
    playsPaused,
    isLoading: marketsLoading,
    isError: marketsError,
  } = useLiveMarkets()
  const statsQ = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() })
  const streak = statsQ.data?.stats.currentStreak ?? 0

  const assets = liveAssets.length ? liveAssets : FALLBACK_ASSETS
  // Held by symbol, not index: the live market list reorders as oracles roll, so an index would
  // silently point at a different token. Falls back to the first asset until picked, or if the pick drops.
  const activeAsset =
    selectedAsset && assets.includes(selectedAsset) ? selectedAsset : assets[0]
  // Pinned to the live play only during open/cashing/result, not phase !== 'idle': that would snap back
  // to the previous coin on PLAY press mid-mint, resubscribing the chart to the wrong asset and flattening it (stale feed offset).
  const asset =
    play && (phase === 'open' || phase === 'cashing' || phase === 'result')
      ? play.params.asset
      : activeAsset

  // BET clamps to what the balance affords, so the wheel never offers an unplayable bet.
  const STAKE_LADDER = betLadder()
  const balance = parseFloat(user?.balance ?? '0') || 0
  const maxBetIdx = Math.max(
    0,
    STAKE_LADDER.reduce((acc, v, i) => (v <= balance ? i : acc), 0),
  )
  const safeBetIdx = Math.min(stakeIdx, maxBetIdx)
  const stake = STAKE_LADDER[safeBetIdx]
  // Below the cheapest rung: PLAY would just round-trip INSUFFICIENT_DUSDC, so the button becomes
  // TOP UP instead of a dead-end toast.
  const cantAfford = balance < STAKE_LADDER[0]

  const canPlay = liveAssets.length > 0
  const roundLive =
    phase === 'open' || phase === 'cashing' || phase === 'result'
  // entrySpot + bounds are real and fixed the instant PLAY returns, so they draw immediately, held 'confirming' through the ~1s mint confirm, never guessed.
  // 'positioned' = a real band exists for the CURRENT live round (confirming included). Gated on roundLive,
  // not just a lingering play, so a finished round's band + ENTRY line drop back to the breathing preview
  // the instant it returns to idle instead of stranding last round's band on the chart.
  const enteredStatus = live?.status ?? play?.status
  const positioned = roundLive && enteredStatus != null && enteredStatus !== 'error'
  const confirming = enteredStatus === 'pending'

  // Server payout-tier quotes: stable multiples plus the live-band decay model, cached per asset so the
  // knob never flickers. Paused while a round is live; FALLBACK_TIERS carries the knob until the first fetch.
  const quotesQ = useQuery({
    queryKey: ['rangeTierQuotes', activeAsset],
    queryFn: () => api.rangeTierQuotes(activeAsset),
    enabled: canPlay && !!activeAsset && !roundLive,
    placeholderData: (prev) => prev,
    staleTime: 4_000,
    refetchInterval: 8_000,
    retry: false,
  })
  const tiers: Array<TierView> = quotesQ.data?.quotes.length ? quotesQ.data.quotes : FALLBACK_TIERS
  const model = quotesQ.data?.model ?? null
  const tierView = tiers[Math.min(tierIdx, tiers.length - 1)]
  const quotesRefetch = quotesQ.refetch

  // Wall-clock tick while idle so the round clock and the breathing band stay live between quote fetches.
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    if (roundLive) return
    const t = setInterval(() => setNowTick(Date.now()), 250)
    return () => clearInterval(t)
  }, [roundLive])

  // Time to the target round's buzzer. Inside minRoundMs a tap routes to the NEXT round: the chip flips
  // to NEXT ROUND, the width math clamps at the floor, and one refetch re-routes the quote.
  const roundEndsMs = model && tierView.expiryMs ? tierView.expiryMs - nowTick : null
  const nextRound = roundEndsMs != null && model != null && roundEndsMs < model.minRoundMs
  const boundaryRef = useRef(0)
  useEffect(() => {
    if (!nextRound || !tierView.expiryMs || roundLive) return
    if (boundaryRef.current === tierView.expiryMs) return
    boundaryRef.current = tierView.expiryMs
    void quotesRefetch()
  }, [nextRound, tierView.expiryMs, roundLive, quotesRefetch])

  // Live band half-width: sigmaMult * sigma(time left), floored at the shortest round a tap can enter.
  // Without a model (demo / cold start) the quote's static width is the truth.
  const halfLivePct =
    model && roundEndsMs != null
      ? tierView.sigmaMult *
        model.annualVol *
        Math.sqrt(Math.max(roundEndsMs, model.minRoundMs) / 1000 / SECONDS_PER_YEAR) *
        100
      : tierView.halfPct

  const liveMult = live?.multiplier ?? play?.multiplier
  // The tier's payout is time-independent (1x leverage), so the idle number IS the promise; the mint
  // snaps it to the real on-chain multiple moments after the tap.
  const idleMult = tierView.multiplier
  const mult = liveMult != null && liveMult > 0 ? liveMult : idleMult
  const { secsLeft, remainingMs, settleMs } = useRoundCountdown({
    enabled: phase === 'open',
    play,
    fallbackDurationSec: NOMINAL_ROUND_SEC,
  })
  const cashMs = usePhaseElapsed(phase === 'cashing')

  // Live ± preview while idle (the tier's breathing width), locked to the play's strike bounds while live. Gated on roundLive (not `play`, which lingers after settle) so the band resumes the preview instead of freezing.
  // Oracle-space overlays (band/entry/settle) sit on the line when drawn raw, no client feed offset needed.
  const entrySpotNum = play?.entrySpot ? parseFloat(play.entrySpot) : NaN

  // Band bounds, drawn raw. These oracle bounds drive the real settlement and now also sit on the line.
  const lower = play?.market.lower != null ? parseFloat(play.market.lower) : null
  const upper = play?.market.upper != null ? parseFloat(play.market.upper) : null
  // While placing, no guessed band is painted, the chart keeps the live ± preview; the moment the play resolves it snaps to the REAL bounds, never a fabricated number.
  // Inside the cash-out safety/settling window, seal the live band lighting, the result is still pending until settlement lands.
  const bandSealed =
    phase === 'open' && remainingMs != null && remainingMs <= SETTLE_LOCK_MS
  const band: BandOverlay | undefined =
    positioned && lower != null && upper != null
      ? { lower, upper, locked: true, sealed: bandSealed, confirming }
      : spot != null
        ? { pct: halfLivePct }
        : undefined
  const showBand = phase !== 'result' || play != null

  // ENTRY line at the oracle entry price the round opened on (drawn raw); falls back to the band
  // center if entry is somehow missing.
  const bandCenter = lower != null && upper != null ? (lower + upper) / 2 : null
  const entryLevel =
    Number.isFinite(entrySpotNum) && entrySpotNum > 0 ? entrySpotNum : bandCenter
  const showEntryLine = entryLevel != null && positioned

  // Phase machine off the live status + countdown (settlement price freezes SETTLE_LOCK_MS before the buzzer):
  // opening (mint landing) -> liveHold (cash-out armed) -> sealing (cash-out closed, pre-settle) -> settling (past buzzer).
  const confirmed = live?.status === 'open'
  const opening =
    phase === 'open' && (live?.status === 'pending' || remainingMs == null)
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

  // Exact on-chain settlement price, only available once oracle.settlement_price lands; drawn raw on the pinned line.
  const lockNum = lockPrice ? parseFloat(lockPrice) : null
  const settleLine = settling && lockNum != null && lockNum > 0 ? lockNum : undefined

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
        entryValue: final.entryValue,
        maxPayout: final.maxPayout,
        status: final.status,
      })
      void refresh() // the redeem landed: the balance now reflects the claimed chips
      // Settle/cashout moved the record: freshen stats (streak), achievements, and history.
      for (const key of ['stats', 'achievements', 'plays'])
        void qc.invalidateQueries({ queryKey: [key] })
      // The lockPrice preview already flipped to RESULT, played the sting, and armed auto-advance; the
      // terminal only refines the numbers + credits the balance above, so don't replay the reveal.
      if (previewed.current) return
      setPhase('result')
      stopRangeBgm() // cut the tension bed the instant it resolves, so the sting lands clean
      haptic(final.status === 'lost' ? 'error' : 'success')
      if (final.status === 'lost') rangeLose()
      else rangeWin()
      clearResetTimer()
      resetTimer.current = setTimeout(() => setPhase('idle'), RESULT_MS)
    },
    [refresh, qc],
  )

  // Early result reveal from the real on-chain settlement price. The SSE delivers lockPrice (the frozen
  // oracle settlement_price) within ~1s of Pyth settling, ~1-2s before our redeem tx finalizes. A range play
  // is 1x (no liquidation), so the verdict is a deterministic function of that price: settle in (lower, upper].
  // Reveal it now; the authoritative terminal frame lands right behind to refine + credit chips (finishResult).
  const revealFromLock = useCallback((p: PlayDTO, lock: number) => {
    previewed.current = true
    wasInside.current = null
    const lo = p.market.lower != null ? parseFloat(p.market.lower) : NaN
    const hi = p.market.upper != null ? parseFloat(p.market.upper) : NaN
    const won = lock > lo && lock <= hi // (lower, upper], the exact on-chain settlement rule
    const payout = won ? p.maxPayout : '0'
    const pnl = (parseFloat(payout) - parseFloat(p.entryValue)).toFixed(2)
    const preview: PlayDTO = { ...p, status: won ? 'won' : 'lost', payout, markValue: payout, pnl, settlePrice: String(lock) }
    setPlay(preview)
    setLive({ markValue: preview.markValue, pnl: preview.pnl, multiplier: preview.multiplier, entryValue: preview.entryValue, maxPayout: preview.maxPayout, status: preview.status })
    setPhase('result')
    stopRangeBgm()
    haptic(won ? 'success' : 'error')
    if (won) rangeWin()
    else rangeLose()
    clearResetTimer()
    resetTimer.current = setTimeout(() => setPhase('idle'), RESULT_MS)
  }, [])

  // Fire the early reveal the instant the on-chain settlement price lands past the buzzer. Skip the sub-tick
  // ambiguous edge (settle within ~1% of a band bound) and fall back to the terminal there, so a revealed
  // verdict can never disagree with the chain.
  useEffect(() => {
    if (finalized.current || previewed.current) return
    if (!settling || !confirmed) return // past the buzzer, on a confirmed real position only
    if (!play || play.game !== 'range') return
    if (lockNum == null || lockNum <= 0) return
    const lo = play.market.lower != null ? parseFloat(play.market.lower) : NaN
    const hi = play.market.upper != null ? parseFloat(play.market.upper) : NaN
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return
    const margin = (hi - lo) * 0.01 // wider than the display-vs-tick rounding; near a bound, wait for the terminal
    if (Math.abs(lockNum - lo) < margin || Math.abs(lockNum - hi) < margin) return
    revealFromLock(play, lockNum)
  }, [settling, confirmed, lockNum, play, revealFromLock])

  // Resolves a round from a status, idempotent via `finalized` so the SSE and the watchdog can both feed it.
  // 'error' = the mint never opened (chips safe, clean re-rack); a win/loss/cashout refetches the finalized play.
  const resolveTerminal = useCallback(
    (status: PlayStatus, playId: string) => {
      if (finalized.current) return
      if (status === 'error') {
        finalized.current = true
        toast.error(
          'Could not open that play. Your chips are safe, play again.',
          { id: 'range-play-error' },
        )
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
    // Stay subscribed through the lockPrice-preview window too (phase flips to 'result' before finalized),
    // so the authoritative terminal frame still lands to refine + credit the balance.
    enabled: phase === 'open' || (phase === 'result' && !finalized.current),
    playId: play?.id,
    finalizedRef: finalized,
    watchdogMs: WATCHDOG_MS,
    syncedOpenPlayIdRef: balanceSyncedPlayId,
    refreshOnOpen: refresh,
    onSnapshot: (snapshot) => {
      // Once revealed early from the on-chain settlement price, ignore trailing 'open' marks so they can't
      // revert the shown result; the terminal frame (onTerminal) still refines it.
      if (previewed.current) return
      setLive({
        markValue: snapshot.markValue,
        pnl: snapshot.pnl,
        multiplier: snapshot.multiplier,
        entryValue: snapshot.entryValue,
        maxPayout: snapshot.maxPayout,
        status: snapshot.status,
      })
      setLockPrice(snapshot.lockPrice ?? null)
    },
    onTerminal: resolveTerminal,
  })

  useEffect(() => () => clearResetTimer(), [])

  // Restore a live round on (re)mount from the durable open-plays list, so leaving to Home and back, or a hard
  // refresh, drops you straight back onto the running band (chart, ENTRY, countdown, CASH OUT) instead of idle.
  // Excludes Range V2's plays (both mint `range`); the SSE watch + countdown take over from 'open'.
  const restoreOpenPlay = useCallback(
    (p: PlayDTO) => {
      finalized.current = false
      previewed.current = false
      wasInside.current = null
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
      track({ id: p.id, game: 'range' })
    },
    [track],
  )
  const { restorePending } = useRestoreOpenPlay({
    game: 'range',
    active: phase !== 'idle',
    onRestore: restoreOpenPlay,
    exclude: (p) => rv2LivePlayIds().has(p.id),
  })

  // Tension bed rides the whole active window: fades in on PLAY press, out the instant the phase leaves
  // it (cash out, settle, re-rack, navigate away). finishResult also cuts it so the sting lands over silence.
  const rangeActive = phase === 'placing' || phase === 'open'
  useEffect(() => {
    if (!rangeActive) return
    startRangeBgm()
    return () => stopRangeBgm()
  }, [rangeActive])

  const doPlay = useCallback(async () => {
    // Idle only: a finished round must be dismissed (CONTINUE) before replaying, never straight from the result.
    // restorePending holds the first tap after a cold refresh until restore resolves, so it never opens a second round.
    if (phase !== 'idle' || restorePending) return
    if (playsPaused) {
      toast.error('Plays paused while we top up. Back in a moment.', { id: 'paused' })
      return
    }
    if (!canPlay) {
      toast.error('No live market right now. Try again in a sec.', {
        id: 'no-market',
      })
      return
    }
    clearResetTimer()
    finalized.current = false
    previewed.current = false
    wasInside.current = null
    setLockPrice(null)
    // Drop the previous play before placing the next one; it lingers after a result (the overlay reads
    // it), and leaving it set through 'placing' snapped the screen back to the old coin + stale band while the new mint resolved.
    setPlay(null)
    setLive(null)
    setOverlay('none')
    setPhase('placing')
    // Snapshot the UI numbers at the press so the console audit can diff them against the chain on open.
    dbgStage.current = { open: false, lock: false, result: false }
    const intent: RangeEntryIntent = {
      asset,
      stake,
      halfPct: halfLivePct,
      uiSpot: spot ?? livePriceRef.current,
      chartPrice: livePriceRef.current,
      previewMult: idleMult,
      quoted: model ? idleMult : undefined,
    }
    entryIntentRef.current = intent
    rangeDebug.entry(intent)
    // Fires at the press, not after the await, so PLAY feels immediate instead of dead during the backend
    // resolve. No entry price captured here either, the only entry ever shown is the real oracle entrySpot on open.
    haptic('heavy')
    rangeLock()
    try {
      const { play: p } = await placePlay('range', {
        stake,
        asset,
        tier: tierView.tier,
      })
      setPlay(p)
      track({ id: p.id, game: 'range' })
      setLive({
        markValue: p.markValue,
        pnl: p.pnl,
        multiplier: p.multiplier,
        entryValue: p.entryValue,
        maxPayout: p.maxPayout,
        status: p.status,
      })
      setPhase('open')
      haptic('selection') // a light tick as the position lands; the heavy confirm already fired on press
    } catch (e) {
      toastError(e)
      setPhase('idle')
    }
  }, [phase, canPlay, stake, asset, halfLivePct, spot, idleMult, model, tierView.tier, playsPaused, track, restorePending])

  // Trade confirmation (opt-in, off by default): PLAY arms, CONFIRM places; the sheet shows the odds +
  // payout the second press will lock. Off, press() places immediately.
  const confirm = useTradeConfirm(
    () => void doPlay(),
    () => ({
      stake,
      headline: `${asset} · ~${Math.round(tierView.prob * 100)}% odds`,
      multiplier: idleMult,
      // Net of the house rake (config.ts netStakeUsd): the position sizes off net, so this is the true
      // max win, never stake * idleMult. No-op in demo or when the rake is off.
      maxPayout: netStakeUsd(stake) * idleMult,
      note: 'Land inside the band at the buzzer',
    }),
  )
  // Disarms the moment placement would be blocked or idle ends, so CONFIRM can't fire a play the
  // ready-state rejected.
  useEffect(() => {
    if (phase !== 'idle' || cantAfford || !canPlay || playsPaused) confirm.disarm()
  }, [phase, cantAfford, canPlay, playsPaused, confirm.disarm])

  const doCashOut = useCallback(async () => {
    // Armed only during the live hold (the button is hidden once the round is sealing/settling).
    if (!liveHold || !play) return
    setPhase('cashing')
    haptic('rigid')
    const started = Date.now()
    try {
      const { play: p } = await cashOut(play.id)
      // Holds the settling beat open so the result lands deliberately even when redeem returns in ~120ms
      // (demo); the CASHING OUT no-op rides this window so a stray tap can't fall through to a fresh play. Same as Lucky.
      const wait = CASHOUT_SETTLE_MS - (Date.now() - started)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
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

  // Any console button leaves the result straight to idle, never a replay; the auto-advance timer lands
  // the same place, sooner.
  const dismissResult = useCallback(() => {
    clearResetTimer()
    haptic('selection')
    setPhase('idle')
  }, [])

  // Tracks in/out off the 60fps eased chart price, re-rendering only on a real flip. Visual context only,
  // not PnL; the pill hides once cash-out closes near expiry.
  useEffect(() => {
    if (!liveHold || lower == null || upper == null) {
      zoneRef.current = null
      setZoneLive(null)
      return
    }
    let raf = 0
    const loop = () => {
      const p = livePriceRef.current
      const now = p > 0 ? p > lower && p <= upper : null // (lower, upper] matches on-chain settlement
      if (now !== zoneRef.current) {
        zoneRef.current = now
        setZoneLive(now)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [liveHold, lower, upper])

  // A tactile tick whenever the live price crosses in/out of the band, only during the live hold (a late
  // wiggle while sealing no longer changes the result).
  useEffect(() => {
    if (!liveHold || zoneLive == null) return
    if (wasInside.current != null && wasInside.current !== zoneLive) {
      haptic('selection')
      rangeCross(zoneLive)
    }
    wasInside.current = zoneLive
  }, [zoneLive, liveHold])

  // === RANGE console audit (lib/rangeDebug.ts) ===
  // OPEN: once the mint confirms on-chain, diff the promised entry / mult / cost against what minted.
  useEffect(() => {
    if (!play || live?.status !== 'open' || dbgStage.current.open) return
    dbgStage.current.open = true
    rangeDebug.open(play, entryIntentRef.current)
  }, [play, live?.status])

  // LOCK: once the chain freezes settlement price; logs whether it lands in the raw band to check vs the final result.
  useEffect(() => {
    if (!play || !lockPrice || dbgStage.current.lock) return
    dbgStage.current.lock = true
    rangeDebug.lock(play, {
      uiLivePrice: livePriceRef.current,
      predictedInZone: predictedInZone(play, lockPrice),
    })
  }, [play, lockPrice])

  // SETTLE / CASH OUT: the terminal frame. Validate the predicted verdict, lock vs final settle, payout.
  useEffect(() => {
    if (phase !== 'result' || !play || dbgStage.current.result) return
    dbgStage.current.result = true
    const intent = entryIntentRef.current
    rangeDebug.result(play, {
      predictedInZone: predictedInZone(play, lockPrice),
      previewMult: intent?.previewMult,
      stake: intent?.stake ?? parseFloat(play.stake),
      lastLockPrice: lockPrice,
    })
  }, [phase, play])

  const goDeposit = useCallback(() => {
    haptic('rigid')
    void navigate({ to: '/menu/deposit' })
  }, [navigate])

  const cycleAsset = useCallback(() => {
    haptic('selection')
    if (!assets.length) return
    const i = assets.indexOf(activeAsset)
    setSelectedAsset(assets[(i + 1) % assets.length])
  }, [assets, activeAsset])
  // Left cap rotates game -> how to -> leaderboard -> game; each press advances one step and the label
  // names where the NEXT press lands. Tapping an overlay's backdrop also resets to 'none', keeping both exits in sync.
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
      label: 'PAYS',
      min: 0,
      max: tiers.length - 1, // step through the payout-tier ladder (safest to wildest)
      step: 1,
      value: tierIdx,
      onChange: setTierIdx,
      format: (v) => {
        const t = tiers[Math.min(v, tiers.length - 1)]
        return `${t.multiplier.toFixed(t.multiplier >= 10 ? 0 : 1)}x`
      },
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
      : confirm.armed
        ? { label: 'CANCEL', color: 'neutral', onPress: confirm.cancel } // escape hatch while armed
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
              label: 'FINAL',
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
                  label: 'CONFIRMING',
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
                  : cantAfford
                    ? { label: 'TOP UP', color: 'amber', onPress: goDeposit }
                    : confirm.armed
                      ? { label: 'CONFIRM', color: 'amber', onPress: confirm.press } // 2nd press places
                      : {
                          label: 'PLAY',
                          color: 'amber',
                          onPress: confirm.press, // 1st press arms (or places immediately if the gate is off)
                        },
  })

  // Footer P/L shows only while a round is in flight; the result overlay owns the terminal display. Mirrors Lucky.
  const showReadouts = play != null && (phase === 'open' || phase === 'cashing')
  const showZonePill = liveHold && zoneLive != null
  const settleSecs = Math.floor(settleMs / 1000)
  const firstRun =
    !statsQ.isLoading && (statsQ.data?.stats.gamesPlayed ?? 0) === 0
  const playCost = live?.entryValue ?? play?.entryValue ?? String(stake)
  // The locked play, read back under OPENING / SETTLING so the round always shows what's in flight.
  const recap =
    lower != null && upper != null
      ? `${asset} · ${compact(lower)}–${compact(upper)} · Cost $${formatExactDecimal(playCost)}`
      : `${asset} · ~${Math.round(tierView.prob * 100)}% odds · Cost $${formatExactDecimal(playCost)}`

  // A one-shot riser at the buzzer, the last seconds before the oracle settles, to spike the tension.
  useEffect(() => {
    if (settling) rangeBuzzer()
  }, [settling])

  // Layout mirrors Lucky: header band (price/balance) hairline-divided from the chart, which bleeds full
  // width but stays bounded above the footer; the readout spans the device's occluded bottom-right. Insets via ConsoleCanvas.
  return (
    <GameScreen>
      {marketsLoading ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="shimmer h-24 w-2/3" />
        </div>
      ) : marketsError ? (
        <ScreenMessage title="Could not load markets" />
      ) : playsPaused && phase === 'idle' ? (
        <ScreenMessage title="Plays paused" hint="Topping up gas" />
      ) : noLiveMarket ? (
        <ScreenMessage title="No live markets right now." />
      ) : (
        <div className="relative flex h-full flex-col">
          {/* HEADER: market + live price (left), balance/countdown (right); a foot hairline keeps the chart line off the text. */}
          <div className="shrink-0 border-b border-line-strong bg-black pt-[calc(var(--screen-rim,24px)+12px)]">
            <div className="flex items-start justify-between gap-3 px-[var(--screen-rim,24px)] pb-4">
              <div className="min-w-0">
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-text-3">
                  Range · {asset}
                </div>
                <div className="tnum text-[34px] font-extrabold leading-none text-text">
                  <LivePrice price={spot} />
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                  {sealing || settling
                    ? 'Final'
                    : showReadouts && secsLeft != null
                      ? 'Ends in'
                      : 'Available'}
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

          {/* CHART: bounded between header and footer; the band overlay rides inside it (live ±pct preview, then locked bounds). */}
          <div className="relative min-h-0 flex-1">
            {/* COUNTDOWN: big faded watermark behind the chart line (canvas clears to transparent); only while a round runs, tracking the real buzzer. */}
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
                        entry: showEntryLine ? entryLevel : undefined,
                        settle: settleLine,
                      }
                    : undefined
                }
                livePriceRef={livePriceRef}
                onPrice={(p) => setSpot(p)}
                frozen={settling}
                className="absolute inset-0"
              />
            ) : null}
          </div>

          {/* FOOTER: full-width readout, tall enough to span the device's occluded bottom-right; content hugs the left. */}
          {/* Shows the prize/stake at rest, live PnL (IN ZONE/OUT tag) once running, CONFIRMING on mint, SETTLING at the buzzer. */}
          <div className="shrink-0 border-t border-line-strong bg-black px-[var(--screen-rim,24px)] pb-[var(--screen-rim,24px)] pt-3.5 min-h-[var(--screen-notch,21%)]">
            <div className="max-w-[60%]">
              {confirm.armed ? (
                <TradeConfirmSheet details={confirm.armed} remainingMs={confirm.remainingMs} />
              ) : phase === 'placing' ? (
                <FooterStatusPanel
                  kicker="Locking band"
                  head="LOCKING IN"
                  recap={recap}
                  sweep
                />
              ) : opening ? (
                <FooterStatusPanel
                  kicker="Confirming"
                  head="CONFIRMING"
                  recap={recap}
                  sweep
                />
              ) : settling ? (
                <FooterStatusPanel
                  kicker={`Settling · ${settleSecs}s`}
                  head="SETTLING"
                  recap={recap}
                  progress={Math.min(94, (settleMs / SETTLE_EXPECT_MS) * 100)}
                />
              ) : sealing ? (
                <FooterStatusPanel
                  kicker={`Cash out closed · settles in ${secsLeft ?? 0}s`}
                  head="FINAL SECONDS"
                  recap={recap}
                  progress={Math.min(
                    96,
                    ((SETTLE_LOCK_MS - (remainingMs ?? 0)) / SETTLE_LOCK_MS) * 100,
                  )}
                />
              ) : cashing ? (
                <FooterStatusPanel
                  kicker="Cashing out"
                  head="CASHING OUT"
                  recap={recap}
                  tone="up"
                  progress={Math.min(92, (cashMs / CASHOUT_SETTLE_MS) * 100)}
                />
              ) : showReadouts ? (
                <>
                  <div className="flex items-center gap-2">
                    <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                      If it ends now
                    </div>
                    {showZonePill && (
                      <span
                        className={cnm(
                          'inline-flex items-center border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.1em]',
                          zoneLive
                            ? 'border-brand-500/60 text-brand-500'
                            : 'border-down/60 text-down',
                        )}
                      >
                        {zoneLive ? 'In zone' : 'Out'}
                      </span>
                    )}
                  </div>
                  <RangePnl
                    inside={zoneLive}
                    payout={live?.maxPayout ?? play?.maxPayout ?? '0'}
                    cashoutPnl={live?.pnl ?? play?.pnl ?? '0'}
                  />
                  <div className="mt-2.5 grid grid-cols-3 gap-x-3">
                    {/* The real minted multiple off the OrderMinted event, never the preview estimate; eased so the
                        CONFIRMING-estimate -> real-minted snap glides into place instead of hard-swapping. */}
                    <Cell label="Locked" value={<MultFlow value={mult} />} />
                    <Cell label="Cost" value={<UsdFlow value={parseFloat(playCost) || 0} />} />
                    <Cell label="Win" value={<UsdFlow value={parseFloat(live?.maxPayout ?? play?.maxPayout ?? '0') || 0} />} />
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
                  <div className="flex items-center gap-2">
                    <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                      Pays
                    </div>
                    {/* Round clock to the buzzer this tap settles at; flips to NEXT ROUND once a tap
                        would roll into the following minute market (quotes re-route right behind it). */}
                    {roundEndsMs != null && (
                      <span
                        className={cnm(
                          'inline-flex items-center border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.1em]',
                          nextRound
                            ? 'border-brand-500/60 text-brand-500'
                            : 'border-line-strong text-text-2',
                        )}
                      >
                        {nextRound ? 'Next round' : `Ends ${fmtClock(roundEndsMs)}`}
                      </span>
                    )}
                  </div>
                  {/* Payout is the hero; bet + win ride beside it so the readout stays two short rows. */}
                  <div className="mt-1 flex flex-wrap items-end gap-x-4 gap-y-1.5">
                    <div className="tnum text-[40px] font-extrabold leading-none text-brand-500">
                      <MultFlow value={idleMult} />
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 pb-0.5">
                      <Cell label="Bet" value={`$${stake}`} />
                      <Cell label="Win" value={<UsdFlow value={netStakeUsd(stake) * idleMult} />} />
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {phase === 'result' && play && <RangeResult play={play} />}
      {overlay === 'howto' && (
        <InstructionOverlay
          lines={[
            ['PAYS', 'Turn the knob to pick your payout. Bigger pays, tighter band, longer odds.'],
            ['PLAY', 'Locks the band around the live price. It tightens as the round clock runs.'],
            ['WIN', 'Land inside the band at the buzzer to win your play amount × the payout.'],
            ['CASH OUT', 'Take the live value any time before the buzzer.'],
          ]}
        />
      )}
      {overlay === 'board' && (
        <GameLeaderboardOverlay game="range" title="Range" />
      )}
    </GameScreen>
  )
}
