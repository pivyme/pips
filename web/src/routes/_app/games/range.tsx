import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import NumberFlow from '@number-flow/react'
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
import { placePlay } from '@/lib/sui/predict'
import { betLadder, netStakeUsd } from '@/lib/sui/config'
import { toastError } from '@/lib/errors'
import { useTopUp } from '@/lib/chipGrant'
import { useAuth } from '@/lib/auth'
import { cnm } from '@/utils/style'
import { formatStringToNumericDecimals } from '@/utils/format'

// RANGE: instead of one round at a time, you STACK positions, each a real Range mint that rides to its own
// buzzer, and fire more without waiting. Results pop inline, never a full-screen result gate, so the loop
// never stalls. No cash-out: a stacked band just rides to its cutoff. Backend is unchanged (settle worker
// batches the open plays), so this is a pure client screen over placePlay/streamPlay.
export const Route = createFileRoute('/_app/games/range')({
  component: RangeScreen,
})

const STAKE_KEY = 'pips_stake_idx' // shared with Lucky + Moonshot so the chip stays put across screens
// The stacked positions + running session survive leaving the screen (Home and back), so a rider returns to
// exactly the board they left. Restored open plays re-attach their watcher and reconcile to chain truth, so this
// is persistence, never a fabricated state.
const POSITIONS_KEY = 'pips_range_positions'
// Payout-tier ladder: the knob picks a payout (bigger pays = tighter, probability-sized band).
// A fixed %-band knob can't hold in real mode. A short BTC round's achievable half-width is only ~0.02-0.04%, so any
// wider request clamps down on-chain and the aim preview ends up bigger than what actually mints. Tiers size by target
// win probability, so every step is distinct, achievable, and the preview equals the opened band. Estimate only, snaps on fetch.
const FALLBACK_TIERS: Array<TierView> = [
  { tier: 0, prob: 0.85, multiplier: 1.13, sigmaMult: 1.44, halfPct: 0.077 },
  { tier: 1, prob: 0.65, multiplier: 1.48, sigmaMult: 0.935, halfPct: 0.05 },
  { tier: 2, prob: 0.45, multiplier: 2.13, sigmaMult: 0.598, halfPct: 0.032 },
  { tier: 3, prob: 0.3, multiplier: 3.2, sigmaMult: 0.385, halfPct: 0.021 },
  { tier: 4, prob: 0.18, multiplier: 5.33, sigmaMult: 0.228, halfPct: 0.012 },
]
const DEFAULT_TIER_IDX = 2
const SECONDS_PER_YEAR = 365.25 * 24 * 3600
const FALLBACK_ASSETS = ['BTC', 'ETH', 'SUI', 'SOL', 'DEEP']
const TOKEN_LOGOS: Record<string, string> = {
  BTC: '/assets/images/coins/btc-logo.png',
  ETH: '/assets/images/coins/eth-logo.png',
  SUI: '/assets/images/coins/sui-logo.png',
}
// How many positions can ride at once. Capped at 4: keeps the per-user mint queue reliable (a 5th concurrent
// real mint too often timed out) and gives each rail chip a clean 25% of the full-width row.
const MAX_POSITIONS = 4
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
// Hard cap on how long a chip may sit at "···" before we fail it. A mint that can't land promptly must NOT
// linger and drop into a later round (the "stuck then places at the next cutoff" bug); fail it, chips are safe.
const PLACE_TIMEOUT_MS = 8000

class PlaceTimeout extends Error {}
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new PlaceTimeout()), ms)
    promise.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

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
  payout?: string // total collected once resolved (stake + profit), the recorded on-chain payout
  maxPayout?: string
  lockPrice?: string
  won?: boolean
  resolvedAt?: number
}
// `at` is the LAST folded-in resolution (drives the display windows + splash re-pop), `startedAt` is
// stable per wave (keys the panel so its pop/count-up runs once while merged totals keep chasing).
type Wave = { pnl: number; payout: number; wins: number; losses: number; at: number; startedAt: number }
type Overlay = 'none' | 'howto' | 'board'
// What the knob steps through: a server tier quote, or the cold-start fallback (no expiryMs).
type TierView = {
  tier: number
  prob: number
  multiplier: number
  sigmaMult: number
  halfPct: number
  expiryMs?: number
}

