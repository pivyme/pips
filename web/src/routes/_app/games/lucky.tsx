import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useConsoleControls } from '@/components/console/controls'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { Chart, type ChartOverlays } from '@/components/game/Chart'
import { GameScreen, ScreenMessage } from '@/components/game/screen'
import { Stat } from '@/components/Stat'
import { haptic } from '@/lib/haptics'
import { slotSpin, slotTick, slotLock, slotPick, startLuckyBgm, stopLuckyBgm, luckyWin, luckyCashout, luckyLose } from '@/lib/sound'
import { api, streamPlay, type LuckyParams, type PlayDTO, type PlayStatus, type Side } from '@/lib/api'
import { placePlay, cashOut } from '@/lib/sui/predict'
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
// Shared persisted stake index (home idle wheel writes the same key, see ConsoleCanvas).
const STAKE_KEY = 'pips_stake_idx'
// Reel cycle pools (cosmetic blur before the snap). The real targets come from the dealt play.
// Preferred order for the stacked asset panel (the rest of the live markets follow, capped at 3).
const PREFERRED = ['BTC', 'SUI', 'ETH', 'SOL']
const DIR_POOL = ['UP', 'DOWN']
const MULT_POOL = ['2x', '3x', '5x', '10x', '25x']
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
type Live = { markValue: string; pnl: string; multiplier: number; status: PlayStatus }
type Overlay = 'none' | 'howto' | 'history'

const money = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtMult = (n: number): string => `${Number.isInteger(n) ? n : Number(n.toFixed(1))}x`
const sideLabel = (s: Side): string => (s === 'up' ? 'UP' : 'DOWN')
const priceLabel = (p: number): string =>
  `$${p.toLocaleString('en-US', { maximumFractionDigits: p >= 1000 ? 0 : p >= 1 ? 2 : 4 })}`

