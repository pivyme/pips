import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import type { ChartOverlays } from '@/components/game/Chart'
import { Chart } from '@/components/game/Chart'
import { Cell, GameScreen, ScreenMessage, ScreenOverlay } from '@/components/game/screen'
import { GameLeaderboardOverlay } from '@/components/game/GameLeaderboardOverlay'
import { useConsoleControls } from '@/components/console/controls'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { useLiveMarkets } from '@/hooks/useLiveMarkets'
import { haptic } from '@/lib/haptics'
import {
  moonshotCashout,
  moonshotFire,
  moonshotFlip,
  moonshotLose,
  moonshotWin,
  startMoonshotBgm,
  stopMoonshotBgm,
} from '@/lib/sound'
import { api, streamPlay, type LuckyParams, type PlayDTO, type PlayStatus, type Side } from '@/lib/api'
import { cashOut, placePlay } from '@/lib/sui/predict'
import { toastError } from '@/lib/errors'
import { useAuth } from '@/lib/auth'
import { cnm } from '@/utils/style'
import { formatExactDecimal, formatStringToNumericDecimals } from '@/utils/format'

// MOONSHOT. Call the direction (LONG / SHORT) with the right button, dial the REACH (how far out the
// target sits = the multiple) with the knob, set the bet, then PLAY: a real Predict binary mint at the
// solved strike, ride the live value on the chart with a TARGET line, and CASH OUT early or hold to the
// buzzer for a spread-free WIN/MISS. It is the directional twin of Lucky (same binary mint/redeem path)
// but YOU pick the side and reach instead of the reel dealing them. Every round is a real position; demo
// mode runs the same flow on the in-memory model. The left button is the info rotary (HOW TO / RANKS),
// exactly like Range. Teenage Engineering language throughout (docs/SCREEN.md): flat black, mono labels,
// one amber accent, green/red for facts.
export const Route = createFileRoute('/_app/games/moonshot')({ component: MoonshotScreen })

// Stake ladder, scrubbed on the number wheel, shared with Lucky + Range + the home wheel (same key).
const STAKE_LADDER = [1, 5, 10, 25, 50, 100] as const
const STAKE_KEY = 'pips_stake_idx'
// REACH ladder: the target multiple the knob dials. Bigger reach = a target further out = longer odds,
// a bigger multiple. The solver clamps to the live ask, so a 25x lands on the real mintable ceiling.
const REACH_LADDER = [2, 3, 5, 10, 25] as const
const SIDE_KEY = 'pips_moonshot_side'
const REACH_KEY = 'pips_moonshot_reach'
// Preferred asset order: Moonshot pins one stable top-liquidity market (no per-shot asset switch, the
// right button is the direction toggle), only re-picking if the current one drops offline.
const PREFERRED = ['BTC', 'ETH', 'SUI', 'SOL', 'DEEP']

// Preview TARGET placement (pre-play only): the same vol + reach->quantile mapping the backend solver
// uses, so the aim line sits where the real strike will land. On open it snaps to the true solved strike.
const ROUND_VOL_EST = 0.022
const MIN_TARGET_FRAC = 0.0015
const REACH_Z: Record<number, number> = { 2: 0, 3: 0.4307, 5: 0.8416, 10: 1.2816, 25: 1.7507 }

const NOMINAL_ROUND_SEC = 30
const RESULT_MS = 6500
// Cash-out safety window: a redeem submitted this late may land after the oracle expires, so we disarm
// cash-out and let the round auto-settle. Not a verdict, just a closed window (mirrors Range).
const SETTLE_LOCK_MS = 5000
const CASHOUT_SETTLE_MS = 1100
const SETTLE_EXPECT_MS = 12000
const WATCHDOG_MS = 3000
const TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out', 'error'])
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

const money = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtMult = (n: number): string => `${n.toFixed(2).replace(/\.?0+$/, '')}x`
const sideLabel = (s: Side): string => (s === 'up' ? 'LONG' : 'SHORT')
const priceLabel = (p: number): string =>
  `$${p.toLocaleString('en-US', { maximumFractionDigits: p >= 1000 ? 0 : p >= 1 ? 2 : 4 })}`