const isResolved = (p: Position): boolean =>
  p.status === 'won' || p.status === 'lost' || p.status === 'cashed_out'
const isLive = (p: Position): boolean =>
  p.status === 'placing' || p.status === 'pending' || p.status === 'open'

const usd = (n: number): string =>
  (Number.isFinite(n) ? n : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtMult = (m: number): string => `${m.toFixed(2).replace(/\.?0+$/, '')}×`
const num = (s?: string): number => (s ? parseFloat(s) || 0 : 0)
// Trailing number in a `pos-N` key, so the key counter can re-seed above restored chips without colliding.
const keyIndex = (k: string): number => {
  const n = parseInt(k.slice(k.lastIndexOf('-') + 1), 10)
  return Number.isFinite(n) ? n : -1
}

const setsEqual = (a: Set<string>, b: Set<string>): boolean => {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

// Digit-easing readouts so a knob tier change or mark drift eases the number instead of hard-swapping.
const MultFlow = ({ value }: { value: number }) => (
  <NumberFlow value={value} suffix="x" format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} />
)
const UsdFlow = ({ value }: { value: number }) => (
  <NumberFlow value={value} prefix="$" format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} />
)

function RangeScreen() {
  const { refresh, user } = useAuth()
  const qc = useQueryClient()

  const [tierIdx, setTierIdx] = useLocalStorage('pips_range_tier', DEFAULT_TIER_IDX) // knob index into the payout-tier ladder, persisted so it survives leaving and returning
  const [stakeIdx, setStakeIdx] = useLocalStorage(STAKE_KEY, 2)
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null)
  const [positions, setPositions] = useState<Position[]>([])
  const [spot, setSpot] = useState<number | null>(null)
  const [overlay, setOverlay] = useState<Overlay>('none')
  const [inZoneKeys, setInZoneKeys] = useState<Set<string>>(new Set())
  const [wave, setWave] = useState<Wave | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [notice, setNotice] = useState<{ text: string; id: number } | null>(null) // soft "can't place" nudge (max / round closing)
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
  const stripRef = useRef<HTMLDivElement>(null) // the positions rail, shaken on a rejected tap
  const noticeSeq = useRef(0)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  const canPlay = liveAssets.length > 0

  // Server payout-tier quotes: stable multiples + the live-band decay model, so the aim preview and the
  // "next pays" number reflect what actually mints. Kept live even while positions ride, since the aim is
  // for the NEXT play, not the open ones. FALLBACK_TIERS carries the knob until the first fetch.
  const quotesQ = useQuery({
    queryKey: ['rangeTierQuotes', asset],
    queryFn: () => api.rangeTierQuotes(asset),
    enabled: canPlay && !!asset,
    placeholderData: (prev) => prev,
    staleTime: 4_000,
    refetchInterval: 8_000,
    retry: false,
  })
  const tiers: Array<TierView> = quotesQ.data?.quotes.length ? quotesQ.data.quotes : FALLBACK_TIERS
  const model = quotesQ.data?.model ?? null
  const tierView = tiers[Math.min(tierIdx, tiers.length - 1)]
  // The tier's payout is time-independent (1x leverage, ~1/prob); the mint snaps it to the real on-chain multiple.
  const idleMult = tierView.multiplier
  // Live aim half-width: the tier's band decays with the round clock, so the ±% preview equals the band
  // that mints instead of a fixed request the chain would clamp. Falls back to the quote's static width pre-model.
  const roundEndsMs = model && tierView.expiryMs ? tierView.expiryMs - nowMs : null
  const aimHalfPct =
    model && roundEndsMs != null
      ? tierView.sigmaMult *
        model.annualVol *
        Math.sqrt(Math.max(roundEndsMs, model.minRoundMs) / 1000 / SECONDS_PER_YEAR) *
        100
      : tierView.halfPct

  // Inside minRoundMs a tap lands in a dying round: it shows a "···" chip, then the position pops already at its
  // cutoff and settles on the spot. So when the quote's round gets that close we roll to the next one, refetching so
  // the aim + expiry re-point, and a tap in the gap is rejected with a soft notice instead of that instant-settle.
  const quotesRefetch = quotesQ.refetch
  const nextRound = model != null && roundEndsMs != null && roundEndsMs < model.minRoundMs
  const boundaryRef = useRef(0)
  useEffect(() => {
    if (!nextRound || !tierView.expiryMs) return
    if (boundaryRef.current === tierView.expiryMs) return
    boundaryRef.current = tierView.expiryMs
    void quotesRefetch()
  }, [nextRound, tierView.expiryMs, quotesRefetch])

  // Derived board numbers.
  const inPlay = positions.filter(isLive)
  const openPos = positions.filter((p) => p.status === 'open' || p.status === 'pending')
  const n = inPlay.length
  const atMax = n >= MAX_POSITIONS
  const totalToWin = openPos.reduce((a, p) => a + num(p.maxPayout), 0)
  // Settlement-if-now: the in-zone bands pay full, the rest pay zero. The gamey hero the price chases.
  const collectNow = openPos.filter((p) => inZoneKeys.has(p.key)).reduce((a, p) => a + num(p.maxPayout), 0)
  const inZoneCount = openPos.filter((p) => inZoneKeys.has(p.key)).length
  const expiries = openPos.map((p) => p.expiry).filter((e): e is number => typeof e === 'number' && e > 0)
  const soonestExpiry = expiries.length ? Math.min(...expiries) : null
  const nextSecs = soonestExpiry != null ? Math.max(0, Math.ceil((soonestExpiry - nowMs) / 1000)) : null
  const settlingWave = soonestExpiry != null && soonestExpiry <= nowMs && openPos.length > 0

  // Restore the board left riding when the screen was last open (navigated Home and back). Runs once. Drops any
  // mid-mint chip with no playId (its placePlay promise died with the old mount, unrecoverable), and re-seeds the
  // key counter above the restored chips so a fresh PLAY can't collide. The PositionWatch list re-attaches an SSE +
  // watchdog to every restored open play, so open positions reconcile to chain truth instead of showing a stale mark.
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    let saved: Position[] = []
    try {
      const raw = window.localStorage.getItem(POSITIONS_KEY)
      if (raw) saved = JSON.parse(raw) as Position[]
    } catch {
      /* corrupt store: start clean */
    }
    const usable = saved.filter((p) => p.playId)
    if (!usable.length) return
    keySeq.current = usable.reduce((m, p) => Math.max(m, keyIndex(p.key)), -1) + 1
    setPositions(usable)
  }, [])

  // Persist the live set so it survives leaving the screen. Only fires when the array REFERENCE changes; the 250ms
  // sweep returns the same array while idle, so there's no per-tick localStorage churn.
  useEffect(() => {
    try {
      window.localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions))
    } catch {
      /* quota/private-mode: persistence is best-effort */
    }
  }, [positions])

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
      const nowT = Date.now()
      const next = new Set<string>()
      const tracked = new Set<string>()
      if (p > 0) {
        for (const pos of positionsRef.current) {
          if (!pos.band || !(pos.status === 'open' || pos.status === 'pending')) continue
          if (pos.expiry != null && nowT >= pos.expiry) {
            // Cutoff passed: the settle price is locked, so FREEZE the in/out verdict at its last live read (keeps the
            // footer counting a win instead of flashing "all out"), but drop it from `tracked` so no new cross fires.
            if (prevIn.has(pos.key)) next.add(pos.key)
          } else {
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
      // Board armed = every still-LIVE zone paying (frozen settling zones don't gate the sound).
      const allIn = tracked.size > 0 && [...tracked].every((k) => next.has(k))
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
                payout: final.payout ?? p.payout,
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
      // Fold this resolution into the current wave (or start one): one splash + one running total per
      // buzzer batch. The window rolls forward on each merge so staggered settlement stays one beat.
      const now = Date.now()
      const w =
        waveRef.current && now - waveRef.current.at < WAVE_MERGE_MS
          ? waveRef.current
          : { pnl: 0, payout: 0, wins: 0, losses: 0, at: now, startedAt: now }
      w.pnl += pnl
      w.payout += num(final.payout ?? '0') // total collected across the batch (losers add 0)
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
    toast.error('A play could not open. Your chips are safe.', { id: 'range-error' })
  }, [])

  // Soft "can't place" nudge: an error tick, a rail shake, and a self-clearing pill. Shared by the max and
  // round-closing guards, so a rejected tap always says why instead of dropping a bare "···" chip.
  const nudge = useCallback((text: string) => {
    haptic('error')
    noticeSeq.current += 1
    setNotice({ text, id: noticeSeq.current })
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 1700)
    const el = stripRef.current
    if (el) {
      el.classList.remove('rv2-shake')
      void el.offsetWidth // reflow so the shake restarts on a rapid repeat tap
      el.classList.add('rv2-shake')
    }
  }, [])
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current) }, [])

  const doPlay = useCallback(async () => {
    if (playsPaused) {
      toast.error('Plays paused while we top up. Back in a moment.', { id: 'range-paused' })
      return
    }
    if (!canPlay) {
      toast.error('No live market right now. Try again in a sec.', { id: 'range-no-market' })
      return
    }
    if (positionsRef.current.filter(isLive).length >= MAX_POSITIONS) {
      nudge(`${MAX_POSITIONS} positions at max`)
      return
    }
    if (nextRound) {
      nudge('Round closing, next one up')
      void quotesRefetch() // re-route the quote to the fresh round so the retry lands clean
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
      const { play } = await withTimeout(placePlay('range', { stake, asset, tier: tierView.tier }), PLACE_TIMEOUT_MS)
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
      if (e instanceof PlaceTimeout) {
        haptic('error')
        toast.error('That one took too long, chips are safe. Fire again.', { id: 'range-slow' })
      } else {
        toastError(e)
      }
    }
  }, [asset, stake, tierView.tier, idleMult, canPlay, playsPaused, cantAfford, nextRound, nudge, quotesRefetch, refresh])

  // TOP UP: hand the player a starter grant (popup + coin sound), falling back to the deposit drawer when the
  // grant is on cooldown or the treasury is dry, so a broke player is never a dead-end.
  const topUp = useTopUp()
  const goTopUp = useCallback(() => {
    haptic('rigid')
    void topUp()
  }, [topUp])
  const cycleAsset = useCallback(() => {
    if (lockedAsset) {
      haptic('error')
      toast('Asset locked while positions are open.', { id: 'range-lock' })
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
    action1: { label: infoLabel, color: 'neutral', onPress: rotateInfo },
    action2: {
      label: asset,
      color: 'neutral',
      onPress: cycleAsset,
      display: { mode: 'token', ticker: asset, logoSrc: TOKEN_LOGOS[asset] },
    },
    main: atMax
      ? { label: 'MAX', color: 'neutral', onPress: () => nudge(`${MAX_POSITIONS} positions at max`) }
      : cantAfford
        ? { label: 'TOP UP', color: 'amber', onPress: goTopUp }
        : { label: 'PLAY', color: 'amber', onPress: () => void doPlay() },
  })

  // Chart overlays: each open band as a TIME-ANCHORED lane (entry -> cutoff), so it scrolls left with the line
  // and the before/after of every play reads at a glance, PLUS a persistent aim bracket showing where the NEXT
  // play lands. A dim entry dot per live position marks exactly where it was placed. Aim hides at MAX (nothing
  // more to place), which doubles as the "you're full" cue. The chart derives the cutoff line(s) from t1.
  const positionBands = positions
    // Drop the band the instant the play resolves, so it clears together with the PnL reveal instead of
    // lingering on the chart for the result-hold window (the chip + wave splash carry the verdict now).
    .filter((p) => p.band && p.asset === asset && isLive(p) && p.status !== 'placing')
    .map((p) => {
      // Past the cutoff the settle price is locked and a 1x range is deterministic, so reveal the verdict from the
      // frozen in-zone read (same source as the footer) instead of a neutral wait; the band then clears at resolution.
      const cutoffPassed = p.expiry != null && nowMs >= p.expiry
      const state: 'live' | 'won' | 'lost' = cutoffPassed
        ? inZoneKeys.has(p.key)
          ? 'won'
          : 'lost'
        : 'live'
      return {
        lower: p.band!.lower,
        upper: p.band!.upper,
        state,
        n: p.slot, // the chart flag mirrors the chip's number
        t0: p.openedAt, // entry: the band's left edge, scrolling into the past
        t1: p.expiry, // cutoff: the band's right edge + the settlement line
      }
    })
  const entryMarkers = positions
    .filter((p) => isLive(p) && p.asset === asset && p.entrySpot != null && p.openedAt != null)
    .map((p) => ({ t: p.openedAt!, p: p.entrySpot! }))
  const showAim = canPlay && !atMax && spot != null
  const overlays =
    positionBands.length || showAim
      ? {
          bands: positionBands.length ? positionBands : undefined,
          markers: entryMarkers.length ? entryMarkers : undefined,
          aim: showAim ? { pct: aimHalfPct, tag: `NEXT ${fmtMult(idleMult)}` } : undefined,
        }
      : undefined

  // Strip order: by slot number, always. A chip never moves while it lives (verdicts flash in place),
  // so the eye can track "chip 3" from fire to result without re-scanning the row.
  const orderedPositions = [...positions].sort((a, b) => a.slot - b.slot)

  // Positions sharing a cutoff deplete their countdown bars in LOCKSTEP: a chip added late shows the same fill
  // as the ones already riding to that buzzer, not a fresh 100%. Anchor each cutoff group to its earliest open
  // (keyed by exact expiry, so a play in a different round keeps its own timeline).
  const cutoffStart = new Map<number, number>()
  for (const p of positions) {
    if (p.expiry != null && p.openedAt != null) {
      const cur = cutoffStart.get(p.expiry)
      if (cur == null || p.openedAt < cur) cutoffStart.set(p.expiry, p.openedAt)
    }
  }

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
                  Range · {asset}
                </div>
                <div className="tnum text-[34px] font-extrabold leading-none text-text">
                  <LivePrice price={spot} />
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                  {settlingWave ? 'Settling' : n > 0 ? 'Cutoff in' : 'Available'}
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

          {/* POSITIONS RAIL: a full-width 4-slot grid across the top of the L (never occluded, each cell ~25%). Filled
              slots ride to their cutoff, empty slots read as open room, so the "up to 4" cap is always legible. Slot-ordered so a
              chip stays put from fire to verdict, numbered to its chart flag. A rejected tap shakes the whole rail. */}
          {positions.length > 0 && (
            <div
              ref={stripRef}
              className="shrink-0 border-b border-line-strong bg-black px-[var(--screen-rim,24px)] py-2"
            >
              <div className="grid grid-cols-4 gap-1.5">
                {orderedPositions.map((p) => (
                  <PositionChip
                    key={p.key}
                    p={p}
                    inZone={inZoneKeys.has(p.key)}
                    nowMs={nowMs}
                    groupStart={p.expiry != null ? cutoffStart.get(p.expiry) : undefined}
                  />
                ))}
                {Array.from({ length: Math.max(0, MAX_POSITIONS - orderedPositions.length) }).map((_, i) => (
                  <GhostSlot key={`ghost-${i}`} />
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
                  {wave.pnl >= 0 ? `+$${usd(wave.payout)}` : `−$${usd(Math.abs(wave.pnl))}`}
                </span>
              </div>
            )}
            {/* Soft nudge pill: why a tap didn't land (max / round closing). Rides high over the chart, self-clears. */}
            {notice && (
              <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-4">
                <span
                  key={notice.id}
                  className="rv2-notice inline-flex items-center border border-line-strong bg-black/90 px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-text-2"
                >
                  {notice.text}
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
          <div className="shrink-0 border-t border-line-strong bg-black px-[var(--screen-rim,24px)] pb-[var(--screen-rim,24px)] pt-3 min-h-[var(--screen-notch,21%)]">
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
                  {/* Settle-if-now: rolls as zones light up. Green when a band is paying, dim at $0 (hold to the cutoff). */}
                  <div
                    className={cnm(
                      'tnum mt-0.5 origin-left text-[40px] font-extrabold leading-none',
                      collectNow > 0 ? 'text-up' : 'text-text-2',
                    )}
                  >
                    <UsdFlow value={collectNow} />
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-text-3">
                    If the cutoff hit now
                  </div>
                  <div className="mt-1.5 grid grid-cols-2 gap-x-3">
                    <Cell label="To win" value={<UsdFlow value={totalToWin} />} />
                    <Cell label="Cutoff" value={settlingWave ? '···' : `${nextSecs ?? 0}s`} />
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
                      <CountUp value={wave.payout} format={(v) => `+$${usd(v)}`} />
                    ) : (
                      `−$${usd(Math.abs(wave.pnl))}`
                    )}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-text-3">
                    {wave.pnl >= 0 ? 'Banked. Fire the next wave.' : 'Missed. Fire again.'}
                  </div>
                  <div className="mt-1.5 grid grid-cols-2 gap-x-3">
                    <Cell label="Next pays" value={<MultFlow value={idleMult} />} />
                    <Cell label="Amount" value={`$${stake}`} />
                  </div>
                </>
              ) : (
                <>
                  {/* Bet -> win rides the kicker line so the multiplier hero stays one row at any size. */}
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-text-3">Pays</div>
                    <div className="tnum font-mono text-[13px] font-semibold uppercase tracking-[0.08em] text-text-2">
                      ${stake} → <span className="text-up"><UsdFlow value={netStakeUsd(stake) * idleMult} /></span>
                    </div>
                  </div>
                  <div className="tnum mt-1 text-[40px] font-extrabold leading-none text-brand-500">
                    <MultFlow value={idleMult} />
                  </div>
                  <div className="mt-2 font-mono text-[11px] font-semibold uppercase leading-snug tracking-[0.08em] text-text-2">
                    Stack as many as you like. They all settle at the cutoff.
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {overlay === 'howto' && (
        <InstructionOverlay
          lines={[
            ['ZONES', 'PLAY drops a numbered zone that scrolls left to its cutoff. Stack up to 4.'],
            ['CUTOFF', 'The white line is settlement. Zones inside it when it hits win, outside lose.'],
            ['KNOB', 'Picks your payout. Bigger pays, tighter band.'],
            ['STACK', 'Fire as many as you like. They all ride to their own cutoff, no waiting.'],
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

// A single slot in the 4-wide rail, sized to fill its cell so four ride full-width without truncation. The label
// is money, not the multiplier (five 2.2x chips read as noise; "$2.77" reads as a prize). Green-lit = price inside
// its zone (pays at the buzzer), red = outside right now. Verdict flashes ±pnl in place. A hairline depletes to buzzer.
function PositionChip({
  p,
  inZone,
  nowMs,
  groupStart,
}: {
  p: Position
  inZone: boolean
  nowMs: number
  groupStart?: number // earliest open among positions sharing this cutoff, so same-buzzer bars deplete in lockstep
}) {
  const resolved = isResolved(p)
  const won = resolved && p.won
  const lost = resolved && !p.won
  const live = isLive(p) && p.status !== 'placing'
  // Cutoff passed, verdict pending: the settle price is locked, so the chip stops reacting to the line and pulses neutral.
  const settling = live && p.expiry != null && nowMs >= p.expiry
  const payout = num(p.maxPayout) || p.stake * p.multiplier
  const label =
    p.status === 'placing'
      ? '···'
      : resolved
        ? won
          ? `+$${usd(num(p.payout) || p.stake + num(p.pnl))}` // total collected (stake + profit), matches the live chip
          : `−$${usd(Math.abs(num(p.pnl)))}`
        : `$${usd(payout)}`
  // Deplete over the cutoff group's span (earliest open -> buzzer), not this chip's own open, so a late add
  // shows the same fill as its group-mates instead of restarting at 100%.
  const start = groupStart ?? p.openedAt
  const frac =
    live && !settling && p.expiry != null && start != null && p.expiry > start
      ? Math.max(0, Math.min(1, (p.expiry - nowMs) / (p.expiry - start)))
      : null
  return (
    <span
      className={cnm(
        'tnum relative flex h-9 w-full items-center justify-center overflow-hidden border font-mono text-[12px] font-bold leading-none tracking-[0.02em]',
        p.status === 'placing'
          ? 'animate-pulse border-dashed border-line-strong text-text-3'
          : won
            ? 'border-up bg-up/20 text-up'
            : lost
              ? 'border-down text-down opacity-70'
              : settling
                ? inZone
                  ? 'animate-pulse border-up bg-up/20 text-up' // cutoff passed, frozen winning: pulse green
                  : 'animate-pulse border-down bg-down/10 text-down' // frozen losing: pulse red
                : inZone
                  ? 'border-up bg-up/20 text-up'
                  : 'border-down/70 text-down',
      )}
    >
      <span className="absolute left-1 top-0.5 text-[8px] font-bold leading-none opacity-50">{p.slot}</span>
      <span className="px-1">{label}</span>
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

// An empty slot in the 4-wide rail: dim and inert, so the "up to 4" cap always reads even with room to spare.
function GhostSlot() {
  return (
    <span className="flex h-9 w-full items-center justify-center border border-dashed border-line">
      <span className="h-1 w-1 rounded-full bg-line-strong" />
    </span>
  )
}