export function LuckyScreen() {
  const { refresh, user } = useAuth()
  const qc = useQueryClient()

  // One persistent stake shared with the home wheel (same ladder), so it stays put across navigation.
  const [betIdx, setBetIdx] = useLocalStorage(STAKE_KEY, 2)
  const [phase, setPhase] = useState<Phase>('idle')
  const [play, setPlay] = useState<PlayDTO | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [spot, setSpot] = useState<number | null>(null)
  const [entryPrice, setEntryPrice] = useState<number | null>(null)
  const [secsLeft, setSecsLeft] = useState<number | null>(null)
  const [settleMs, setSettleMs] = useState(0)
  const [cashMs, setCashMs] = useState(0) // drives the cash-out settling bar
  const [closeLocked, setCloseLocked] = useState(false) // cash-out disarmed in the final beat before expiry
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
  // The play id the entry line was marked for, so an immediate replay re-marks for the new round
  // instead of holding the previous round's price (which left ENTRY and TARGET out of sync).
  const entryPlayId = useRef<string | null>(null)
  // Entry line marks the dealt asset's first live price. Track the latest spot and the asset it
  // belongs to (set together in onPrice) so a round on a new asset never marks entry at the old one.
  const spotRef = useRef<number | null>(null)
  const spotAssetRef = useRef<string | null>(null)
  // Latest live price per asset, written by every chart row without a re-render. The header big
  // price tracks the focused asset; the play-time debug log reads the dealt asset off here.
  const pricesRef = useRef<Record<string, number>>({})
  const focusAssetRef = useRef<string>('')
  // The chart's eased leading price, written every frame by the Chart. The live P/L reads it to
  // track the line at 60fps instead of the laggy ~2.5s backend mark.
  const livePriceRef = useRef(0)
  // The value LivePnl is currently showing, mirrored here each frame so the cash-out settling beat
  // can freeze on the exact number the player saw the instant they tapped CASH OUT.
  const liveValueRef = useRef({ value: 0, pnl: 0 })

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
  // The asset panel: up to three live markets stacked as live charts (BTC/SUI/ETH first). The dealt
  // asset is always included so a spin always has a chart to expand into. focusAsset is the one the
  // header price + the entry pipeline track (the dealt asset mid-round, the primary at rest).
  const displayAssets = useMemo(() => {
    const order = (a: string) => {
      const i = PREFERRED.indexOf(a)
      return i < 0 ? 99 : i
    }
    let top = [...liveAssets].sort((a, b) => order(a) - order(b)).slice(0, 3)
    if (lp?.asset && !top.includes(lp.asset)) top = [lp.asset, ...top].slice(0, 3)
    return top
  }, [liveAssets.join(','), lp?.asset])
  const focusAsset = lp?.asset ?? displayAssets[0]
  focusAssetRef.current = focusAsset
  // The entry line shows while a round is live. Not in 'result': once the round ends the screen behind
  // the result overlay resets to the default stack, so no entry/target lingers on it.
  const showEntry = play != null && (phase === 'spinning' || phase === 'open' || phase === 'cashing')
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
  const playBet = play ? parseFloat(play.stake) : bet
  // Entry reference: the spot the strike was solved against, so the ENTRY line, the TARGET line, and
  // the settlement all agree. Falls back to the chart's first captured price if entrySpot is absent.
  const entrySpotNum = play?.entrySpot ? parseFloat(play.entrySpot) : NaN
  const entryVal = Number.isFinite(entrySpotNum) && entrySpotNum > 0 ? entrySpotNum : entryPrice
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
  // A mid-round cash-out is in flight: play the same settling beat as the buzzer.
  const cashingOut = phase === 'cashing'
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
      stopLuckyBgm() // cut the bed the instant it resolves, so the sting lands clean
      haptic(final.status === 'lost' ? 'error' : 'success')
      if (final.status === 'won') luckyWin()
      else if (final.status === 'cashed_out') luckyCashout()
      else luckyLose()
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

  // Mark the entry line at the dealt asset's first live price. Waits until the chart has switched
  // to the round's asset (spotAssetRef matches) so it never anchors at the previous asset's price.
  useEffect(() => {
    if (!play) {
      entryPlayId.current = null
      return
    }
    if (entryPlayId.current === play.id) return // already marked for this round
    if (spotAssetRef.current === play.market.asset && spotRef.current != null) {
      entryPlayId.current = play.id
      setEntryPrice(spotRef.current)
    }
  }, [spot, play])

  // Every stacked chart reports its ticks here. We stash them per asset (no re-render) and, for the
  // focused asset, drive the header price + the entry pipeline (same single ~1/s parent re-render as
  // the old single chart). Per-row label prices stay local to each row, so a tick never re-renders this.
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
      // Price debug: line up what the chart is showing for the dealt asset against the prices the
      // backend actually solved the round on. entrySpot/target come from the oracle's pushed spot
      // (a beat behind the live feed), so a small gap to chartLive at this instant is expected.
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
    if (phase !== 'open' || !play || closeLocked) return
    setPhase('cashing')
    haptic('rigid')
    const started = Date.now()
    try {
      const { play: p, unlocked } = await cashOut(play.id)
      // Hold the settling beat open so it always reads, even when the redeem lands in ~120ms (demo).
      const wait = CASHOUT_SETTLE_MS - (Date.now() - started)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
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
  }, [phase, play, finishResult, closeLocked])

  // Leave the result screen on any console button. Drops straight back to the default idle screen (the
  // 3-up stack + masked header), it does NOT re-spin. The auto-advance timer is the same destination,
  // so a button just gets there sooner. Touches only refs + setters, so a stable identity is fine.
  const dismissResult = useCallback(() => {
    clearResetTimer()
    haptic('selection')
    setPhase('idle')
  }, [])

  // Round countdown for the TIME readout. At the buzzer the settle worker (or the demo stream)
  // produces the terminal frame; the stream effect above catches it. No auto-cash here.
  useEffect(() => {
    if (phase !== 'open' || !play) {
      setSecsLeft(null)
      setSettleMs(0)
      setCloseLocked(false)
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
      // Disarm cash-out a tx round-trip before the buzzer so a redeem can't land in the settling gap.
      setCloseLocked(remaining <= CASHOUT_LOCKOUT_MS)
    }
    tick()
    const iv = setInterval(tick, 250)
    return () => clearInterval(iv)
  }, [phase, play])

  // Cash-out settling beat: a deterministic progress bar for the brief window the redeem is in flight,
  // so a mid-round CASH OUT plays the same settling animation as the buzzer.
  useEffect(() => {
    if (phase !== 'cashing') {
      setCashMs(0)
      return
    }
    const start = Date.now()
    const iv = setInterval(() => setCashMs(Date.now() - start), 100)
    return () => clearInterval(iv)
  }, [phase])

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
      format: (v) => `${BET_LADDER[Math.min(v, maxBetIdx)]}`,
    },
    action1: isResult
      ? { label: '', color: resultColor, onPress: dismissResult, pulse: true }
      : { label: 'HOW TO', color: 'neutral', onPress: toggleHowto },
    action2: isResult
      ? { label: '', color: resultColor, onPress: dismissResult, pulse: true }
      : { label: 'HISTORY', color: 'neutral', onPress: toggleHistory },
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
                {/* Masked until a chart is selected (a round opens), matching the anonymous stack. */}
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-text-3">{showReadouts ? focusAsset : 'XXX'}</div>
                <div className="tnum text-[34px] font-extrabold leading-none text-text">{showReadouts ? (spot != null ? priceLabel(spot) : '—') : '$XXXX'}</div>
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
                <span className="tnum font-black leading-none text-text opacity-20 text-[clamp(64px,18vh,128px)]">{secsLeft}</span>
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
              ) : cashingOut ? (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Cashing out</div>
                  <div className="tnum text-[40px] font-extrabold leading-none text-text">${money(liveValueRef.current.value)}</div>
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
                  <LivePnl
                    key={play?.id}
                    livePriceRef={livePriceRef}
                    valueRef={liveValueRef}
                    side={lp?.side ?? 'up'}
                    target={strike ?? 0}
                    entry={entryVal ?? 0}
                    bet={playBet}
                    mult={play?.multiplier ?? multiplier}
                    status={live?.status ?? 'open'}
                    finalPnl={live ? parseFloat(live.pnl) : 0}
                  />
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

      {phase === 'result' && play && <LuckyResult play={play} streak={streak} />}
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
  last = false,
}: {
  index: number
  label: string
  pool: string[]
  target?: string
  cycling: boolean
  landing: boolean
  stopAt: number
  accent?: 'amber' | 'up' | 'down'
  last?: boolean
}) {
  const [shown, setShown] = useState<string>('?')
  const poolRef = useRef(pool)
  poolRef.current = pool

  useEffect(() => {
    if (!cycling) {
      setShown(target ?? '?')
      return
    }
    let stopped = false
    // Step straight through the pool (offset per reel so the three aren't in lockstep). Sequential,
    // not random, so every tick changes the value, never freezing on the same item twice in a row.
    let i = index % poolRef.current.length
    const iv = setInterval(() => {
      if (!stopped) {
        const p = poolRef.current
        i = (i + 1) % p.length
        setShown(p[i])
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
          slotLock(index, last)
        }, stopAt)
        : undefined
    return () => {
      clearInterval(iv)
      if (to) clearTimeout(to)
    }
  }, [cycling, landing, target, stopAt, index, last])

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
  const locked = !cycling && shown !== '?'
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

// The asset panel: up to three live markets stacked as charts. At rest they share the height, each
// tabbed with its symbol + live price. A spin hides the tabs and flicks a lit highlight across them
// (the slot picking an asset). When the reels land, the dealt chart holds a beat lit + flashed (the
// "lock-in"), THEN expands to fill while the others collapse, so the pick reads as a moment instead of
// an instant cut. The entry/target overlays and the 60fps live price only attach to the dealt chart.
// Each row keeps its own SSE the whole time, so an expand/collapse is a pure height ease (no
// re-subscribe), and returning to idle is instant.
function LuckyCharts({
  assets,
  focusAsset,
  selectedAsset,
  expanded,
  selecting,
  highlightAsset,
  overlays,
  livePriceRef,
  onPrice,
}: {
  assets: Array<string>
  focusAsset: string
  selectedAsset: string | null
  expanded: boolean
  selecting: boolean
  highlightAsset: string | null
  overlays: ChartOverlays | undefined
  livePriceRef: { current: number }
  onPrice: (asset: string, price: number) => void
}) {
  // The beat between "reels landed on this asset" and "chart expands": the winner sits lit + flashed
  // at equal height while the losers dim, then it grows.
  const locking = selectedAsset != null && !expanded
  return (
    <div className="absolute inset-0 flex flex-col">
      {assets.map((a, i) => {
        const isSel = a === selectedAsset
        // Collapsing rows ease flex-grow 1 -> 0; the selected one holds at 1 and absorbs the room.
        const grow = !expanded ? 1 : isSel ? 1 : 0
        const lit = !expanded && selecting && a === highlightAsset // scan highlight while the reels cycle
        const winner = locking && isSel // the locked pick, emphasized before it expands
        return (
          <div
            key={a}
            style={{ flexGrow: grow }}
            className={cnm(
              'relative min-h-0 basis-0 overflow-hidden transition-[flex-grow] duration-[600ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
              i > 0 && !expanded && 'border-t border-line-strong',
            )}
          >
            <ChartRow
              asset={a}
              // Tabs stay through the idle stack and the scan, so each market keeps its name + price
              // while the slot picks. They drop only once a chart is locked (selectedAsset set), since
              // from there the header carries the symbol + price and the on-chart tab would duplicate it.
              showLabel={selectedAsset == null}
              reveal={isSel}
              lit={lit}
              winner={winner}
              dimmed={(selecting && !lit) || (locking && !isSel)}
              overlays={isSel ? overlays : undefined}
              livePriceRef={a === focusAsset ? livePriceRef : undefined}
              onPrice={onPrice}
            />
          </div>
        )
      })}
    </div>
  )
}

// One row of the asset panel: a live chart with a symbol + price tab top-left. Holds its own label
// price so a tick repaints just the tab, never the parent. Reports every tick up so the panel can
// track the dealt asset and the debug log can read it.
function ChartRow({
  asset,
  showLabel,
  reveal,
  lit,
  winner,
  dimmed,
  overlays,
  livePriceRef,
  onPrice,
}: {
  asset: string
  showLabel: boolean
  reveal: boolean
  lit: boolean
  winner: boolean
  dimmed: boolean
  overlays?: ChartOverlays
  livePriceRef?: { current: number }
  onPrice: (asset: string, price: number) => void
}) {
  const [price, setPrice] = useState<number | null>(null)
  return (
    <div className="relative h-full w-full">
      <Chart
        asset={asset}
        overlays={overlays}
        livePriceRef={livePriceRef}
        showPriceTag={reveal}
        onPrice={(p) => {
          setPrice(p)
          onPrice(asset, p)
        }}
        className="absolute inset-0"
      />
      {/* spin spotlight: every chart dims, the lit one lifts with an amber frame. Both eased so the
          highlight glides down the stack as it scans, never snaps. */}
      <div className={cnm('pointer-events-none absolute inset-0 bg-black transition-opacity duration-150', dimmed ? 'opacity-[0.55]' : 'opacity-0')} />
      <div className={cnm('pointer-events-none absolute inset-0 border border-brand-500 bg-brand-500/[0.06] transition-opacity duration-150', lit ? 'opacity-100' : 'opacity-0')} />
      {/* lock-in: the dealt chart snaps to a bright amber frame and flashes once, the "this one" beat
          before it expands. Fades out on its own as the expand takes over. */}
      <div className={cnm('pointer-events-none absolute inset-0 border-2 border-brand-500 bg-brand-500/[0.14] transition-opacity duration-200', winner ? 'opacity-100 lucky-lock' : 'opacity-0')} />
      {showLabel && (
        // The stack labels show the real market + price (only the header big number stays masked).
        <div className="pointer-events-none absolute left-[var(--screen-rim,24px)] top-2.5 flex items-baseline gap-2">
          <span className="font-mono text-[13px] font-bold uppercase tracking-[0.16em] text-text-2">{asset}</span>
          <span className="tnum text-[15px] font-bold leading-none text-text">{price != null ? priceLabel(price) : '—'}</span>
        </div>
      )}
    </div>
  )
}

// The win/loss/cash-out moment. Flat full-screen wash (docs/SCREEN.md: big, flat, momentary, no blur):
// the §10 copy, the signed amount, the streak on a win. A pure readout, no tap target and no tx detail,
// it is dismissed from any console button (CONTINUE), which drops straight back to the default screen.
function LuckyResult({ play, streak }: { play: PlayDTO; streak: number }) {
  const reduced = useReducedMotion()
  const pnl = parseFloat(play.pnl ?? '0')
  const won = play.status === 'won'
  const cashed = play.status === 'cashed_out'
  const positive = won || (cashed && pnl >= 0)
  const head = won ? 'YOU WON' : cashed ? 'CASHED OUT' : 'MISSED'
  const pop = reduced
    ? {}
    : { initial: { scale: 0.7, opacity: 0 }, animate: { scale: 1, opacity: 1 }, transition: { type: 'spring' as const, stiffness: 440, damping: 24 } }
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/90 text-center">
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
      <span className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-text-3">Any button to continue</span>
    </div>
  )
}

// The live readout while a round is open. The hero is CASH OUT NOW (the total dollars you walk with if
// you exit now); beside it the signed P/L, and WIN as the full payout if you hold and land. It rides the
// chart's eased price (livePriceRef) at 60fps: the P/L scales with how far the dot has moved from ENTRY
// toward the TARGET, 0 at entry, partial profit on the way, the full win once it reaches the target
// (capped past it), and down to -bet against you. Written imperatively so the screen never re-renders on
// a tick. When ahead the hint nudges CASH OUT. On a terminal status it shows the settled result.
function LivePnl({
  livePriceRef,
  valueRef,
  side,
  target,
  entry,
  bet,
  mult,
  status,
  finalPnl,
}: {
  livePriceRef: { current: number }
  valueRef: { current: { value: number; pnl: number } }
  side: Side
  target: number
  entry: number
  bet: number
  mult: number
  status: PlayStatus
  finalPnl: number
}) {
  const terminal = RESULT_TERMINAL.has(status)
  const valid = entry > 0 && target > 0 && bet > 0 && Math.abs(target - entry) > 1e-9
  // WIN = the total you walk with if it lands (bet x mult); profit = that minus the stake.
  const winTotal = Math.max(0, bet * mult)
  const profit = Math.max(0, bet * (mult - 1))
  const [pos, setPos] = useState(true) // ahead/behind, drives the P/L color + the lock hint
  const posRef = useRef(true)
  const pnlSpan = useRef<HTMLSpanElement>(null)
  const cashSpan = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (terminal || !valid) return
    const dir = side === 'up' ? 1 : -1
    const targetDist = dir * (target - entry) // favorable distance from entry to the win line (> 0)
    let raf = 0
    const loop = () => {
      const price = livePriceRef.current
      if (price > 0 && targetDist > 0) {
        // How far the dot has travelled from entry toward the target, in your direction. 0 at entry,
        // 1 at the target. The favorable side ramps the partial cash-out value 0 -> full win.
        const progress = (dir * (price - entry)) / targetDist
        // Past entry the wrong way (up below entry, down above it) a binary settling here loses the
        // whole stake, so show the honest -bet, not a soft partial. A hair of neutral zone around
        // entry stops a -bet flash at open / on feed jitter (entrySpot lags the live feed a touch).
        const behind = -progress * targetDist > entry * 0.0003
        const pnl = behind ? -bet : Math.max(0, Math.min(profit, progress * profit))
        const value = bet + pnl // total dollars back if you cash out now
        const nowPos = pnl >= -1e-9
        if (nowPos !== posRef.current) {
          posRef.current = nowPos
          setPos(nowPos)
        }
        if (pnlSpan.current) pnlSpan.current.textContent = `${nowPos ? '+' : '-'}$${money(Math.abs(pnl))}`
        if (cashSpan.current) cashSpan.current.textContent = money(value)
        valueRef.current.value = value
        valueRef.current.pnl = pnl
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [terminal, valid, side, target, entry, bet, profit, livePriceRef, valueRef])

  if (terminal) {
    const won = status === 'won' || (status === 'cashed_out' && finalPnl >= 0)
    const label = status === 'won' ? 'Won' : status === 'cashed_out' ? 'Cashed out' : 'Missed'
    // A win/cash-out shows the total cash returned (bet + P/L), the same framing as the live CASH OUT
    // NOW hero, so the headline never drops the stake on settle. A loss shows the stake lost. The signed
    // P/L sits underneath for the net move.
    const total = bet + finalPnl
    return (
      <>
        <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">{label}</div>
        <div className={cnm('text-[40px] font-extrabold leading-none', won ? 'text-up' : 'text-down')}>
          {won ? <>$<Stat value={total} /></> : <>-$<Stat value={Math.abs(finalPnl)} /></>}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] font-bold uppercase tracking-[0.06em]">
          <span className={cnm('tnum', won ? 'text-up' : 'text-down')}>
            {finalPnl >= 0 ? '+' : '-'}${money(Math.abs(finalPnl))}
          </span>
          <span className="text-text-3">·</span>
          <span className="text-text-2">
            {side === 'up' ? 'UP' : 'DOWN'} · {fmtMult(mult)}
          </span>
        </div>
      </>
    )
  }

  return (
    <>
      <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Cash out now</div>
      <div className="flex items-baseline justify-between gap-3">
        <div className="tnum text-[40px] font-extrabold leading-none text-text">
          $<span ref={cashSpan}>{money(valid ? bet : 0)}</span>
        </div>
        <div className="shrink-0 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-text-3">
          Bet <span className="tnum text-text-2">${money(bet)}</span>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] font-bold uppercase tracking-[0.06em]">
        <span className={cnm('tnum', pos ? 'text-up' : 'text-down')}>
          <span ref={pnlSpan}>{valid ? '+$0.00' : '—'}</span>
        </span>
        <span className="text-text-3">·</span>
        <span className="text-text-2">
          Win <span className="tnum text-up">${money(winTotal)}</span>
        </span>
      </div>
      {valid && (
        <div className="mt-1 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-text-3">
          {pos ? 'Cash out to lock it in' : 'Total back if you exit now'}
        </div>
      )}
    </>
  )
}

// HOW TO: a flat in-screen card of the rules. Plain terminology only, no banned words.
function HowTo({ onClose }: { onClose: () => void }) {
  const lines: Array<[string, string]> = [
    ['SPIN', 'Deals an asset, a direction (up or down), and a multiplier.'],
    ['TARGET', 'The price to reach, in your direction. A 2x sits just past your entry, so a small move your way wins. Bigger multipliers sit further out.'],
    ['WIN', 'Land past the target at the buzzer to win bet x multiplier. A touch on the way does not count, only where it ends.'],
    ['CASH OUT', 'Take the live value any time before the buzzer. Ahead? Cash out to lock it in before it can turn.'],
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