export function MoonshotScreen() {
  const { refresh, user } = useAuth()
  const qc = useQueryClient()

  const [stakeIdx, setStakeIdx] = useLocalStorage(STAKE_KEY, 2)
  const [reachIdx, setReachIdx] = useLocalStorage(REACH_KEY, 2) // default 5x
  const [side, setSide] = useLocalStorage<Side>(SIDE_KEY, 'up')
  const [pinnedAsset, setPinnedAsset] = useState<string | null>(null)

  const [phase, setPhase] = useState<Phase>('idle')
  const [play, setPlay] = useState<PlayDTO | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [spot, setSpot] = useState<number | null>(null)
  const [secsLeft, setSecsLeft] = useState<number | null>(null)
  const [remainingMs, setRemainingMs] = useState<number | null>(null)
  const [settleMs, setSettleMs] = useState(0)
  const [cashMs, setCashMs] = useState(0)
  const [overlay, setOverlay] = useState<Overlay>('none')

  const finalized = useRef(false)
  const watchdogRun = useRef(0)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const balanceSyncedPlayId = useRef<string | null>(null)
  const livePriceRef = useRef(0)

  const { liveAssets, noLiveMarket, isLoading: marketsLoading, isError: marketsError } = useLiveMarkets()
  const statsQ = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() })
  const streak = statsQ.data?.stats.currentStreak ?? 0

  // Pin a stable top-liquidity market; only re-pick if the current one goes offline.
  useEffect(() => {
    if (liveAssets.length === 0) return
    if (pinnedAsset && liveAssets.includes(pinnedAsset)) return
    setPinnedAsset(PREFERRED.find((a) => liveAssets.includes(a)) ?? liveAssets[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveAssets.join(','), pinnedAsset])

  const canPlay = liveAssets.length > 0
  // Hold the play's asset while a round runs (a finished play lingers under the result), else the pin.
  const asset =
    play && phase !== 'idle' ? (play.params as LuckyParams).asset : (pinnedAsset ?? liveAssets[0] ?? PREFERRED[0])

  const reach = REACH_LADDER[Math.min(reachIdx, REACH_LADDER.length - 1)]

  // BET clamps to what the balance affords, so the wheel never offers an unplayable bet.
  const balance = parseFloat(user?.balance ?? '0') || 0
  const maxBetIdx = Math.max(0, STAKE_LADDER.reduce((acc, v, i) => (v <= balance ? i : acc), 0))
  const safeBetIdx = Math.min(stakeIdx, maxBetIdx)
  const stake = STAKE_LADDER[safeBetIdx]

  const lp = play ? (play.params as LuckyParams) : null
  const roundLive = phase === 'open' || phase === 'cashing'
  const showReadouts = play != null && roundLive
  const multiplier = live?.multiplier ?? play?.multiplier ?? reach

  const strike = play?.market.strike ? parseFloat(play.market.strike) : undefined
  const entrySpotNum = play?.entrySpot ? parseFloat(play.entrySpot) : NaN
  const entryVal = Number.isFinite(entrySpotNum) && entrySpotNum > 0 ? entrySpotNum : null

  // Pre-play preview TARGET: the aim line that tracks the live price as you turn REACH / flip the side.
  const previewTarget =
    spot != null && spot > 0
      ? spot * (1 + (side === 'up' ? 1 : -1) * Math.max(ROUND_VOL_EST * (REACH_Z[reach] ?? 0), MIN_TARGET_FRAC))
      : null

  // Chart overlays: the real strike + entry while a round runs; the live preview aim while idle/placing.
  const overlays: ChartOverlays | undefined = showReadouts && lp
    ? {
        ...(entryVal != null ? { entry: entryVal } : {}),
        ...(strike != null ? { target: { price: strike, side: lp.side } } : {}),
      }
    : (phase === 'idle' || phase === 'placing') && previewTarget != null
      ? { target: { price: previewTarget, side } }
      : undefined

  // Phase machine off the live status + the countdown (mirrors Range).
  const confirmed = live?.status === 'open'
  const opening = phase === 'open' && (live?.status === 'pending' || remainingMs == null)
  const settling = phase === 'open' && remainingMs != null && remainingMs <= 0
  const sealing =
    phase === 'open' && confirmed && remainingMs != null && remainingMs > 0 && remainingMs <= SETTLE_LOCK_MS
  const liveHold = phase === 'open' && confirmed && remainingMs != null && remainingMs > SETTLE_LOCK_MS
  const cashing = phase === 'cashing'
  const settleSecs = Math.floor(settleMs / 1000)

  const clearResetTimer = () => {
    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = null
  }

  const finishResult = useCallback(
    (final: PlayDTO) => {
      finalized.current = true
      watchdogRun.current += 1
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
      stopMoonshotBgm() // cut the bed so the resolve sting lands over silence
      haptic(final.status === 'lost' ? 'error' : 'success')
      if (final.status === 'won') moonshotWin()
      else if (final.status === 'cashed_out') moonshotCashout()
      else moonshotLose()
      void refresh()
      for (const key of ['stats', 'achievements', 'plays']) void qc.invalidateQueries({ queryKey: [key] })
      clearResetTimer()
      resetTimer.current = setTimeout(() => setPhase('idle'), RESULT_MS)
    },
    [refresh, qc],
  )

  const resolveTerminal = useCallback(
    (status: PlayStatus, playId: string) => {
      if (finalized.current) return
      if (status === 'error') {
        finalized.current = true
        watchdogRun.current += 1
        toast.error('Could not open that play. Your chips are safe, fire again.', { id: 'moonshot-play-error' })
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

  // Live value while a play is open. Comes back 'pending' the instant it's placed; the real mint lands
  // a beat later and the stream flips it to 'open', then to a terminal frame at the buzzer settle.
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
        resolveTerminal(tick.status, id)
      },
      () => {
        // SSE dropped: keep the last readout. EventSource retries, and the watchdog below still resolves.
      },
    )
  }, [play, phase, resolveTerminal])

  // Watchdog: poll the play on a steady cadence, independent of the SSE socket, so the terminal frame
  // always lands even if the stream silently dies. Mirrors Lucky / Range.
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
      if (run === watchdogRun.current) timer = setTimeout(() => void poll(), WATCHDOG_MS)
    }
    timer = setTimeout(() => void poll(), WATCHDOG_MS)
    return () => {
      if (watchdogRun.current === run) watchdogRun.current += 1
      clearTimeout(timer)
    }
  }, [play, phase, resolveTerminal])

  useEffect(() => () => clearResetTimer(), [])

  // The bed rides the active window (placing -> open) and cuts the moment it resolves so the sting
  // lands clean. Tense + punchy, the ignition counterpart to Lucky's funk and Range's dark techno.
  const bedPlaying = phase === 'placing' || phase === 'open'
  useEffect(() => {
    if (!bedPlaying) return
    startMoonshotBgm()
    return () => stopMoonshotBgm()
  }, [bedPlaying])

  const doPlay = useCallback(async () => {
    if (phase !== 'idle') return
    if (!canPlay) {
      toast.error('No live market right now. Try again in a sec.', { id: 'no-market' })
      return
    }
    clearResetTimer()
    finalized.current = false
    setOverlay('none')
    setPhase('placing')
    haptic('heavy')
    moonshotFire()
    try {
      const { play: p } = await placePlay('moonshot', { stake, asset, side, reach })
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
      haptic('selection')
    } catch (e) {
      toastError(e)
      setPhase('idle')
    }
  }, [phase, canPlay, stake, asset, side, reach])

  const doCashOut = useCallback(async () => {
    if (!liveHold || !play) return
    setPhase('cashing')
    haptic('rigid')
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
    haptic('selection')
    setPhase('idle')
  }, [])

  // Flip the called direction. Locked while a round is live (you can't change an open position's side).
  const toggleSide = useCallback(() => {
    if (phase !== 'idle' && phase !== 'placing') return
    haptic('rigid')
    moonshotFlip()
    setSide((s) => (s === 'up' ? 'down' : 'up'))
  }, [phase, setSide])

  // The left cap is the same info rotary as Range: game -> how to -> leaderboard -> game. The label
  // names where the NEXT press lands.
  const rotateInfo = useCallback(() => {
    haptic('selection')
    setOverlay((o) => (o === 'none' ? 'howto' : o === 'howto' ? 'board' : 'none'))
  }, [])
  const infoLabel = overlay === 'none' ? 'HOW TO' : overlay === 'howto' ? 'RANKS' : 'GAME'

  // Countdown to the real on-chain buzzer (play.market.expiry), driving the lock-in window + the
  // SETTLING progress off remainingMs. Mirrors Range.
  useEffect(() => {
    if (phase !== 'open' || !play) {
      setSecsLeft(null)
      setRemainingMs(null)
      setSettleMs(0)
      return
    }
    const endAt =
      play.market.expiry ||
      (play.openedAt ? Date.parse(play.openedAt) : Date.now()) + (play.params.duration || NOMINAL_ROUND_SEC) * 1000
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

  // Cash-out settling beat: a deterministic progress bar for the brief window the redeem is in flight.
  useEffect(() => {
    if (phase !== 'cashing') {
      setCashMs(0)
      return
    }
    const start = Date.now()
    const iv = setInterval(() => setCashMs(Date.now() - start), 100)
    return () => clearInterval(iv)
  }, [phase])

  const isResult = phase === 'result'
  const resultPositive =
    isResult && play != null && (play.status === 'won' || (play.status === 'cashed_out' && parseFloat(play.pnl ?? '0') >= 0))
  const resultColor: 'up' | 'down' = resultPositive ? 'up' : 'down'

  useConsoleControls({
    knob: {
      label: 'REACH',
      min: 0,
      max: REACH_LADDER.length - 1,
      step: 1,
      value: reachIdx,
      onChange: setReachIdx,
      format: (v) => `x${REACH_LADDER[Math.min(v, REACH_LADDER.length - 1)]}`,
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
    // The right cap is the direction toggle: shows the called side in its color, flips on press. Inert
    // (shows the locked side) once a round is live, since an open position's side can't change.
    action2: isResult
      ? { label: '', color: resultColor, onPress: dismissResult, pulse: true }
      : roundLive
        ? { label: sideLabel((lp?.side ?? side)), color: (lp?.side ?? side) === 'up' ? 'up' : 'down', onPress: () => {} }
        : { label: sideLabel(side), color: side === 'up' ? 'up' : 'down', onPress: toggleSide },
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
                  ? { label: 'FIRING', color: 'amber', onPress: () => {}, loading: true }
                  : { label: 'PLAY', color: 'amber', onPress: () => void doPlay() },
  })

  const firstRun = !statsQ.isLoading && (statsQ.data?.stats.gamesPlayed ?? 0) === 0
  const playCost = live?.entryValue ?? play?.entryValue ?? String(stake)
  const recap = `${asset} · ${sideLabel(lp?.side ?? side)} · ${fmtMult(multiplier)} · Cost $${formatExactDecimal(playCost)}`

  // Layout mirrors Lucky / Range (the house language): a solid header band (price · balance) divides off
  // the chart, the chart bleeds full width but stays bounded, and the readout hangs off the bottom-left.
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
          {/* HEADER — market + live price (left), balance / expiry countdown (right). */}
          <div className="shrink-0 border-b border-line-strong bg-black pt-[calc(var(--screen-rim,24px)+12px)]">
            <div className="flex items-start justify-between gap-3 px-[var(--screen-rim,24px)] pb-4">
              <div className="min-w-0">
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-text-3">Moonshot · {asset}</div>
                <div className="tnum text-[34px] font-extrabold leading-none text-text">{spot != null ? priceLabel(spot) : '—'}</div>
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

          {/* CHART — bounded between header and footer, with the TARGET (and ENTRY) overlay. */}
          <div className="relative min-h-0 flex-1">
            {showReadouts && secsLeft != null && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
                <span className="tnum font-black leading-none text-text opacity-15 text-[clamp(64px,18vh,128px)]">{secsLeft}</span>
              </div>
            )}
            {asset ? (
              <Chart asset={asset} overlays={overlays} livePriceRef={livePriceRef} onPrice={(p) => setSpot(p)} className="absolute inset-0" />
            ) : null}
          </div>

          {/* FOOTER — full-width readout band, left-only (clear of the knob + PLAY body). */}
          <div className="shrink-0 border-t border-line-strong bg-black px-[var(--screen-rim,24px)] pb-[var(--screen-rim,24px)] pt-3.5 min-h-[var(--screen-notch,21%)]">
            <div className="max-w-[60%]">
              {phase === 'placing' ? (
                <FooterStatus kicker="Launching" head="FIRING" recap={recap} sweep />
              ) : opening ? (
                <FooterStatus kicker="Opening" head="OPENING" recap={recap} sweep />
              ) : settling ? (
                <FooterStatus kicker={`Settling · ${settleSecs}s`} head="SETTLING" recap={recap} progress={Math.min(94, (settleMs / SETTLE_EXPECT_MS) * 100)} />
              ) : sealing ? (
                <FooterStatus
                  kicker={`Cash out closed · settles in ${secsLeft ?? 0}s`}
                  head="FINAL SECONDS"
                  recap={recap}
                  progress={Math.min(96, ((SETTLE_LOCK_MS - (remainingMs ?? 0)) / SETTLE_LOCK_MS) * 100)}
                />
              ) : cashing ? (
                <FooterStatus kicker="Cashing out" head="CASHING OUT" tone="up" recap={recap} progress={Math.min(92, (cashMs / CASHOUT_SETTLE_MS) * 100)} />
              ) : showReadouts ? (
                <LivePnl
                  key={play?.id}
                  markValue={live?.markValue ?? play?.markValue ?? '0'}
                  pnl={live?.pnl ?? play?.pnl ?? '0'}
                  entryValue={live?.entryValue ?? play?.entryValue ?? '0'}
                  maxPayout={live?.maxPayout ?? play?.maxPayout ?? '0'}
                />
              ) : firstRun ? (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Welcome</div>
                  <div className="text-[22px] font-extrabold uppercase leading-none tracking-[0.02em] text-text">Moonshot</div>
                  <div className="mt-2.5 font-mono text-[11px] font-semibold uppercase leading-snug tracking-[0.08em] text-text-2">
                    Call a side, dial the reach, hit <span className="text-brand-500">PLAY</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Aim</div>
                  <div className="flex items-baseline gap-2">
                    <span className="tnum text-[40px] font-extrabold leading-none text-brand-500">{reach}x</span>
                    <span className={cnm('font-mono text-[13px] font-bold uppercase tracking-[0.08em]', side === 'up' ? 'text-up' : 'text-down')}>
                      {sideLabel(side)}
                    </span>
                  </div>
                  <div className="mt-2.5 grid grid-cols-2 gap-x-3">
                    <Cell label="Bet" value={`$${stake}`} />
                    <Cell label="Win up to" value={`$${money(stake * reach)}`} />
                  </div>
                  <div className="mt-2.5 font-mono text-[11px] font-semibold uppercase leading-snug tracking-[0.08em] text-text-2">
                    Further reach, bigger multiple
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {phase === 'result' && play && <MoonshotResult play={play} streak={streak} />}
      {overlay === 'howto' && <HowTo />}
      {overlay === 'board' && <GameLeaderboardOverlay game="moonshot" title="Moonshot" />}
    </GameScreen>
  )
}

// One shared in-flight footer panel (FIRING / OPENING / SETTLING / FINAL / CASHING OUT): a kicker, a
// big headline, the play recap, and an optional progress bar (a determinate width or an indeterminate
// sweep). Keeps the five transient states identical instead of five near-copies.
function FooterStatus({
  kicker,
  head,
  recap,
  progress,
  sweep,
  tone = 'brand',
}: {
  kicker: string
  head: string
  recap: string
  progress?: number
  sweep?: boolean
  tone?: 'brand' | 'up'
}) {
  const ink = tone === 'up' ? 'text-up' : 'text-brand-500'
  const bar = tone === 'up' ? 'bg-up' : 'bg-brand-500'
  return (
    <>
      <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">{kicker}</div>
      <div className={cnm('text-[30px] font-extrabold leading-none', ink)}>{head}</div>
      <div className="mt-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-text-2">{recap}</div>
      <div className="mt-3 h-1 w-[200px] max-w-full overflow-hidden bg-line-strong">
        {sweep ? (
          <div className={cnm('bar-sweep h-full w-1/3', bar)} />
        ) : (
          <div className={cnm('h-full transition-[width] duration-300 ease-out', bar)} style={{ width: `${progress ?? 0}%` }} />
        )}
      </div>
    </>
  )
}

// The live readout while a round runs: the on-chain redeem quote (cash-out-now value) + the signed
// if-you-cash-out P/L, plus Cost / Win cells. The chart price is context only; money comes from the chain.
function LivePnl({ markValue, pnl, entryValue, maxPayout }: { markValue: string; pnl: string; entryValue: string; maxPayout: string }) {
  const pnlNumber = parseFloat(pnl) || 0
  const positive = pnlNumber >= 0
  return (
    <>
      <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Cash out now</div>
      <div className="tnum text-[40px] font-extrabold leading-none text-text">${formatExactDecimal(markValue)}</div>
      <div className="mt-1 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-text-3">
        If you cash out now{' '}
        <span className={cnm('tnum', positive ? 'text-up' : 'text-down')}>
          {pnlNumber >= 0 ? '+' : '-'}${formatExactDecimal(pnl, { absolute: true })}
        </span>
      </div>
      <div className="mt-2.5 grid grid-cols-2 gap-x-3">
        <Cell label="Cost" value={`$${formatExactDecimal(entryValue)}`} />
        <Cell label="Win" value={`$${formatExactDecimal(maxPayout)}`} />
      </div>
    </>
  )
}

// The win/miss/cash-out moment. Flat full-screen wash (docs/SCREEN.md): the verdict, the signed amount,
// the streak on a win. A pure readout, dismissed from any console button (CONTINUE).
function MoonshotResult({ play, streak }: { play: PlayDTO; streak: number }) {
  const reduced = useReducedMotion()
  const pnl = parseFloat(play.pnl ?? '0')
  const won = play.status === 'won'
  const cashed = play.status === 'cashed_out'
  const lost = play.status === 'lost'
  const positive = won || (cashed && pnl > 0)
  const head = won ? 'YOU CALLED IT' : cashed ? 'CASHED OUT' : 'MISSED'
  const pop = reduced
    ? {}
    : { initial: { scale: 0.7, opacity: 0 }, animate: { scale: 1, opacity: 1 }, transition: { type: 'spring' as const, stiffness: 440, damping: 24 } }
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/90 text-center">
      <div className={cnm('font-mono text-[13px] font-bold uppercase tracking-[0.2em]', positive ? 'text-up' : 'text-down')}>{head}</div>
      <motion.div {...pop} style={{ textShadow: '0 0 28px currentColor' }} className={cnm('tnum text-[56px] font-extrabold leading-none', positive ? 'text-up' : 'text-down')}>
        {lost ? `$${formatExactDecimal('0')}` : `${pnl >= 0 ? '+' : '-'}$${formatExactDecimal(play.pnl, { absolute: true })}`}
      </motion.div>
      <div className="mt-1 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-text-2">
        Payout ${formatExactDecimal(play.payout ?? '0')} · Cost ${formatExactDecimal(play.entryValue)}
      </div>
      {won && streak > 0 && (
        <div className="mt-1 inline-flex items-center border border-brand-500/60 px-2 py-0.5 font-mono text-[12px] font-bold uppercase tracking-[0.1em] text-brand-500">
          Streak {streak}
        </div>
      )}
      <span className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-text-3">Any button to continue</span>
    </div>
  )
}

// HOW TO: a flat in-screen card of the rules. Plain terminology only, no banned words.
function HowTo() {
  const lines: Array<[string, string]> = [
    ['CALL', 'Pick a side. LONG wins if the price climbs past your target, SHORT if it falls past it.'],
    ['REACH', 'Dial how far. A bigger reach sits further out, longer odds, a bigger multiple.'],
    ['WIN', 'Land past your target at the buzzer to win bet × multiple. Only where it ends counts.'],
    ['CASH OUT', 'Take the live value any time before the buzzer. Ahead? Lock it in before it can turn.'],
  ]
  return (
    <ScreenOverlay title="How to play">
      <div className="flex w-full flex-col gap-4">
        {lines.map(([k, v]) => (
          <div key={k}>
            <div className="font-mono text-[16px] font-bold uppercase tracking-[0.12em] text-text">{k}</div>
            <div className="mt-1 text-[15px] leading-snug text-text-2">{v}</div>
          </div>
        ))}
      </div>
    </ScreenOverlay>
  )
}
