import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import type { ChartOverlays } from '@/components/game/Chart'
import { Chart } from '@/components/game/Chart'
import { GameLeaderboardOverlay } from '@/components/game/GameLeaderboardOverlay'
import {
  FooterStatusPanel,
  InstructionOverlay,
  LiveValuePanel,
  ResultOverlay,
} from '@/components/game/gamePanels'
import { GameScreen, ScreenMessage, Cell } from '@/components/game/screen'
import { TradeConfirmSheet, useTradeConfirm } from '@/components/game/tradeConfirm'
import { LivePrice } from '@/components/game/LivePrice'
import { useConsoleControls } from '@/components/console/controls'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { useLiveMarkets } from '@/hooks/useLiveMarkets'
import {
  usePhaseElapsed,
  usePlayResolutionWatch,
  useRoundCountdown,
} from '@/hooks/useGameRound'
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
import { api, type LuckyParams, type PlayDTO, type PlayStatus, type Side } from '@/lib/api'
import { cashOut, placePlay } from '@/lib/sui/predict'
import { betLadder, netStakeUsd } from '@/lib/sui/config'
import { toastError } from '@/lib/errors'
import { useAuth } from '@/lib/auth'
import { useActivePlay } from '@/lib/activePlay'
import { cnm } from '@/utils/style'
import { formatExactDecimal, formatStringToNumericDecimals } from '@/utils/format'

// MOONSHOT. The whole call lives on the knob: scroll UP to go LONG, DOWN to go SHORT, and the further
// you scroll the bigger the target and the multiple (the sign is the side, the distance is the REACH).
// The right button switches the market, the number wheel sets the bet, then PLAY: a real Predict binary
// mint at the solved strike, ride the live value on the chart with a TARGET line, and CASH OUT early or
// hold to the buzzer for a spread-free WIN/MISS. It is the directional twin of Lucky (same binary
// mint/redeem path) but YOU aim it instead of the reel dealing it. Every round is a real position; demo
// mode runs the same flow on the in-memory model. The left button is the info rotary (HOW TO / RANKS),
// exactly like Range. Teenage Engineering language throughout (docs/SCREEN.md): flat black, mono labels,
// one amber accent, green/red for facts.
export const Route = createFileRoute('/_app/games/moonshot')({ component: MoonshotScreen })

// Stake ladder is sized to the live stake band (betLadder(), read inside the component), shared with
// Lucky + Range + the home wheel (same key).
const STAKE_KEY = 'pips_stake_idx'
// AIM ladder = the knob. Scroll up to go LONG, down to go SHORT: the index climbs bottom->top, so the
// deepest SHORT sits at the floor, the deepest LONG at the ceiling, and crossing the middle flips the
// side. The sign is the direction, abs() is the REACH (how far out the target sits = the multiple).
// The solver clamps to the live ask, so the far rungs land on the real mintable ceiling.
const AIM_LADDER = [-25, -10, -5, -3, -2, 2, 3, 5, 10, 25] as const
const AIM_KEY = 'pips_moonshot_aim'
const DEFAULT_AIM_IDX = 7 // LONG x5
// Preferred asset order for the first pin; the right button cycles the live markets from there.
const PREFERRED = ['BTC', 'ETH', 'SUI', 'SOL', 'DEEP']
// Coin marks for the asset cap (token display). Falls back to the ticker text where there is no logo.
const TOKEN_LOGOS: Record<string, string> = {
  BTC: '/assets/images/coins/btc-logo.png',
  ETH: '/assets/images/coins/eth-logo.png',
  SUI: '/assets/images/coins/sui-logo.png',
}

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

