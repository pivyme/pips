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
import { rangeDebug, type RangeEntryIntent } from '@/lib/rangeDebug'
import { toastError } from '@/lib/errors'
import { useAuth } from '@/lib/auth'
import { cnm } from '@/utils/style'
import { formatExactDecimal, formatStringToNumericDecimals } from '@/utils/format'

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
// Cash-out safety window. The backend stops normal pushes near expiry and a redeem submitted this late
// may land after the oracle expires, so we disarm cash-out. This is NOT a settled result: only an
// on-chain settlement_price or the finalized play may claim the outcome.
const SETTLE_LOCK_MS = 5000
// Cash-out settling beat: hold the 'cashing' state open at least this long so the result lands as a
// deliberate moment instead of snapping straight from the press to the result. Through it the main
// button stays a no-op (CASHING OUT), absorbing the follow-up taps that otherwise blow past the result
// into a fresh PLAY. Mirrors Lucky, so a mid-round cash-out reads exactly like a win/lose settle.
const CASHOUT_SETTLE_MS = 1100
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

// Whether the chain's frozen settlement (lock) price lands in the raw band, matching the on-chain
// (lower, upper] settlement. Console-audit only: lets the early-locked verdict be checked against the
// final won/lost result. Null until a real lock price exists.
function predictedInZone(play: PlayDTO, lockPrice: string | null): boolean | null {
  if (!lockPrice) return null
  const ln = parseFloat(lockPrice)
  const lo = play.market.lower ? parseFloat(play.market.lower) : NaN
  const hi = play.market.upper ? parseFloat(play.market.upper) : NaN
  if (!Number.isFinite(ln) || !Number.isFinite(lo) || !Number.isFinite(hi)) return null
  return ln > lo && ln <= hi
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
  // In/out of the band is visual context from the same eased price the chart paints. Money values are
  // independent and come from the on-chain redeem quote.
  const [zoneLive, setZoneLive] = useState<boolean | null>(null)
  // Exact oracle settlement_price, sent only after the settlement transaction lands. It may arrive
  // briefly before the play's redeem/DB finalization.
  const [lockPrice, setLockPrice] = useState<string | null>(null)

  const finalized = useRef(false)
  const watchdogRun = useRef(0)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const balanceSyncedPlayId = useRef<string | null>(null)
  const wasInside = useRef<boolean | null>(null) // last in/out band state, for the crossing tick
  const zoneRef = useRef<boolean | null>(null) // mirrors zoneLive so the rAF only re-renders on a real flip
  // Chart<->oracle feed alignment. The chart line and the oracle (band/entry/settlement) are slightly
  // different samples of the same price, so the oracle values sit ~0.1% off the line and a tight band's
  // ENTRY/edges visibly float away from it. We capture the gap ONCE at open (chart price - oracle entry)
  // and shift every oracle-space overlay by it, so they sit exactly on the line. It is a uniform shift,
  // so inside/outside (and the real win/lose, which comes from the chain) are unchanged.
  const feedOffsetRef = useRef(0)
  const offsetPlayId = useRef<string | null>(null)
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
  // Pin the asset to the live play only while THIS round is actually live on-chain (open / cashing /
  // result). A finished round's `play` lingers (the result overlay still reads it) AND it stays set
  // through the next PLAY press while the new mint resolves. Gating on `phase !== 'idle'` would snap
  // the asset back to the previous round's coin the instant you pressed PLAY on a different one, which
  // resubscribed the chart to the wrong asset, left the live-price ref stale, and poisoned the feed
  // offset (flattening the chart). Gate on the live phases so after switching coins the selector +
  // chart follow the new pick straight through placing.
  const asset =
    play && (phase === 'open' || phase === 'cashing' || phase === 'result')
      ? play.params.asset
      : activeAsset

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
  // Capture the chart<->oracle feed offset ONCE per round, the first open render where both the chart
  // price and the oracle entry are known. Done in render (guarded + idempotent per play id) so the shift
  // is applied on the same frame the band appears, with no flash of the unaligned position.
  const entrySpotNum = play?.entrySpot ? parseFloat(play.entrySpot) : NaN
  if (play && phase === 'open' && offsetPlayId.current !== play.id) {
    const ec = livePriceRef.current
    if (Number.isFinite(entrySpotNum) && entrySpotNum > 0 && ec > 0) {
      offsetPlayId.current = play.id
      // The offset only corrects a ~0.1% chart-vs-oracle sampling gap. If the chart price ref is
      // momentarily from a just-switched asset (a cross-coin gap of tens of percent), refuse it: a
      // bogus offset would shove the band/entry thousands off and flatten the whole frame. 2% is
      // ~20x the real gap, so it cleanly separates a true sample gap from a stale wrong-asset read.
      const gap = ec - entrySpotNum
      feedOffsetRef.current = Math.abs(gap) <= entrySpotNum * 0.02 ? gap : 0
    }
  }
  const feedOffset = play && phase !== 'idle' ? feedOffsetRef.current : 0

  // Band bounds, shifted onto the chart by the feed offset so the band sits on the live line. The raw
  // oracle bounds still drive the real settlement; this is purely the on-screen alignment.
  const lower =
    play?.market.lower != null ? parseFloat(play.market.lower) + feedOffset : null
  const upper =
    play?.market.upper != null ? parseFloat(play.market.upper) + feedOffset : null
  // While PLAY is resolving (placing) we do NOT paint a guessed band: the chart keeps the live ±halfPct
  // preview (which simply tracks the line, never claims a fixed level), then snaps to the real bounds
  // when the play opens. The LOCKING IN readout + the press haptic/sound carry the "it registered"
  // feedback, so there is no fabricated number to correct later.
  // Inside the cash-out safety / settling window, seal the live band lighting. The result is still
  // pending until the oracle settlement transaction lands.
  const bandSealed =
    phase === 'open' && remainingMs != null && remainingMs <= SETTLE_LOCK_MS
  const band: BandOverlay | undefined =
    roundLive && lower != null && upper != null
      ? { lower, upper, locked: true, sealed: bandSealed }
      : spot != null
        ? { pct: halfPct }
        : undefined
  const showBand = phase !== 'result' || play != null

  // ENTRY line at the chart price the round opened on (oracle entry + the feed offset), so it sits ON the
  // live line instead of floating ~0.1% off it. Falls back to the band center if entry is somehow missing.
  const bandCenter = lower != null && upper != null ? (lower + upper) / 2 : null
  const entryLevel =
    Number.isFinite(entrySpotNum) && entrySpotNum > 0
      ? entrySpotNum + feedOffset
      : bandCenter
  const showEntryLine = entryLevel != null && roundLive

  // Phase machine, derived from the live status + the countdown. The settlement price freezes
  // SETTLE_LOCK_MS before the buzzer, so the round has a clear lock-in window:
  //   opening  - the mint is still landing (band locked, not open on-chain yet)
  //   liveHold - open and far enough from expiry to submit a cash-out
  //   sealing  - cash-out safety window before expiry, result not settled yet
  //   settling - past the buzzer, waiting on the on-chain settle frame
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

  // Exact on-chain settlement price, available only after the settlement transaction has populated
  // oracle.settlement_price. Shift it into the chart feed's display space.
  const lockNum = lockPrice ? parseFloat(lockPrice) : null
  const lockDisp = lockNum != null && lockNum > 0 ? lockNum + feedOffset : null
  const settleLine = settling && lockDisp != null ? lockDisp : undefined

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
        entryValue: final.entryValue,
        maxPayout: final.maxPayout,
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
          entryValue: tick.entryValue,
          maxPayout: tick.maxPayout,
          status: tick.status,
        })
        if (tick.status === 'open' && balanceSyncedPlayId.current !== id) {
          balanceSyncedPlayId.current = id
          void refresh()
        }
        // Present only after the oracle settlement transaction has set a real settlement_price.
        setLockPrice(tick.lockPrice ?? null)
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
          entryValue: cur.entryValue,
          maxPayout: cur.maxPayout,
          status: cur.status,
        })
        if (cur.status === 'open' && balanceSyncedPlayId.current !== id) {
          balanceSyncedPlayId.current = id
          void refresh()
        }
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
    setLockPrice(null)
    feedOffsetRef.current = 0
    offsetPlayId.current = null
    // Drop the previous round's play before placing the next one. It lingers after a result (the
    // overlay reads it), and leaving it set through 'placing' is what let the screen snap back to the
    // old coin + stale band while the new mint resolved. A clean slate keeps placing on the new pick.
    setPlay(null)
    setLive(null)
    setOverlay('none')
    setPhase('placing')
    // Snapshot the UI numbers at the press so the console audit can diff them against the chain on open.
    dbgStage.current = { open: false, lock: false, result: false }
    const intent: RangeEntryIntent = {
      asset,
      stake,
      halfPct,
      uiSpot: spot ?? livePriceRef.current,
      chartPrice: livePriceRef.current,
      previewMult: idleMult,
      quoted: quotedMult,
    }
    entryIntentRef.current = intent
    rangeDebug.entry(intent)
    // Fire the committal confirm AT the press, not after the await: this (plus the LOCKING IN readout) is
    // what makes PLAY feel immediate instead of dead for the few seconds the backend takes to resolve the
    // band. We deliberately capture NO entry price here: the only entry we ever show is the real oracle
    // entrySpot that comes back on open, so there is no guessed number to correct later.
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
  }, [phase, canPlay, stake, asset, halfPct, spot, idleMult, quotedMult])

  const doCashOut = useCallback(async () => {
    // Armed only during the live hold (the button is hidden once the round is sealing/settling).
    if (!liveHold || !play) return
    setPhase('cashing')
    haptic('rigid')
    const started = Date.now()
    try {
      const { play: p } = await cashOut(play.id)
      // Hold the settling beat open so the result is a deliberate landing, even when the redeem returns
      // in ~120ms (demo). The CASHING OUT no-op rides this window, so a stray follow-up tap can't carry
      // through to a fresh play. Same beat Lucky uses.
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

  // Leave the result on any console button: drops straight back to the default idle screen, it does NOT
  // re-play. The auto-advance timer lands in the same place, a button just gets there sooner.
  const dismissResult = useCallback(() => {
    clearResetTimer()
    haptic('selection')
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

  // Track in/out off the 60fps eased chart price. Only re-render on a real flip. This is visual context,
  // not PnL. Once cash-out closes near expiry, the pill is hidden.
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

  // A tactile tick whenever the live price crosses into or out of your band, only during the live hold
  // (not once the outcome is sealing, where a late chart wiggle no longer changes the result).
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
    rangeDebug.open(play, entryIntentRef.current, feedOffsetRef.current, livePriceRef.current)
  }, [play, live?.status])

  // LOCK: once the chain freezes the settlement price (the round entered the expiry window). The lock
  // price implies a verdict; we log whether it lands in the raw band so it can be checked vs the result.
  useEffect(() => {
    if (!play || !lockPrice || dbgStage.current.lock) return
    dbgStage.current.lock = true
    rangeDebug.lock(play, {
      feedOffset: feedOffsetRef.current,
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
      feedOffset: feedOffsetRef.current,
      predictedInZone: predictedInZone(play, lockPrice),
      previewMult: intent?.previewMult,
      stake: intent?.stake ?? parseFloat(play.stake),
      lastLockPrice: lockPrice,
    })
  }, [phase, play])

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

  // The live P/L footer shows only while a round is in flight, NOT on the result (the RangeResult overlay
  // owns the terminal display. Mirrors Lucky.
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
      : `${asset} · ±${halfPct.toFixed(1)}% · Cost $${formatExactDecimal(playCost)}`

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
                        entry: showEntryLine ? entryLevel : undefined,
                        settle: settleLine,
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
                    Cash out closed · settles in {secsLeft ?? 0}s
                  </div>
                  <div className="text-[30px] font-extrabold leading-none text-brand-500">
                    FINAL SECONDS
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
                    <Cell label="Mult" value={`${mult.toFixed(2).replace(/\.?0+$/, '')}x`} />
                    <Cell label="Cost" value={`$${formatExactDecimal(playCost)}`} />
                    <Cell
                      label="Win"
                      value={`$${formatExactDecimal(live?.maxPayout ?? play?.maxPayout ?? '0')}`}
                    />
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

      {phase === 'result' && play && (
        <RangeResult play={play} feedOffset={feedOffset} />
      )}
      {overlay === 'howto' && <HowTo />}
      {overlay === 'board' && (
        <GameLeaderboardOverlay game="range" title="Range" />
      )}
    </GameScreen>
  )
}

// Payout-forward live readout. The big number is the prize you'd collect if the round settled right
// now: the full payout while the live price sits in the band (green), $0 while it's out (red). The
// caption carries the early-exit value, the real net you'd lock in by cashing out this instant, from
// the on-chain redeem quote (markValue - cost), so it reads minus when you're underwater. The in/out
// call rides `inside` (the same 60fps chart-synced zone the pill + band use), so the headline flips
// the instant the line crosses an edge; the payout itself comes from the chain.
function RangePnl({
  inside,
  payout,
  cashoutPnl,
}: {
  inside: boolean | null
  payout: string
  cashoutPnl: string
}) {
  const up = inside !== false // null (pre-first-sample, at the band center) and true read as in-zone
  const neg = cashoutPnl.trim().startsWith('-')
  return (
    <>
      <div
        className={cnm(
          'tnum text-[40px] font-extrabold leading-none',
          up ? 'text-up' : 'text-down',
        )}
      >
        {up ? `+$${formatExactDecimal(payout, { absolute: true })}` : '$0.00'}
      </div>
      <div className="mt-1 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-text-3">
        If you cash out now {neg ? '-' : '+'}${formatExactDecimal(cashoutPnl, { absolute: true })}
      </div>
    </>
  )
}

// The win/loss/cash-out moment. The verdict comes from the settled play status. The gauge only explains
// where the backend's frozen settlement price landed relative to the actual on-chain band.
function RangeResult({ play, feedOffset }: { play: PlayDTO; feedOffset: number }) {
  const reduced = useReducedMotion()
  const pnl = parseFloat(play.pnl)
  const won = play.status === 'won'
  const cashed = play.status === 'cashed_out'
  const lost = play.status === 'lost'
  const positive = won || (cashed && pnl > 0)
  const head = won ? 'IN THE ZONE' : cashed ? 'CASHED OUT' : 'OUT OF RANGE'
  // Shift the gauge by the same feed offset the chart used, so the band + settle price the player sees
  // here match the line and the RESULT marker they just watched (a uniform shift, verdict unchanged).
  const lo = play.market.lower ? parseFloat(play.market.lower) + feedOffset : null
  const hi = play.market.upper ? parseFloat(play.market.upper) + feedOffset : null
  const settled = play.settlePrice ? parseFloat(play.settlePrice) + feedOffset : null
  const hasGauge =
    !cashed &&
    lo != null &&
    hi != null &&
    settled != null &&
    Number.isFinite(lo) &&
    Number.isFinite(hi) &&
    Number.isFinite(settled) &&
    hi > lo
  // The inside/outside call follows the settled VERDICT (won == inside, lost == outside), the on-chain
  // truth, not a float price compare that can disagree right on a band edge and contradict the headline.
  // The price still places the marker + names which side. A cash-out has no band verdict, so it reads the
  // exit price directly (and a lost play that rounds onto the band is pushed to the nearer edge).
  const relation: 'below' | 'inside' | 'above' = !hasGauge
    ? 'inside'
    : won
      ? 'inside'
      : settled <= lo
        ? 'below'
        : settled > hi
          ? 'above'
          : cashed
            ? 'inside'
            : settled <= (lo + hi) / 2
              ? 'below'
              : 'above'
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
        {/* A settled loss pays $0, not minus the stake. Wins + cash-outs keep their real signed net. */}
        {lost
          ? `$${formatExactDecimal('0')}`
          : `${pnl >= 0 ? '+' : '-'}$${formatExactDecimal(play.pnl, { absolute: true })}`}
      </motion.div>
      <div className="mt-1 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-text-2">
        Payout ${formatExactDecimal(play.payout ?? '0')} · Cost ${formatExactDecimal(play.entryValue)}
      </div>
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
  const inside = relation === 'inside'
  const relationCopy = inside
    ? `${label} inside your band`
    : `${label} ${relation} your band`

  // Colored by `relation` so the marker's color, its position, and the copy always agree. For a settled
  // win/loss `relation` is the verdict (won -> inside, lost -> a side), so this matches the headline; for
  // a cash-out it reflects where the exit price actually sat (a green dot can never float in the red zone).
  return (
    <div className="mt-3 w-[280px] max-w-[72%]">
      <div className="relative h-5 border-y border-line-strong">
        <div className="absolute inset-y-0 left-1/4 w-1/2 bg-brand-500/20" />
        <div className="absolute inset-y-0 left-1/4 w-px bg-brand-500" />
        <div className="absolute inset-y-0 left-3/4 w-px bg-brand-500" />
        <div
          className={cnm(
            'absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 border-2 border-black',
            inside ? 'bg-up' : 'bg-down',
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
          inside ? 'text-up' : 'text-down',
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
