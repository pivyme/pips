import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useConsoleControls } from '@/components/console/controls'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { useLiveMarkets } from '@/hooks/useLiveMarkets'
import { GameLeaderboardOverlay } from '@/components/game/GameLeaderboardOverlay'
import {
  FooterStatusPanel,
  InstructionOverlay,
  LiveValuePanel,
  ResultOverlay,
} from '@/components/game/gamePanels'
import { GameScreen, ScreenMessage } from '@/components/game/screen'
import { TradeConfirmSheet, useTradeConfirm } from '@/components/game/tradeConfirm'
import { LivePrice } from '@/components/game/LivePrice'
import { LuckyCharts, Reel } from '@/components/game/lucky/LuckyReels'
import {
  usePhaseElapsed,
  usePlayResolutionWatch,
  useRoundCountdown,
} from '@/hooks/useGameRound'
import { haptic } from '@/lib/haptics'
import { slotSpin, slotTick, slotPick, startLuckyBgm, stopLuckyBgm, luckyWin, luckyCashout, luckyLose } from '@/lib/sound'
import { api, type LuckyParams, type PlayDTO, type PlayStatus, type Side } from '@/lib/api'
import { placePlay, cashOut } from '@/lib/sui/predict'
import { betLadder } from '@/lib/sui/config'
import { toastError } from '@/lib/errors'
import { useAuth } from '@/lib/auth'
import { useActivePlay } from '@/lib/activePlay'
import { formatExactDecimal, formatStringToNumericDecimals } from '@/utils/format'

// LUCKY, the hero. Hit SPIN: three reels (asset, direction, multiplier) snap to a server-dealt slot
// pull, the position opens on the chart with a TARGET line, then ride the live value and CASH OUT, or
// hold to the buzzer for a spread-free WIN/LOSE. Every round is a real Predict mint/redeem; demo mode
// runs the same flow on the in-memory model. The screen layout, top to bottom: a header (live price,
// balance) over a full-width slot band, a bounded chart, then a full-width readout footer (the device
// body owns the bottom-right). Teenage Engineering language throughout (docs/SCREEN.md): flat black,
// mono labels, one amber accent, green/red for facts.
export const Route = createFileRoute('/_app/games/lucky')({ component: LuckyScreen })

