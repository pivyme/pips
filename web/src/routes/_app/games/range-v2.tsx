import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import type { PlayDTO } from '@/lib/api'
import type { LivePlaySnapshot } from '@/hooks/useGameRound'
import { useConsoleControls } from '@/components/console/controls'
import { Chart, type ChartGeometry } from '@/components/game/Chart'
// import { CrowdLayer } from '@/components/game/CrowdLayer' // temporarily disabled
import { GameLeaderboardOverlay } from '@/components/game/GameLeaderboardOverlay'
import { InstructionOverlay } from '@/components/game/gamePanels'
import { LivePrice } from '@/components/game/LivePrice'
import { Cell, GameScreen, ScreenMessage } from '@/components/game/screen'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { useLiveMarkets } from '@/hooks/useLiveMarkets'
import { usePlayResolutionWatch } from '@/hooks/useGameRound'
import { haptic } from '@/lib/haptics'
import { rangeBuzzer, rangeCross, rangeLose, rangeWin, startRangeBgm, stopRangeBgm } from '@/lib/sound'
import { api } from '@/lib/api'
import { cashOut, placePlay } from '@/lib/sui/predict'
import { betLadder } from '@/lib/sui/config'
import { toastError } from '@/lib/errors'
import { useAuth } from '@/lib/auth'
import { cnm } from '@/utils/style'
import { formatStringToNumericDecimals } from '@/utils/format'

// RANGE V2 (experiment): the multiplay variant. Instead of one round at a time, you STACK positions,
// each a real Range mint that rides to its own buzzer, and fire more without waiting. Results pop inline,
// never a full-screen result gate, so the loop never stalls. Backend is unchanged: multiple open plays already
// work (settle worker batches them), so this is a pure client screen calling the same placePlay/cashOut/streamPlay.
export const Route = createFileRoute('/_app/games/range-v2')({
  component: RangeV2Screen,
})

const STAKE_KEY = 'pips_stake_idx' // shared with Lucky + Range so the chip stays put across screens
const BAND_LADDER: Array<number> = [0.02, 0.035, 0.05, 0.08, 0.15]
const DEFAULT_WIDTH_IDX = 2
const FALLBACK_ASSETS = ['BTC', 'ETH', 'SUI', 'SOL', 'DEEP']
const TOKEN_LOGOS: Record<string, string> = {
  BTC: '/assets/images/coins/btc-logo.png',
  ETH: '/assets/images/coins/eth-logo.png',
  SUI: '/assets/images/coins/sui-logo.png',
}
const NOMINAL_ROUND_SEC = 30
// How many positions can ride at once. Caps the chart clutter + keeps the per-user mint queue sane.
const MAX_POSITIONS = 5
// How long a resolved band flashes its verdict on the chart/strip before it clears out.
const RESULT_HOLD_MS = 3500
// Resolutions landing within this window of the PREVIOUS one merge into one WAVE (one splash, one
// running total). Rolling, because settlement staggers over seconds: a buzzer batch must read as a
// single payoff beat that grows, never a burst of disjoint blinks.
const WAVE_MERGE_MS = 2500
// How long the wave's ±$ splash rides over the chart. Non-blocking, PLAY stays hot under it.
const WAVE_SPLASH_MS = 1700
// Safety-net poll behind each position's SSE, same as the single-play screens.
const WATCHDOG_MS = 3000

type Status = 'placing' | 'pending' | 'open' | 'won' | 'lost' | 'cashed_out'
type Position = {
  key: string // stable local id, set before the mint lands
  slot: number // display number tying the chip to its chart flag; lowest free at fire time
  playId?: string // filled once placePlay returns
  asset: string
  status: Status
  stake: number
  multiplier: number
  band?: { lower: number; upper: number }
  entrySpot?: number
  expiry?: number
  openedAt?: number // when the mint landed, so the chip's countdown bar knows the full round length
  markValue?: string
  pnl?: string
  maxPayout?: string
  lockPrice?: string
  won?: boolean
  resolvedAt?: number
}
type Session = { net: number; wins: number; losses: number; best: number; streak: number }
// `at` is the LAST folded-in resolution (drives the display windows + splash re-pop), `startedAt` is
// stable per wave (keys the panel so its pop/count-up runs once while merged totals keep chasing).
type Wave = { pnl: number; wins: number; losses: number; at: number; startedAt: number }
type Overlay = 'none' | 'howto' | 'board'

const isResolved = (p: Position): boolean =>
  p.status === 'won' || p.status === 'lost' || p.status === 'cashed_out'