function MoonshotScreen() {
  const { refresh, user } = useAuth()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { track } = useActivePlay()

  const [stakeIdx, setStakeIdx] = useLocalStorage(STAKE_KEY, 2)
  const [aimIdx, setAimIdx] = useLocalStorage(AIM_KEY, DEFAULT_AIM_IDX)
  const [pinnedAsset, setPinnedAsset] = useState<string | null>(null)

  const [phase, setPhase] = useState<Phase>('idle')
  const [play, setPlay] = useState<PlayDTO | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [spot, setSpot] = useState<number | null>(null)
  const [overlay, setOverlay] = useState<Overlay>('none')

  const finalized = useRef(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const balanceSyncedPlayId = useRef<string | null>(null)
  const livePriceRef = useRef(0)

  const { liveAssets, noLiveMarket, playsPaused, isLoading: marketsLoading, isError: marketsError } = useLiveMarkets()
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

  // The scroll wheel is the whole call: the sign is the side (LONG above the middle, SHORT below), the
  // distance from the middle is the REACH multiple.
  const aim = AIM_LADDER[Math.min(aimIdx, AIM_LADDER.length - 1)]
  const side: Side = aim >= 0 ? 'up' : 'down'
  const reach = Math.abs(aim)

  // BET clamps to what the balance affords, so the wheel never offers an unplayable bet.
  const STAKE_LADDER = betLadder()
  const balance = parseFloat(user?.balance ?? '0') || 0
  const maxBetIdx = Math.max(0, STAKE_LADDER.reduce((acc, v, i) => (v <= balance ? i : acc), 0))
  const safeBetIdx = Math.min(stakeIdx, maxBetIdx)
  const stake = STAKE_LADDER[safeBetIdx]
  // Below the cheapest rung entirely: PLAY would just round-trip an INSUFFICIENT_DUSDC rejection, so
  // the idle button becomes the actual next step instead of a dead-end error toast.
  const cantAfford = balance < STAKE_LADDER[0]

  const lp = play ? (play.params as LuckyParams) : null
  const roundLive = phase === 'open' || phase === 'cashing'
  const showReadouts = play != null && roundLive
  // The position is real on-chain only once the mint confirms (status leaves 'pending'; a failed mint
  // goes 'error'). The entry/strike overlay is gated on this, never on the optimistic 'pending' window,
  // so nothing is drawn for a position that hasn't actually opened.
  const status = live?.status ?? play?.status
  const entered = status != null && status !== 'pending' && status !== 'error'
  const multiplier = live?.multiplier ?? play?.multiplier ?? reach

  const strike = play?.market.strike ? parseFloat(play.market.strike) : undefined
  const entrySpotNum = play?.entrySpot ? parseFloat(play.entrySpot) : NaN
  const entryVal = Number.isFinite(entrySpotNum) && entrySpotNum > 0 ? entrySpotNum : null

  // Pre-play preview TARGET: the aim line that tracks the live price as you turn REACH / flip the side.
  const previewTarget =
    spot != null && spot > 0
      ? spot * (1 + (side === 'up' ? 1 : -1) * Math.max(ROUND_VOL_EST * (REACH_Z[reach] ?? 0), MIN_TARGET_FRAC))
      : null

  // Chart overlays: the real strike + entry only once the position has opened on-chain; the live preview
  // aim while idle/placing. During the mint (open + still pending) nothing locked is drawn.
  const overlays: ChartOverlays | undefined = entered && lp
    ? {
        ...(entryVal != null ? { entry: entryVal } : {}),
        ...(strike != null ? { target: { price: strike, side: lp.side } } : {}),
      }
    : (phase === 'idle' || phase === 'placing') && previewTarget != null
      ? { target: { price: previewTarget, side } }
      : undefined
  const { secsLeft, remainingMs, settleMs } = useRoundCountdown({
    enabled: phase === 'open',
    play,
    fallbackDurationSec: NOMINAL_ROUND_SEC,
  })
  const cashMs = usePhaseElapsed(phase === 'cashing')

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
        toast.error('Could not open that play. Your chips are safe, fire again.', { id: 'moonshot-play-error' })
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
    haptic('heavy')
    moonshotFire()
    try {
      const { play: p } = await placePlay('moonshot', { stake, asset, side, reach })
      setPlay(p)
      track({ id: p.id, game: 'moonshot' })
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
  }, [phase, canPlay, stake, asset, side, reach, playsPaused, track])

  // Trade confirmation (opt-in, off by default). When on, PLAY arms first and CONFIRM places; the sheet
  // shows the aimed side/reach the second press will fire. Off, press() places immediately.
  const confirm = useTradeConfirm(
    () => void doPlay(),
    () => ({
      stake,
      headline: `${asset} · ${sideLabel(side)} · ${reach}x`,
      multiplier: reach,
      // Net of the house rake (config.ts netStakeUsd): the position sizes off net, so this is the true
      // max win, never stake * reach. No-op (full stake) in demo / when the rake is off.
      maxPayout: netStakeUsd(stake) * reach,
      note: 'Hold to the buzzer',
    }),
  )
  // Disarm the moment placement would be blocked or the round leaves idle, so CONFIRM never fires a
  // play the ready-state would have rejected.
  useEffect(() => {
    if (phase !== 'idle' || cantAfford || !canPlay || playsPaused) confirm.disarm()
  }, [phase, cantAfford, canPlay, playsPaused, confirm.disarm])

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

  const goDeposit = useCallback(() => {
    haptic('rigid')
    void navigate({ to: '/menu/deposit' })
  }, [navigate])

  // The knob sets the whole call. Fire the flip sting only when the side actually crosses the middle
  // (LONG <-> SHORT); a plain reach step within a side just clicks the knob's own detent.
  const setAim = useCallback(
    (next: number) => {
      const prev = AIM_LADDER[Math.min(aimIdx, AIM_LADDER.length - 1)]
      const now = AIM_LADDER[Math.min(next, AIM_LADDER.length - 1)]
      if ((prev >= 0) !== (now >= 0)) {
        moonshotFlip()
        haptic('rigid')
      }
      setAimIdx(next)
    },
    [aimIdx, setAimIdx],
  )

  // The right cap switches the market you're calling. Locked while a round is live (the open position's
  // asset can't change), and a no-op with nothing else to switch to.
  const cycleAsset = useCallback(() => {
    if (phase !== 'idle' && phase !== 'placing') return
    if (liveAssets.length < 2) return
    haptic('selection')
    setPinnedAsset((cur) => {
      const i = cur ? liveAssets.indexOf(cur) : -1
      return liveAssets[(i + 1) % liveAssets.length]
    })
  }, [phase, liveAssets])

  // The left cap is the same info rotary as Range: game -> how to -> leaderboard -> game. The label
  // names where the NEXT press lands.
  const rotateInfo = useCallback(() => {
    haptic('selection')
    setOverlay((o) => (o === 'none' ? 'howto' : o === 'howto' ? 'board' : 'none'))
  }, [])
  const infoLabel = overlay === 'none' ? 'HOW TO' : overlay === 'howto' ? 'RANKS' : 'GAME'

  const isResult = phase === 'result'
  const resultPositive =
    isResult && play != null && (play.status === 'won' || (play.status === 'cashed_out' && parseFloat(play.pnl ?? '0') >= 0))
  const resultColor: 'up' | 'down' = resultPositive ? 'up' : 'down'

  useConsoleControls({
    // The knob is the whole call: scroll up for LONG, down for SHORT, further out for a bigger reach.
    knob: {
      label: 'AIM',
      min: 0,
      max: AIM_LADDER.length - 1,
      step: 1,
      value: aimIdx,
      onChange: setAim,
      format: (v) => {
        const a = AIM_LADDER[Math.min(v, AIM_LADDER.length - 1)]
        return `${a > 0 ? 'L' : 'S'}${Math.abs(a)}x`
      },
    },
    // The number wheel keeps the bet, same as Lucky + Range.
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
    // The right cap switches the market (token display). A no-op once a round is live, since an open
    // position's asset can't change, so it just reads the locked market.
    action2: isResult
      ? { label: '', color: resultColor, onPress: dismissResult, pulse: true }
      : {
          label: asset,
          color: 'neutral',
          onPress: cycleAsset,
          display: { mode: 'token', ticker: asset, logoSrc: TOKEN_LOGOS[asset] },
        },
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
                  : cantAfford
                    ? { label: 'TOP UP', color: 'amber', onPress: goDeposit }
                    : confirm.armed
                      ? { label: 'CONFIRM', color: 'amber', onPress: confirm.press } // 2nd press places
                      : { label: 'PLAY', color: 'amber', onPress: confirm.press }, // 1st press arms (or places if off)
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
      ) : playsPaused && phase === 'idle' ? (
        <ScreenMessage title="Plays paused" hint="Topping up gas" />
      ) : noLiveMarket ? (
        <ScreenMessage title="No live markets right now." />
      ) : (
        <div className="relative flex h-full flex-col">
          {/* HEADER — market + live price (left), balance / expiry countdown (right). */}
          <div className="shrink-0 border-b border-line-strong bg-black pt-[calc(var(--screen-rim,24px)+12px)]">
            <div className="flex items-start justify-between gap-3 px-[var(--screen-rim,24px)] pb-4">
              <div className="min-w-0">
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-text-3">Moonshot · {asset}</div>
                <div className="tnum text-[34px] font-extrabold leading-none text-text"><LivePrice price={spot} /></div>
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
              {confirm.armed ? (
                <TradeConfirmSheet details={confirm.armed} remainingMs={confirm.remainingMs} />
              ) : phase === 'placing' ? (
                <FooterStatusPanel kicker="Launching" head="FIRING" recap={recap} sweep />
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
                <LiveValuePanel
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
                    Scroll up <span className="text-up">LONG</span> or down <span className="text-down">SHORT</span>, hit{' '}
                    <span className="text-brand-500">PLAY</span>
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
                    {/* Net of the house rake, so this never over-promises the aimed win (config.ts). */}
                    <Cell label="Win up to" value={`$${money(netStakeUsd(stake) * reach)}`} />
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

      {phase === 'result' && play && (
        <ResultOverlay
          play={play}
          streak={streak}
          winTitle="YOU CALLED IT"
          cashoutTitle="CASHED OUT"
          loseTitle="MISSED"
        />
      )}
      {overlay === 'howto' && (
        <InstructionOverlay
          compact
          lines={[
            ['AIM', 'Knob up to go LONG, down to go SHORT. Further out, bigger target and multiple.'],
            ['MARKET', 'Right button switches the market you call.'],
            ['WIN', 'End past your target at the buzzer to win bet × multiple.'],
            ['CASH OUT', 'Take the live value any time before the buzzer.'],
          ]}
        />
      )}
      {overlay === 'board' && <GameLeaderboardOverlay game="moonshot" title="Moonshot" />}
    </GameScreen>
  )
}