// BET ladder is sized to the live stake band (betLadder(), read inside the component).
// Shared persisted stake index (home idle wheel writes the same key, see ConsoleCanvas).
const STAKE_KEY = 'pips_stake_idx'
// Reel cycle pools (cosmetic blur before the snap). The real targets come from the dealt play.
// Preferred order for the stacked asset panel (the rest of the live markets follow, capped at 3).
const PREFERRED = ['BTC', 'SUI', 'ETH', 'SOL']
const DIR_POOL = ['UP', 'DOWN']
const MULT_POOL = ['2x', '3x', '5x', '10x']
const SPIN_STOPS = [720, 980, 1240] // staggered reel stops (ms)
const SPIN_TOTAL = 1320
// After the reels lock, the dealt chart holds lit + flashed (the slot "locking in" its pick) for this
// long before it expands to fill, so the selection reads as a beat, not an instant snap.
const LOCKIN_MS = 650
// The chart's grow/collapse ease (matches the CSS flex-grow duration). The entry/target overlays only
// reveal once the expand has finished, so the chart is fully open before the reference lines draw on it.
const EXPAND_MS = 600
// The result screen is dismissed with a button (CONTINUE), so this is only a safety auto-advance for an
// idle player. Generous, so it never yanks the result away mid-read, but still recovers an AFK screen.
const RESULT_MS = 6500
const ROUND_SEC = 15 // fallback only; the play's real on-chain expiry drives the countdown
// Safety-net poll of the play, independent of the live SSE. The SSE carries the smooth PnL but its
// socket can silently drop (expired stream token, proxy timeout), which is what stranded the screen
// on OPENING / SETTLING forever. This guarantees the terminal frame always lands.
const WATCHDOG_MS = 3000
const SETTLE_EXPECT_MS = 12000 // the settle progress bar eases toward (never to) full over this window
// Cash-out settling beat: min dwell + the progress-bar window. The redeem itself can land in ~120ms
// (demo), too fast to read, so doCashOut holds the beat open this long and the bar eases over it.
const CASHOUT_SETTLE_MS = 1100
// Cash-out is a pre-expiry redeem; a tap in the final beat builds a tx that lands AFTER the buzzer,
// when the oracle is no longer quoteable (EOracleExpired) and the round can only settle. So we disarm
// CASH OUT this far ahead of expiry (a tx round-trip's worth) and let the round auto-settle. The
// countdown already knows the exact close, so there is nothing to cash out in this window.
const CASHOUT_LOCKOUT_MS = 1500
const TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out', 'error'])
// Terminal states that resolve to a win/loss RESULT screen. 'error' is excluded: an errored play is
// a background mint that could not open (chips safe), handled as a clean re-rack, not a result.
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
  const navigate = useNavigate()
  const { track } = useActivePlay()

  // One persistent stake shared with the home wheel (same ladder), so it stays put across navigation.
  const [betIdx, setBetIdx] = useLocalStorage(STAKE_KEY, 2)
  const [phase, setPhase] = useState<Phase>('idle')
  const [play, setPlay] = useState<PlayDTO | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [spot, setSpot] = useState<number | null>(null)
  const [overlay, setOverlay] = useState<Overlay>('none')
  // Which stacked chart is lit while the reels spin (the slot picking an asset). Locks to the dealt
  // asset on open, then that chart expands.
  const [highlightAsset, setHighlightAsset] = useState<string | null>(null)
  // Decoupled from the lock: the dealt chart first holds highlighted (LOCKIN_MS), THEN this flips and
  // it expands. So the selection plays as a beat instead of the chart snapping open the instant it lands.
  const [expandChart, setExpandChart] = useState(false)
  // The entry/target overlays hold off until the chart has finished expanding, so they draw onto the
  // open chart rather than flashing onto the still-collapsing stack.
  const [revealOverlays, setRevealOverlays] = useState(false)

  const finalized = useRef(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const balanceSyncedPlayId = useRef<string | null>(null)
  // Latest focused-asset spot + the asset it belongs to (set together in onPrice), for the header big
  // price and the play-time debug log. The ENTRY line is never derived from this display feed, it only
  // ever draws the backend's real oracle entrySpot.
  const spotRef = useRef<number | null>(null)
  const spotAssetRef = useRef<string | null>(null)
  // Latest live price per asset, written by every chart row without a re-render. The header big
  // price tracks the focused asset; the play-time debug log reads the dealt asset off here.
  const pricesRef = useRef<Record<string, number>>({})
  const focusAssetRef = useRef<string>('')
  // The chart's eased leading price, written every frame by the Chart for visual tracking only.
  // Financial values come from the backend's on-chain Predict quote.
  const livePriceRef = useRef(0)

  // spotByAsset feeds each chart its initial price so it paints a live line on mount; allAssets keeps
  // the stack full when fewer than three are live this instant. Both come from the shared feed, which
  // graces brief chain blips so a ladder roll never flashes "Market catching up".
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
  // Below the cheapest rung entirely: SPIN would just round-trip an INSUFFICIENT_DUSDC rejection, so
  // the idle button becomes the actual next step instead of a dead-end error toast.
  const cantAfford = balance < BET_LADDER[0]

  const lp = play ? (play.params as LuckyParams) : null
  // The asset panel: up to three live markets stacked as live charts (BTC/SUI/ETH first). The dealt
  // asset is always included so a spin always has a chart to expand into. focusAsset is the one the
  // header price + the entry pipeline track (the dealt asset mid-round, the primary at rest).
  const displayAssets = useMemo(() => {
    const rank = (a: string) => {
      const i = PREFERRED.indexOf(a)
      return i < 0 ? 99 : i
    }
    const byPref = (arr: string[]) => [...arr].sort((a, b) => rank(a) - rank(b))
    const out: string[] = []
    const add = (a: string | undefined) => {
      if (a && !out.includes(a) && out.length < 3) out.push(a)
    }
    // The dealt asset always leads so its chart is in the stack to expand into mid-round. Then a stable
    // preferred order over every market we have (so the stack never reshuffles as oracles roll live in
    // and out), finally padded with the feed-known fallbacks, so the stack is ALWAYS three charts even
    // when only one or two are live this instant. Non-live charts are display-only; you always play a
    // live one (the dealt asset).
    if (lp?.asset) add(lp.asset)
    byPref(allAssets).forEach(add)
    byPref([...PREFERRED]).forEach(add)
    return out
  }, [allAssets.join(','), lp?.asset])
  const focusAsset = lp?.asset ?? displayAssets[0]
  focusAssetRef.current = focusAsset
  // The position is real on-chain only once the mint confirms and the status leaves 'pending' (a failed
  // mint goes 'error'). We gate the entry/target on this, never on the optimistic 'pending' window, so
  // the line only ever shows for a play that actually opened, not one still landing or dead on gas.
  const status = live?.status ?? play?.status
  const entered = status != null && status !== 'pending' && status !== 'error'
  // The entry line shows while a live round is confirmed open. Not in 'result': once the round ends the
  // screen behind the result overlay resets to the default stack, so no entry/target lingers on it.
  const showEntry = entered && (phase === 'open' || phase === 'cashing')
  const strike = play?.market.strike ? parseFloat(play.market.strike) : undefined
  const spinning = phase === 'spinning'
  // Reels tumble from the instant SPIN is pressed through to the snap: the 'placing' wait (the
  // server deal) and the 'spinning' window. This is what makes the multi-second deal feel instant.
  const reelsCycling = phase === 'placing' || phase === 'spinning'
  // The live round readout (header price, footer P/L, the expanded chart). Excludes 'result': the round
  // is over, so the screen behind the result overlay falls back to the default stack + masked header.
  const showReadouts = play != null && (phase === 'open' || phase === 'cashing')
  // The reels carry the dealt direction/multiplier only while a round is genuinely in play. Otherwise
  // (result, idle) they reset to '?', so a finished round never leaves the last deal sitting in the slot.
  const roundActive = phase === 'spinning' || phase === 'open' || phase === 'cashing'
  const multiplier = live?.multiplier ?? play?.multiplier ?? 0
  // Entry reference: the real on-chain spot the strike was solved against (read live at the tap on the
  // backend), so the ENTRY line, the TARGET line, and settlement all agree. Never a client-guessed
  // display-feed value, so nothing fake ever flashes on the line, same rule as RANGE and MOONSHOT.
  const entrySpotNum = play?.entrySpot ? parseFloat(play.entrySpot) : NaN
  const entryVal = Number.isFinite(entrySpotNum) && entrySpotNum > 0 ? entrySpotNum : null
  // Chart overlays: the ENTRY line plus the directional TARGET line + winning-zone shading.
  const overlays =
    showEntry && entryVal != null
      ? { entry: entryVal, ...(strike != null && lp ? { target: { price: strike, side: lp.side } } : {}) }
      : undefined
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

  // Resolve a round from a status, idempotent via `finalized` so the SSE and the watchdog below can
  // both feed it and only the first one acts. 'error' = the background mint never opened (chips safe,
  // a failed mint debits nothing), so we re-rack cleanly. A win/loss/cashout refetches the finalized
  // play for the payout + redeem digest (the result screen + explorer link).
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
    onSnapshot: (snapshot) =>
      setLive({
        markValue: snapshot.markValue,
        pnl: snapshot.pnl,
        multiplier: snapshot.multiplier,
        entryValue: snapshot.entryValue,
        maxPayout: snapshot.maxPayout,
        status: snapshot.status,
      }),
    onTerminal: resolveTerminal,
  })

  useEffect(() => () => clearResetTimer(), [])

  // The bed rides the whole round: it fades in as the reels are dealt and out the moment the phase
  // leaves the live window (result, re-rack, or navigating away). finishResult also cuts it explicitly
  // so the win/lose sting always lands over silence. Bright + bouncy, the counterpart to Range's tension.
  const bedPlaying = reelsCycling || roundActive
  useEffect(() => {
    if (!bedPlaying) return
    startLuckyBgm()
    return () => stopLuckyBgm()
  }, [bedPlaying])

  // Ratchet under the spin: a quiet tick stream while the reels tumble, ended the moment they
  // settle. One stream for the whole slot (not per reel) keeps the texture subtle.
  useEffect(() => {
    if (!reelsCycling) return
    const iv = setInterval(() => slotTick(), 70)
    return () => clearInterval(iv)
  }, [reelsCycling])

  // Every stacked chart reports its ticks here. We stash them per asset (no re-render) and, for the
  // focused asset, drive the header price (same single ~1/s parent re-render as the old single chart).
  // Per-row label prices stay local to each row, so a tick never re-renders this.
  const handleRowPrice = useCallback((asset: string, p: number) => {
    pricesRef.current[asset] = p
    if (asset === focusAssetRef.current) {
      spotRef.current = p
      spotAssetRef.current = asset
      setSpot(p)
    }
  }, [])

  // Spin choreography for the asset panel: while the reels tumble, run the lit chart straight down
  // the stack on a steady loop (top, middle, bottom, repeat), like a slot reel scanning, not random
  // flicker. It locks onto the dealt asset the moment the round opens (below), then that chart expands.
  useEffect(() => {
    if (!reelsCycling || displayAssets.length === 0) return
    let i = 0
    setHighlightAsset(displayAssets[0])
    const iv = setInterval(() => {
      i = (i + 1) % displayAssets.length
      setHighlightAsset(displayAssets[i])
    }, 110)
    return () => clearInterval(iv)
  }, [reelsCycling, displayAssets.join(',')])

  // Lock the lit chart to the dealt asset once the round opens; clear it back to idle on re-rack.
  useEffect(() => {
    if (showReadouts && lp?.asset) setHighlightAsset(lp.asset)
    else if (phase === 'idle') setHighlightAsset(null)
  }, [showReadouts, lp?.asset, phase])

  // Hold the dealt chart highlighted for a beat (with a confirm beep), then expand it, then reveal the
  // entry/target overlays once it has finished opening. Reset the instant we leave a round so the next
  // spin starts from the collapsed stack and the whole sequence plays again.
  useEffect(() => {
    if (showReadouts && lp?.asset) {
      slotPick() // the slot commits to its market: a short ascending confirm under the lock-in flash
      const expand = setTimeout(() => setExpandChart(true), LOCKIN_MS)
      const reveal = setTimeout(() => setRevealOverlays(true), LOCKIN_MS + EXPAND_MS)
      return () => {
        clearTimeout(expand)
        clearTimeout(reveal)
      }
    }
    setExpandChart(false)
    setRevealOverlays(false)
  }, [showReadouts, lp?.asset])

  const doPlay = useCallback(async () => {
    // Idle only: a finished round must be dismissed back to the default screen first (CONTINUE), never
    // re-spun straight from the result. That keeps the post-round always landing on the 3-up stack.
    if (phase !== 'idle') return
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
    setOverlay('none')
    setPhase('placing')
    haptic('rigid')
    slotSpin()
    try {
      const { play: p } = await placePlay('lucky', { stake: bet })
      setPlay(p)
      track({ id: p.id, game: 'lucky' })
      // Price debug: line up what the chart is showing for the dealt asset against the prices the
      // backend actually solved the round on. entrySpot/target now read the live on-chain spot at the
      // tap, so any gap to chartLive is just the display feed's micro-motion, not a stale snapshot.
      if (import.meta.env.DEV) {
        const d = p.params as LuckyParams
        console.debug('[lucky] dealt', {
          asset: d.asset,
          side: d.side,
          mult: p.multiplier,
          bet,
          chartLive: pricesRef.current[d.asset],
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
  }, [phase, canPlay, bet, playsPaused, track])

  // Trade confirmation (opt-in, off by default). When on, SPIN arms first and CONFIRM places; the reel
  // deals the asset/side/multiplier, so the sheet honestly guards only the stake commitment. With the
  // setting off, press() short-circuits straight to doPlay(), so behavior is unchanged for everyone else.
  const confirm = useTradeConfirm(
    () => void doPlay(),
    () => ({ stake: bet, headline: 'I Feel Lucky', note: 'Reel deals the play' }),
  )
  // Keep an armed trade honest: disarm the moment placement would be blocked or the round leaves idle,
  // so CONFIRM can never fire a play the ready-state would have rejected.
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

  // Leave the result screen on any console button. Drops straight back to the default idle screen (the
  // 3-up stack + masked header), it does NOT re-spin. The auto-advance timer is the same destination,
  // so a button just gets there sooner. Touches only refs + setters, so a stable identity is fine.
  const dismissResult = useCallback(() => {
    clearResetTimer()
    haptic('selection')
    setPhase('idle')
  }, [])

  const goDeposit = useCallback(() => {
    haptic('rigid')
    void navigate({ to: '/menu/deposit' })
  }, [navigate])

  const toggleHowto = useCallback(() => {
    haptic('selection')
    setOverlay((o) => (o === 'howto' ? 'none' : 'howto'))
  }, [])
  const toggleBoard = useCallback(() => {
    haptic('selection')
    setOverlay((o) => (o === 'board' ? 'none' : 'board'))
  }, [])

  // The mint lands a beat after the reels snap, so CASH OUT only arms once the play is confirmed
  // 'open' on-chain; until then the button reads OPENING (cashing a not-yet-minted play would revert).
  const confirmed = live?.status === 'open'
  // Cash-out arms only while the round is comfortably pre-expiry. In the final beat (closeLocked) the
  // button flips to SETTLING and the round auto-settles, so a redeem can never land in the expiry gap.
  const isOpen = phase === 'open' && confirmed && !closeLocked
  const isOpening = phase === 'open' && !confirmed
  const closing = phase === 'open' && confirmed && closeLocked
  // On the result screen every button just continues, so the player never has to find the right one (and
  // the screen itself stays a pure, untappable readout). All three drop back to the default idle screen.
  const isResult = phase === 'result'
  // The two side buttons blink the outcome's color on the result screen (green win / red lose), so
  // CONTINUE reads at a glance instead of sitting as two neutral caps.
  const resultPositive =
    isResult && play != null && (play.status === 'won' || (play.status === 'cashed_out' && parseFloat(play.pnl ?? '0') >= 0))
  const resultColor: 'up' | 'down' = resultPositive ? 'up' : 'down'
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
                ? { label: 'TOP UP', color: 'amber', onPress: goDeposit }
                : confirm.armed
                  ? { label: 'CONFIRM', color: 'amber', onPress: confirm.press } // 2nd press places
                  : {
                    label: 'SPIN',
                    color: 'amber',
                    onPress: confirm.press, // 1st press arms (or places immediately if the gate is off)
                    loading: phase === 'placing' || phase === 'spinning',
                  },
  })

  // Layout: a solid header (price/balance over the reel cluster) divides off the chart with a foot
  // hairline, so the live line never runs behind the slot. The chart then bleeds full width to the
  // very bottom, and the readout hangs off the bottom-left as a flat black panel over it.
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
          {/* HEADER — persistent context (price · balance) over the slot band. No foot hairline; the
              full-width slot runs straight into the chart to save vertical room. */}
          <div className="shrink-0 bg-black pt-[calc(var(--screen-rim,24px)+12px)]">
            <div className="flex items-start justify-between gap-3 px-[var(--screen-rim,24px)] pb-4">
              <div className="min-w-0">
                {/* Masked until a chart is selected (a round opens), matching the anonymous stack. */}
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-text-3">{showReadouts ? focusAsset : 'XXX'}</div>
                <div className="tnum text-[34px] font-extrabold leading-none text-text">{showReadouts ? <LivePrice price={spot} /> : '$XXXX'}</div>
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

            {/* Two reels: direction + multiplier. The asset is no longer a reel, it is the chart the
                spin lights up and expands. One full-width slot band, hairline-divided, no foot border. */}
            <div className="flex border-t border-line-strong">
              <Reel
                index={0}
                label="Up Down"
                pool={DIR_POOL}
                target={roundActive && lp ? sideLabel(lp.side) : undefined}
                cycling={reelsCycling}
                landing={spinning}
                stopAt={SPIN_STOPS[1]}
                accent={roundActive && lp?.side === 'up' ? 'up' : roundActive && lp?.side === 'down' ? 'down' : undefined}
              />
              <Reel
                index={1}
                label="Multiplier"
                pool={MULT_POOL}
                target={roundActive && play ? fmtMult(play.multiplier) : undefined}
                cycling={reelsCycling}
                landing={spinning}
                stopAt={SPIN_STOPS[2]}
                accent={roundActive ? 'amber' : undefined}
                last
              />
            </div>
          </div>

          {/* ASSET PANEL — up to three live markets as stacked charts, bounded between the slot
              header and the footer. A spin lights one at random; on open the dealt chart expands to
              fill and the others collapse away, so the round plays out on the chosen market. */}
          <div className="relative min-h-0 flex-1">
            {/* COUNTDOWN — a big faded watermark sitting behind the chart line. The canvas is transparent
                (clearRect), so a layer under LuckyCharts shows through behind the line. Only while a round
                runs; it tracks the real on-chain buzzer the timer counts to. */}
            {showReadouts && secsLeft != null && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
                <span className="tnum font-black leading-none text-text opacity-15 text-[clamp(64px,18vh,128px)]">{secsLeft}</span>
              </div>
            )}
            {displayAssets.length > 0 ? (
              <LuckyCharts
                assets={displayAssets}
                focusAsset={focusAsset}
                selectedAsset={showReadouts ? (lp?.asset ?? null) : null}
                expanded={expandChart}
                selecting={reelsCycling}
                highlightAsset={highlightAsset}
                overlays={revealOverlays ? overlays : undefined}
                livePriceRef={livePriceRef}
                initialPrices={spotByAsset}
                onPrice={handleRowPrice}
              />
            ) : null}
          </div>

          {/* FOOTER — full-width readout bar under the chart, one top hairline. The live VALUE while
              a round runs, the bet + how-to-start at rest. Content hugs the left, clear of the PLAY
              body in the bottom-right. */}
          {/* Tall enough to span the device's occluded bottom-right (the PLAY body): the chart ends
              at this band's top, so the bottom-most chart never runs under the button. Content stays
              left-only; the empty space below it is the notch the body covers. */}
          <div className="shrink-0 border-t border-line-strong bg-black px-[var(--screen-rim,24px)] pb-[var(--screen-rim,24px)] pt-3.5 min-h-[var(--screen-notch,21%)]">
            {/* Height tracks the device's occluded bottom-right band, projected as --screen-notch by
                ConsoleCanvas, so this readout's top meets the PLAY button's top at any device scale or
                browser zoom (a fixed px would drift). 21% ~ the notch's share of the natural screen,
                the fallback before the canvas has projected. */}
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
                <LiveValuePanel
                  key={play?.id}
                  markValue={live?.markValue ?? play?.markValue ?? '0'}
                  pnl={live?.pnl ?? play?.pnl ?? '0'}
                  entryValue={live?.entryValue ?? play?.entryValue ?? '0'}
                  maxPayout={live?.maxPayout ?? play?.maxPayout ?? '0'}
                />
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
            ['SPIN', 'Deals an asset, a direction (up or down), and a multiplier.'],
            ['TARGET', 'The price to reach, in your direction. A 2x sits just past your entry, so a small move your way wins. Bigger multipliers sit further out.'],
            ['WIN', 'Land past the target at the buzzer to win bet x multiplier. A touch on the way does not count, only where it ends.'],
            ['CASH OUT', 'Take the live value any time before the buzzer. Ahead? Cash out to lock it in before it can turn.'],
          ]}
        />
      )}
      {overlay === 'board' && <GameLeaderboardOverlay game="lucky" title="Lucky" />}
    </GameScreen>
  )
}