const isLive = (p: Position): boolean =>
  p.status === 'placing' || p.status === 'pending' || p.status === 'open'

const usd = (n: number): string =>
  (Number.isFinite(n) ? n : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtMult = (m: number): string => `${m.toFixed(2).replace(/\.?0+$/, '')}×`
const num = (s?: string): number => (s ? parseFloat(s) || 0 : 0)

const setsEqual = (a: Set<string>, b: Set<string>): boolean => {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

// Cold-start multiple estimate, only until the real per-band quote loads (same shape as Range).
function estimateMultiplier(halfPct: number, durationSec: number): number {
  const sigma = 0.05 * Math.sqrt(durationSec / 30)
  const prob = 1 - Math.exp(-halfPct / sigma)
  return Math.max(1.05, Math.min(0.97 / Math.max(prob, 0.03), 99))
}

function RangeV2Screen() {
  const { refresh, user } = useAuth()
  const qc = useQueryClient()
  const navigate = useNavigate()

  const [widthIdx, setWidthIdx] = useState(DEFAULT_WIDTH_IDX)
  const [stakeIdx, setStakeIdx] = useLocalStorage(STAKE_KEY, 2)
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null)
  const [positions, setPositions] = useState<Position[]>([])
  const [spot, setSpot] = useState<number | null>(null)
  const [overlay, setOverlay] = useState<Overlay>('none')
  const [inZoneKeys, setInZoneKeys] = useState<Set<string>>(new Set())
  const [session, setSession] = useState<Session>({ net: 0, wins: 0, losses: 0, best: 0, streak: 0 })
  const [wave, setWave] = useState<Wave | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [, setSelfPlaceSignal] = useState(0) // bump to pop a coin for your own play (crowd overlay temporarily disabled)

  const livePriceRef = useRef(0)
  const geometryRef = useRef<ChartGeometry | null>(null) // chart-published geometry for the crowd overlay
  const positionsRef = useRef(positions)
  positionsRef.current = positions
  const keySeq = useRef(0)
  const resolvedIds = useRef<Set<string>>(new Set())
  const waveRef = useRef<Wave | null>(null)
  const lastPingRef = useRef(0)
  const buzzedExpiryRef = useRef<number | null>(null)

  const { liveAssets, noLiveMarket, playsPaused, isLoading: marketsLoading, isError: marketsError } = useLiveMarkets()

  const assets = liveAssets.length ? liveAssets : FALLBACK_ASSETS
  const activeAsset = selectedAsset && assets.includes(selectedAsset) ? selectedAsset : assets[0]
  // While any position rides, the whole board is pinned to that asset (one chart, one price), so the
  // asset selector locks. Only BTC is live on testnet anyway; this just keeps the bands coherent.
  const lockedAsset = positions.find(isLive)?.asset ?? null
  const asset = lockedAsset ?? activeAsset

  const STAKE_LADDER = betLadder()
  const balance = parseFloat(user?.balance ?? '0') || 0
  const maxBetIdx = Math.max(0, STAKE_LADDER.reduce((acc, v, i) => (v <= balance ? i : acc), 0))
  const safeBetIdx = Math.min(stakeIdx, maxBetIdx)
  const stake = STAKE_LADDER[safeBetIdx]
  const cantAfford = balance < STAKE_LADDER[0]

  const halfPct = BAND_LADDER[Math.min(widthIdx, BAND_LADDER.length - 1)]
  const canPlay = liveAssets.length > 0

  // Real Predict-ask quotes for the ladder, so the idle "pays" preview shows the true next-play multiple.
  const bandWidthsPct = BAND_LADDER.map((h) => h * 2)
  const quotesQ = useQuery({
    queryKey: ['rangeQuotes', asset],
    queryFn: () => api.rangeQuotes(asset, bandWidthsPct),
    enabled: canPlay && !!asset,
    placeholderData: (prev) => prev,
    staleTime: 4_000,
    refetchInterval: 8_000,
    retry: false,
  })
  const quotedMult = quotesQ.data?.quotes[widthIdx]?.multiplier
  const idleMult = quotedMult && quotedMult > 0 ? quotedMult : estimateMultiplier(halfPct, NOMINAL_ROUND_SEC)

  // Derived board numbers.
  const inPlay = positions.filter(isLive)
  const openPos = positions.filter((p) => p.status === 'open' || p.status === 'pending')
  const n = inPlay.length
  const atMax = n >= MAX_POSITIONS
  const totalToWin = openPos.reduce((a, p) => a + num(p.maxPayout), 0)
  // Settlement-if-now: the in-zone bands pay full, the rest pay zero. The gamey hero the price chases.
  const collectNow = openPos.filter((p) => inZoneKeys.has(p.key)).reduce((a, p) => a + num(p.maxPayout), 0)
  // Cash-all-now: the live redeem mark across every open band, i.e. what CASH ALL actually banks this instant.
  const cashOutNow = openPos.reduce((a, p) => a + num(p.markValue), 0)
  // Out of every band: the settle-now hero would be a dead $0, so it swaps to the cash-out value instead.
  const allOut = openPos.length > 0 && collectNow <= 0
  const inZoneCount = openPos.filter((p) => inZoneKeys.has(p.key)).length
  const expiries = openPos.map((p) => p.expiry).filter((e): e is number => typeof e === 'number' && e > 0)
  const soonestExpiry = expiries.length ? Math.min(...expiries) : null
  const nextSecs = soonestExpiry != null ? Math.max(0, Math.ceil((soonestExpiry - nowMs) / 1000)) : null
  const settlingWave = soonestExpiry != null && soonestExpiry <= nowMs && openPos.length > 0

  // A single ~250ms clock drives the shared countdown + the resolved-band cleanup.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 250)
    return () => clearInterval(t)
  }, [])

  // Sweep out resolved bands once their flash window lapses. Idempotent (returns the same array when nothing ages out).
  useEffect(() => {
    setPositions((prev) => {
      const keep = prev.filter((p) => !(isResolved(p) && p.resolvedAt != null && nowMs - p.resolvedAt > RESULT_HOLD_MS))
      return keep.length === prev.length ? prev : keep
    })
  }, [nowMs])

  // 60fps in/out read off the eased chart price, re-rendering only when the in-zone SET actually changes.
  // A position crossing an edge (open in both frames, membership flipped) fires a subtle haptic. The cross
  // SOUND is reserved for the whole board arming (every zone lit) or losing that armed state; per-edge
  // sound with a 5-band stack would turn into a metronome.
  useEffect(() => {
    let raf = 0
    let prevIn = new Set<string>()
    let prevTracked = new Set<string>()
    let prevAllIn = false
    let lastTick = 0
    const loop = () => {
      const p = livePriceRef.current
      const next = new Set<string>()
      const tracked = new Set<string>()
      if (p > 0) {
        for (const pos of positionsRef.current) {
          if (pos.band && (pos.status === 'open' || pos.status === 'pending')) {
            tracked.add(pos.key)
            if (p > pos.band.lower && p <= pos.band.upper) next.add(pos.key)
          }
        }
      }
      let entered = false
      let exited = false
      for (const k of tracked) {
        if (!prevTracked.has(k)) continue // newly opened or just resolved: not a price cross
        const is = next.has(k)
        if (is !== prevIn.has(k)) {
          if (is) entered = true
          else exited = true
        }
      }
      const t = performance.now()
      if ((entered || exited) && t - lastTick > 400) {
        lastTick = t
        haptic(exited ? 'rigid' : 'selection')
      }
      const allIn = tracked.size > 0 && next.size === tracked.size
      if (allIn && !prevAllIn && entered) rangeCross(true) // the board armed: every zone paying
      else if (!allIn && prevAllIn && exited) rangeCross(false) // dropped out of the armed state
      prevAllIn = allIn
      prevIn = next
      prevTracked = tracked
      setInZoneKeys((prev) => (setsEqual(prev, next) ? prev : next))
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Tension bed rides while anything is live; cut the instant the board goes flat so the last sting lands over silence.
  const anyLive = inPlay.length > 0
  useEffect(() => {
    if (!anyLive) return
    startRangeBgm()
    return () => stopRangeBgm()
  }, [anyLive])

  // One-shot riser as the soonest buzzer closes in, once per distinct expiry.
  useEffect(() => {
    if (soonestExpiry == null) return
    const secs = (soonestExpiry - nowMs) / 1000
    if (secs <= 3 && secs > 0 && buzzedExpiryRef.current !== soonestExpiry) {
      buzzedExpiryRef.current = soonestExpiry
      rangeBuzzer()
    }
  }, [soonestExpiry, nowMs])

  const ping = useCallback((won: boolean) => {
    haptic(won ? 'success' : 'error')
    const t = Date.now()
    if (t - lastPingRef.current < 200) return // debounce a buzzer wave into one sting, not a cacophony
    lastPingRef.current = t
    if (won) rangeWin()
    else rangeLose()
  }, [])

  // Resolve one position from its finalized play; dedupes so a cash-out's direct call and the watcher can't double-count.
  const resolvePosition = useCallback(
    (playId: string, final: PlayDTO) => {
      if (resolvedIds.current.has(playId)) return
      resolvedIds.current.add(playId)
      const pnl = num(final.pnl)
      const won = final.status === 'won' || (final.status === 'cashed_out' && pnl >= 0)
      setPositions((prev) =>
        prev.map((p) =>
          p.playId === playId
            ? {
                ...p,
                status: final.status as Status,
                pnl: final.pnl,
                maxPayout: final.maxPayout ?? p.maxPayout,
                multiplier: final.multiplier || p.multiplier,
                band:
                  final.market.lower != null && final.market.upper != null
                    ? { lower: parseFloat(final.market.lower), upper: parseFloat(final.market.upper) }
                    : p.band,
                won,
                resolvedAt: Date.now(),
              }
            : p,
        ),
      )
      setSession((s) => ({
        net: s.net + pnl,
        wins: s.wins + (won ? 1 : 0),
        losses: s.losses + (won ? 0 : 1),
        best: Math.max(s.best, pnl),
        streak: won ? s.streak + 1 : 0,
      }))
      // Fold this resolution into the current wave (or start one): one splash + one running total per
      // buzzer batch. The window rolls forward on each merge so staggered settlement stays one beat.
      const now = Date.now()
      const w =
        waveRef.current && now - waveRef.current.at < WAVE_MERGE_MS
          ? waveRef.current
          : { pnl: 0, wins: 0, losses: 0, at: now, startedAt: now }
      w.pnl += pnl
      if (won) w.wins++
      else w.losses++
      w.at = now
      waveRef.current = w
      setWave({ ...w })
      ping(won)
      void refresh()
      for (const key of ['stats', 'achievements', 'plays']) void qc.invalidateQueries({ queryKey: [key] })
    },
    [ping, refresh, qc],
  )

  const handleSnapshot = useCallback((playId: string, s: LivePlaySnapshot) => {
    setPositions((prev) =>
      prev.map((p) => {
        if (p.playId !== playId || isResolved(p)) return p
        const status: Status = s.status === 'pending' || s.status === 'open' ? s.status : p.status
        return {
          ...p,
          status,
          markValue: s.markValue,
          pnl: s.pnl,
          maxPayout: s.maxPayout ?? p.maxPayout,
          multiplier: s.multiplier || p.multiplier,
          lockPrice: s.lockPrice ?? p.lockPrice,
        }
      }),
    )
  }, [])

  // The mint never opened (chips safe): drop the chip quietly, one toast.
  const handleError = useCallback((playId: string) => {
    setPositions((prev) => prev.filter((p) => p.playId !== playId))
    toast.error('A play could not open. Your chips are safe.', { id: 'rv2-error' })
  }, [])

  const doPlay = useCallback(async () => {
    if (playsPaused) {
      toast.error('Plays paused while we top up. Back in a moment.', { id: 'rv2-paused' })
      return
    }
    if (!canPlay) {
      toast.error('No live market right now. Try again in a sec.', { id: 'rv2-no-market' })
      return
    }
    if (positionsRef.current.filter(isLive).length >= MAX_POSITIONS) {
      haptic('error')
      toast('Max positions in play. Let some settle first.', { id: 'rv2-max' })
      return
    }
    if (cantAfford) return
    const key = `pos-${keySeq.current++}`
    // Lowest number not on the board (flashing results still hold theirs), so chip and chart flag match.
    const used = new Set(positionsRef.current.map((p) => p.slot))
    let slot = 1
    while (used.has(slot)) slot++
    const placing: Position = { key, slot, status: 'placing', asset, stake, multiplier: idleMult }
    setPositions((prev) => [...prev, placing])
    setSelfPlaceSignal((s) => s + 1) // your own coin-pop, same primitive as the crowd
    haptic('heavy')
    try {
      const { play } = await placePlay('range', { stake, asset, widthPct: halfPct * 2 })
      setPositions((prev) =>
        prev.map((p) =>
          p.key === key
            ? {
                ...p,
                playId: play.id,
                status: play.status as Status,
                band:
                  play.market.lower != null && play.market.upper != null
                    ? { lower: parseFloat(play.market.lower), upper: parseFloat(play.market.upper) }
                    : undefined,
                entrySpot: play.entrySpot ? parseFloat(play.entrySpot) : undefined,
                expiry: play.market.expiry,
                openedAt: Date.now(),
                multiplier: play.multiplier || p.multiplier,
                markValue: play.markValue,
                pnl: play.pnl,
                maxPayout: play.maxPayout,
              }
            : p,
        ),
      )
      haptic('selection')
      void refresh()
    } catch (e) {
      setPositions((prev) => prev.filter((p) => p.key !== key))
      toastError(e)
    }
  }, [asset, stake, halfPct, idleMult, canPlay, playsPaused, cantAfford, refresh])

  // Bank every open position at the live mark. Failures (buzzer beat the redeem) reconcile through the watcher.
  const cashAll = useCallback(() => {
    const open = positionsRef.current.filter((p) => p.playId && p.status === 'open')
    if (!open.length) return
    haptic('rigid')
    for (const p of open) {
      void cashOut(p.playId!)
        .then(({ play }) => resolvePosition(p.playId!, play))
        .catch(() => {})
    }
  }, [resolvePosition])

  const goDeposit = useCallback(() => {
    haptic('rigid')
    void navigate({ to: '/menu/deposit' })
  }, [navigate])
  const cycleAsset = useCallback(() => {
    if (lockedAsset) {
      haptic('error')
      toast('Asset locked while positions are open.', { id: 'rv2-lock' })
      return
    }
    haptic('selection')
    if (!assets.length) return
    const i = assets.indexOf(activeAsset)
    setSelectedAsset(assets[(i + 1) % assets.length])
  }, [assets, activeAsset, lockedAsset])
  const rotateInfo = useCallback(() => {
    haptic('selection')
    setOverlay((o) => (o === 'none' ? 'howto' : o === 'howto' ? 'board' : 'none'))
  }, [])
  const infoLabel = overlay === 'none' ? 'HOW TO' : overlay === 'howto' ? 'RANKS' : 'GAME'

  useConsoleControls({
    knob: {
      label: 'RANGE',
      min: 0,
      max: BAND_LADDER.length - 1,
      step: 1,
      value: widthIdx,
      onChange: setWidthIdx,
      format: (v) => `±${BAND_LADDER[Math.min(v, BAND_LADDER.length - 1)].toFixed(1)}%`,
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
    action1:
      openPos.length > 0
        ? { label: 'CASH ALL', color: 'up', onPress: cashAll }
        : { label: infoLabel, color: 'neutral', onPress: rotateInfo },
    action2: {
      label: asset,
      color: 'neutral',
      onPress: cycleAsset,
      display: { mode: 'token', ticker: asset, logoSrc: TOKEN_LOGOS[asset] },
    },
    main: atMax
      ? { label: 'MAX', color: 'neutral', onPress: () => {} }
      : cantAfford
        ? { label: 'TOP UP', color: 'amber', onPress: goDeposit }
        : { label: 'PLAY', color: 'amber', onPress: () => void doPlay() },
  })

  // Chart overlays: the open bands as forward-zone lanes (live + flashing verdicts) PLUS a persistent aim
  // bracket showing where the NEXT play lands, so you can always size the next band even with a full stack.
  // The aim hides at MAX (nothing more to place), which doubles as the "you're full" cue.
  const positionBands = positions
    .filter((p) => p.band && p.asset === asset && p.status !== 'placing')
    .map((p) => ({
      lower: p.band!.lower,
      upper: p.band!.upper,
      state: (isResolved(p) ? (p.won ? 'won' : 'lost') : 'live') as 'live' | 'won' | 'lost',
      n: p.slot, // the chart flag mirrors the chip's number
    }))
  const showAim = canPlay && !atMax && spot != null
  const overlays =
    positionBands.length || showAim
      ? {
          bands: positionBands.length ? positionBands : undefined,
          aim: showAim ? { pct: halfPct, tag: `NEXT ${fmtMult(idleMult)}` } : undefined,
        }
      : undefined

  // Strip order: by slot number, always. A chip never moves while it lives (verdicts flash in place),
  // so the eye can track "chip 3" from fire to result without re-scanning the row.
  const orderedPositions = [...positions].sort((a, b) => a.slot - b.slot)

  const sessionShown = session.wins + session.losses > 0
  const netStr = `${session.net >= 0 ? '+' : '−'}$${usd(Math.abs(session.net))}`
  // The footer holds the wave's total for the same window the chips flash, so the payoff beat and the
  // strip clear together instead of the readout snapping straight back to the idle preview.
  const waveShown = wave != null && nowMs - wave.at < RESULT_HOLD_MS

  const showResults = positions.length > 0
  const blankScreen = marketsLoading || marketsError || (noLiveMarket && !showResults) || (playsPaused && !showResults)

  return (
    <GameScreen>
      {/* Hidden watchers: one SSE + watchdog per open position, mirroring the single-play screens. */}
      {positions
        .filter((p) => p.playId && !isResolved(p))
        .map((p) => (
          <PositionWatch
            key={p.playId}
            playId={p.playId!}
            refresh={refresh}
            onSnapshot={handleSnapshot}
            onResolved={resolvePosition}
            onError={handleError}
          />
        ))}

      {marketsLoading ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="shimmer h-24 w-2/3" />
        </div>
      ) : marketsError ? (
        <ScreenMessage title="Could not load markets" />
      ) : blankScreen ? (
        <ScreenMessage title={playsPaused ? 'Plays paused' : 'No live markets right now.'} hint={playsPaused ? 'Topping up gas' : 'Reconnecting'} />
      ) : (
        <div className="relative flex h-full flex-col">
          {/* HEADER: market + live price (left), balance / shared buzzer (right). */}
          <div className="shrink-0 border-b border-line-strong bg-black pt-[calc(var(--screen-rim,24px)+12px)]">
            <div className="flex items-start justify-between gap-3 px-[var(--screen-rim,24px)] pb-4">
              <div className="min-w-0">
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-text-3">
                  Range V2 · {asset}
                </div>
                <div className="tnum text-[34px] font-extrabold leading-none text-text">
                  <LivePrice price={spot} />
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                  {settlingWave ? 'Settling' : n > 0 ? 'Next buzzer' : 'Available'}
                </div>
                <div className="tnum text-xl font-bold leading-none text-text-2">
                  {settlingWave
                    ? '···'
                    : n > 0 && nextSecs != null
                      ? `${nextSecs}s`
                      : user?.balance != null
                        ? `$${formatStringToNumericDecimals(user.balance, 2)}`
                        : '—'}
                </div>
              </div>
            </div>
          </div>

          {/* POSITIONS STRIP: a live row of chips, one per position. Top of the L is full width, never occluded. */}
          {positions.length > 0 && (
            <div className="shrink-0 border-b border-line-strong bg-black px-[var(--screen-rim,24px)] py-2">
              {/* Slot-ordered (stable): each chip stays put from fire to verdict, numbered to its chart flag.
                  Compact chips keep the full stack on one line even on a narrow device; overflow wraps. */}
              <div className="flex flex-wrap items-center gap-1">
                {orderedPositions.map((p) => (
                  <PositionChip key={p.key} p={p} inZone={inZoneKeys.has(p.key)} nowMs={nowMs} />
                ))}
              </div>
            </div>
          )}

          {/* CHART: bounded between header/strip and footer; all bands ride inside it. */}
          <div className="relative min-h-0 flex-1">
            {/* Countdown lives in the header + chip bars all round; the big watermark only spikes in the final
                seconds as a buzzer-incoming tension cue, so it isn't competing for attention the whole time. */}
            {nextSecs != null && nextSecs > 0 && nextSecs <= 6 && !settlingWave && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
                <span className="tnum font-black leading-none text-brand-500 opacity-[0.16] text-[clamp(64px,18vh,128px)]">
                  {nextSecs}
                </span>
              </div>
            )}
            {/* Wave payoff splash: the batch's ±$ pops over the chart, then fades. Non-blocking, PLAY stays hot. */}
            {wave != null && nowMs - wave.at < WAVE_SPLASH_MS && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden">
                <span
                  key={wave.at}
                  className={cnm(
                    'wave-splash tnum font-black leading-none text-[clamp(44px,12vh,84px)]',
                    wave.pnl >= 0 ? 'text-up' : 'text-down',
                  )}
                >
                  {`${wave.pnl >= 0 ? '+' : '−'}$${usd(Math.abs(wave.pnl))}`}
                </span>
              </div>
            )}
            {asset ? (
              <>
                <Chart
                  asset={asset}
                  overlays={overlays}
                  livePriceRef={livePriceRef}
                  geometryRef={geometryRef}
                  onPrice={(p) => setSpot(p)}
                  className="absolute inset-0"
                />
                {/* Social crowd: fake other-players riding the line so the round never reads dead. Cosmetic,
                    isolated (no chain/api), pinned to the price line via the chart's geometry snapshot. */}
                {/* Temporarily disabled: other-player activity crowd overlay.
                <CrowdLayer geometryRef={geometryRef} livePriceRef={livePriceRef} selfPlaceSignal={selfPlaceSignal} /> */}
              </>
            ) : null}
          </div>

          {/* FOOTER: left-only readout (bottom-right is the knob/PLAY body). In-play shows the live collect; idle shows the next-play preview. */}
          <div className="shrink-0 border-t border-line-strong bg-black px-[var(--screen-rim,24px)] pb-[var(--screen-rim,24px)] pt-3.5 min-h-[var(--screen-notch,21%)]">
            <div className="max-w-[62%]">
              {openPos.length > 0 ? (
                <>
                  <div className="flex items-center gap-2">
                    <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                      In play · {n}
                    </div>
                    <span
                      className={cnm(
                        'inline-flex items-center border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.1em]',
                        inZoneCount > 0 && inZoneCount === openPos.length
                          ? 'border-up bg-up/20 text-up' // every zone lit: the jackpot-armed state
                          : inZoneCount > 0
                            ? 'border-up/60 text-up'
                            : 'border-down/60 text-down',
                      )}
                    >
                      {inZoneCount > 0 ? `${inZoneCount}/${openPos.length} in zone` : 'All out'}
                    </span>
                  </div>
                  {/* Keyed on the zone count so the number pops when a zone lights up or drops, never on mark drift. */}
                  <div
                    key={`${inZoneCount}/${openPos.length}`}
                    className={cnm(
                      'tnum mt-0.5 origin-left text-[40px] font-extrabold leading-none animate-[zone-pop_200ms_ease-out]',
                      allOut ? 'text-brand-500' : 'text-up',
                    )}
                  >
                    ${usd(allOut ? cashOutNow : collectNow)}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-text-3">
                    {allOut ? 'Cash out value now' : 'If the buzzer hit now'}
                  </div>
                  <div className="mt-2.5 grid grid-cols-3 gap-x-3">
                    <Cell label="Cash all" value={`$${usd(cashOutNow)}`} />
                    <Cell label="To win" value={`$${usd(totalToWin)}`} />
                    <Cell label="Next" value={settlingWave ? '···' : `${nextSecs ?? 0}s`} />
                  </div>
                </>
              ) : waveShown && wave != null ? (
                <>
                  {/* The payoff panel: the wave's one big number, then straight into the next-play numbers. */}
                  <div className="flex items-center gap-2">
                    <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                      Wave result
                    </div>
                    <span
                      className={cnm(
                        'inline-flex items-center border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.1em]',
                        wave.wins > 0 ? 'border-up/60 text-up' : 'border-down/60 text-down',
                      )}
                    >
                      {wave.wins}/{wave.wins + wave.losses} hit
                    </span>
                  </div>
                  <div
                    key={wave.startedAt}
                    className={cnm(
                      'tnum mt-0.5 origin-left text-[40px] font-extrabold leading-none animate-[zone-pop_200ms_ease-out]',
                      wave.pnl >= 0 ? 'text-up' : 'text-down',
                    )}
                  >
                    {wave.pnl >= 0 ? (
                      <CountUp value={wave.pnl} format={(v) => `+$${usd(v)}`} />
                    ) : (
                      `−$${usd(Math.abs(wave.pnl))}`
                    )}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-text-3">
                    {wave.pnl >= 0 ? 'Banked. Fire the next wave.' : 'Missed. Fire again.'}
                  </div>
                  <div className="mt-2.5 grid grid-cols-2 gap-x-3">
                    <Cell label="Next pays" value={`${idleMult.toFixed(2)}x`} />
                    <Cell label="Amount" value={`$${stake}`} />
                  </div>
                </>
              ) : (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Pays</div>
                  <div className="tnum text-[40px] font-extrabold leading-none text-brand-500">
                    {idleMult.toFixed(2)}x
                  </div>
                  <div className="mt-2.5 grid grid-cols-2 gap-x-3">
                    <Cell label="Amount" value={`$${stake}`} />
                    <Cell label="Band" value={`±${halfPct.toFixed(1)}%`} />
                  </div>
                  <div className="mt-2.5 font-mono text-[11px] font-semibold uppercase leading-snug tracking-[0.08em] text-text-2">
                    Stack as many as you like. They all settle on the buzzer.
                  </div>
                </>
              )}
              {sessionShown && (
                <div className="mt-2.5 flex items-center gap-2 border-t border-line-strong pt-2 font-mono text-[10px] font-bold uppercase tracking-[0.12em]">
                  <span className="text-text-3">Session</span>
                  <span className={cnm('tnum', session.net >= 0 ? 'text-up' : 'text-down')}>{netStr}</span>
                  <span className="text-text-3">·</span>
                  <span className="tnum text-text-2">
                    {session.wins}-{session.losses}
                  </span>
                  {session.streak >= 2 && (
                    <>
                      <span className="text-text-3">·</span>
                      <span className="tnum text-brand-500">Streak {session.streak}</span>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {overlay === 'howto' && (
        <InstructionOverlay
          lines={[
            ['ZONES', 'PLAY drops a numbered zone that rides to the buzzer. Stack up to 5.'],
            ['CHIPS', 'Green chip = price inside that zone, it pays at the buzzer. Red = outside.'],
            ['KNOB', 'Sizes the next band. Tighter pays more.'],
            ['CASH ALL', 'Bank every open zone at its live value before the buzzer.'],
          ]}
        />
      )}
      {overlay === 'board' && <GameLeaderboardOverlay game="range" title="Range" />}
    </GameScreen>
  )
}

// One position's live watcher: an SSE + lazy watchdog, resolving exactly once on a terminal status. Renders nothing.
function PositionWatch({
  playId,
  refresh,
  onSnapshot,
  onResolved,
  onError,
}: {
  playId: string
  refresh: () => void | Promise<void>
  onSnapshot: (playId: string, s: LivePlaySnapshot) => void
  onResolved: (playId: string, final: PlayDTO) => void
  onError: (playId: string) => void
}) {
  const finalized = useRef(false)
  const synced = useRef<string | null>(null)
  usePlayResolutionWatch({
    enabled: true,
    playId,
    finalizedRef: finalized,
    watchdogMs: WATCHDOG_MS,
    syncedOpenPlayIdRef: synced,
    refreshOnOpen: refresh,
    onSnapshot: (s) => onSnapshot(playId, s),
    onTerminal: (status, id) => {
      if (finalized.current) return
      if (status === 'error') {
        finalized.current = true
        onError(id)
        return
      }
      if (status === 'won' || status === 'lost' || status === 'cashed_out') {
        finalized.current = true
        void api
          .getPlay(id)
          .then(({ play }) => onResolved(id, play))
          .catch(() => onError(id))
      }
    },
  })
  return null
}

// Slot-machine tick-up for the wave's winnings: eases 0 -> total on mount, then chases merged updates.
// Remounts per wave (parent keyed on wave.at), so every payoff counts up fresh.
function CountUp({ value, format }: { value: number; format: (v: number) => string }) {
  const [shown, setShown] = useState(0)
  const fromRef = useRef(0)
  useEffect(() => {
    const from = fromRef.current
    fromRef.current = value
    if (from === value) return
    const t0 = performance.now()
    let raf = 0
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 700)
      const e = 1 - Math.pow(1 - k, 3)
      setShown(from + (value - from) * e)
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <>{format(shown)}</>
}

// A single position in the strip, numbered to match its chart flag. The label is money, not the multiplier
// (four 2.2x chips read as noise; "$2.77" reads as a prize). Green-lit = price inside its zone (pays at the
// buzzer), red = outside right now. Verdict flashes ±pnl in place. A hairline underline depletes to its buzzer.
function PositionChip({ p, inZone, nowMs }: { p: Position; inZone: boolean; nowMs: number }) {
  const resolved = isResolved(p)
  const won = resolved && p.won
  const lost = resolved && !p.won
  const live = isLive(p) && p.status !== 'placing'
  const payout = num(p.maxPayout) || p.stake * p.multiplier
  const label =
    p.status === 'placing'
      ? '···'
      : resolved
        ? `${won ? '+' : '−'}$${usd(Math.abs(num(p.pnl)))}`
        : `$${usd(payout)}`
  const frac =
    live && p.expiry != null && p.openedAt != null && p.expiry > p.openedAt
      ? Math.max(0, Math.min(1, (p.expiry - nowMs) / (p.expiry - p.openedAt)))
      : null
  return (
    <span
      className={cnm(
        'tnum relative inline-flex items-center gap-1 overflow-hidden border px-1 py-[3px] font-mono text-[10px] font-bold uppercase tracking-[0.04em]',
        p.status === 'placing'
          ? 'animate-pulse border-dashed border-line-strong text-text-3'
          : won
            ? 'border-up bg-up/20 text-up'
            : lost
              ? 'border-down text-down opacity-70'
              : inZone
                ? 'border-up bg-up/20 text-up'
                : 'border-down/70 text-down',
      )}
    >
      <span className="text-[8px] leading-none opacity-60">{p.slot}</span>
      {label}
      {frac != null && (
        <>
          {/* full-width track + a bright depleting fill, so the countdown reads clearly at a glance */}
          <span className="absolute inset-x-0 bottom-0 h-[3px] bg-current opacity-20" />
          <span
            className="absolute bottom-0 left-0 h-[3px] bg-current opacity-90"
            style={{ width: `${frac * 100}%` }}
          />
        </>
      )}
    </span>
  )
}
