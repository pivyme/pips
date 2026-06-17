import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useConsoleControls } from '@/components/console/controls'
import { Chart, type ChartBox } from '@/components/game/Chart'
import { ScreenMessage } from '@/components/game/screen'
import { Stat } from '@/components/Stat'
import { haptic } from '@/lib/haptics'
import { api, streamPlay, type PlayDTO, type PlayStatus } from '@/lib/api'
import { placePlay, cashOut } from '@/lib/sui/predict'
import { toastError } from '@/lib/errors'
import { notifyUnlocks } from '@/lib/achievements'
import { useAuth } from '@/lib/auth'
import { cnm } from '@/utils/style'

// Tap: a live chart with a grid of price boxes ahead of "now". Tap a box to bet the price
// lands in that band, it lights up as it wins. Each tapped box is a real range mint; tapping
// an open box again cashes it out, and CASH OUT ALL closes the lot. Optimistic on tap, then
// reconciled against the chain. Logic-complete, rough visuals are fine here.
export const Route = createFileRoute('/_app/games/tap')({ component: TapScreen })

const MIN_STAKE = 1
const MAX_STAKE = 25
const MAX_BOXES = 6 // bound concurrent positions, this game is the heaviest on tx volume
const BOX_PCT = 0.0015 // each box spans 0.15% of spot, fixed per asset so bands are absolute levels
const GRID_REACH = 3 // candidate bands shown above and below the band holding spot
const LINGER_MS = 1100 // keep a settled box on screen briefly so its final tint reads
const FALLBACK_DURATIONS = [10, 30, 60]
const TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out', 'error'])

type BoxStatus = 'placing' | 'open' | 'settling'
interface Box {
  key: string // local id, stable across the optimistic -> confirmed transition
  idx: number // absolute band index, the band the user tapped
  lower: number // display USD band
  upper: number
  stake: number
  status: BoxStatus
  playId?: string
  pnl: number
  multiplier: number
}

const money = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const durationLabel = (s: number): string => (s >= 60 ? `${s / 60}m` : `${s}s`)

function TapScreen() {
  const { refresh } = useAuth()
  const qc = useQueryClient()

  const [tapBet, setTapBet] = useState(5)
  const [durIdx, setDurIdx] = useState(0)
  const [boxes, setBoxes] = useState<Box[]>([])
  const [spot, setSpot] = useState<number | null>(null)

  // Fixed band height per asset so candidate bands sit at absolute price levels, the line
  // crosses them instead of the grid chasing the price. Re-seeded only when the asset changes.
  const bandRef = useRef<{ asset: string; height: number } | null>(null)
  const boxesRef = useRef<Box[]>(boxes)
  const subs = useRef<Map<string, () => void>>(new Map())
  const removeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const finalized = useRef<Set<string>>(new Set())
  boxesRef.current = boxes

  const marketsQ = useQuery({ queryKey: ['markets'], queryFn: () => api.markets(), refetchInterval: 10_000 })
  const markets = marketsQ.data?.markets ?? []
  const liveAssets = markets.filter((m) => m.live).map((m) => m.asset)
  const asset = liveAssets[0]
  const noLiveMarket = !marketsQ.isLoading && !marketsQ.isError && liveAssets.length === 0
  const durations = markets[0]?.durations ?? FALLBACK_DURATIONS
  const duration = durations[Math.min(durIdx, durations.length - 1)] ?? FALLBACK_DURATIONS[0]

  // Idempotent per-asset seed. Prefer the live spot, fall back to the markets quote on first paint.
  const seedSpot = spot ?? parseFloat(markets.find((m) => m.asset === asset)?.spot ?? '0')
  if (asset && seedSpot > 0 && bandRef.current?.asset !== asset) {
    bandRef.current = { asset, height: seedSpot * BOX_PCT }
  }
  const bandHeight = bandRef.current?.asset === asset ? bandRef.current.height : 0

  const finalizeBox = useCallback(
    (key: string, play: PlayDTO, unlocked: string[] = []) => {
      if (finalized.current.has(key)) return
      finalized.current.add(key)
      const pnl = parseFloat(play.pnl ?? '0')
      const payout = parseFloat(play.payout ?? '0')
      setBoxes((bs) => bs.map((b) => (b.key === key ? { ...b, status: 'settling', pnl } : b)))
      const won = play.status === 'won' || (play.status === 'cashed_out' && pnl >= 0)
      haptic(won ? 'success' : 'error')
      if (play.status === 'won') toast.success(`Caught it. +$${money(payout)}`)
      else if (play.status === 'cashed_out') toast.success(`Cashed out +$${money(Math.max(pnl, 0))}`)
      else toast('Missed it.')
      notifyUnlocks(unlocked)
      void refresh()
      // Settle/cashout moved the record: freshen stats, achievements, and history.
      for (const key of ['stats', 'achievements', 'plays']) void qc.invalidateQueries({ queryKey: [key] })
      const t = setTimeout(() => {
        setBoxes((bs) => bs.filter((b) => b.key !== key))
        removeTimers.current.delete(key)
        finalized.current.delete(key)
      }, LINGER_MS)
      removeTimers.current.set(key, t)
    },
    [refresh, qc],
  )

  const doCashOut = useCallback(
    async (box: Box) => {
      if (!box.playId) return
      setBoxes((bs) => bs.map((b) => (b.key === box.key ? { ...b, status: 'settling' } : b)))
      try {
        const { play, unlocked } = await cashOut(box.playId)
        finalizeBox(box.key, play, unlocked)
      } catch (e) {
        // Expiry may have beaten the cash-out. Reconcile against the chain before complaining.
        try {
          const { play } = await api.getPlay(box.playId)
          if (TERMINAL.has(play.status)) {
            finalizeBox(box.key, play)
            return
          }
        } catch {
          // fall through to the error toast
        }
        setBoxes((bs) => bs.map((b) => (b.key === box.key ? { ...b, status: 'open' } : b)))
        toastError(e)
      }
    },
    [finalizeBox],
  )

  const openBox = useCallback(
    async (idx: number, lower: number, upper: number) => {
      const key = `box-${idx}-${Date.now()}`
      const stake = tapBet
      haptic('rigid')
      // Optimistic: light the box instantly, then reconcile with the mint result.
      setBoxes((bs) => [...bs, { key, idx, lower, upper, stake, status: 'placing', pnl: 0, multiplier: 0 }])
      try {
        const { play } = await placePlay('tap', { stake, asset, band: { lower, upper }, duration })
        setBoxes((bs) =>
          bs.map((b) =>
            b.key === key
              ? {
                  ...b,
                  playId: play.id,
                  status: 'open',
                  lower: play.market.lower ? parseFloat(play.market.lower) : b.lower,
                  upper: play.market.upper ? parseFloat(play.market.upper) : b.upper,
                  pnl: parseFloat(play.pnl),
                  multiplier: play.multiplier,
                }
              : b,
          ),
        )
        haptic('medium')
      } catch (e) {
        setBoxes((bs) => bs.filter((b) => b.key !== key))
        toastError(e)
      }
    },
    [tapBet, asset, duration],
  )

  // A tap on the chart resolves to a price (the canvas owns the mapping). Snap it to a band:
  // tapping a band you already hold cashes it out, otherwise open a new box there.
  const onTapPrice = useCallback(
    (price: number) => {
      const h = bandRef.current?.asset === asset ? bandRef.current.height : 0
      if (h <= 0 || !asset) return
      const idx = Math.floor(price / h)
      const here = boxes.find((b) => b.idx === idx)
      if (here?.status === 'open') {
        void doCashOut(here)
        return
      }
      if (here) return // placing or settling on this band, ignore the tap
      if (boxes.length >= MAX_BOXES) {
        haptic('warning')
        toast('Max boxes. Cash some out first.')
        return
      }
      void openBox(idx, idx * h, (idx + 1) * h)
    },
    [asset, boxes, doCashOut, openBox],
  )

  const cashOutAll = useCallback(() => {
    const open = boxesRef.current.filter((b) => b.status === 'open' && b.playId)
    if (open.length === 0) return
    haptic('rigid')
    for (const b of open) void doCashOut(b)
  }, [doCashOut])

  // One SSE subscription per open box. Diff the live set against what we already hold so a tick
  // (which mutates boxes) does not churn the subscriptions.
  const openKey = boxes
    .filter((b) => b.status === 'open' && b.playId)
    .map((b) => b.playId)
    .sort()
    .join(',')
  useEffect(() => {
    const open = boxesRef.current.filter((b) => b.status === 'open' && b.playId)
    const wanted = new Set(open.map((b) => b.playId as string))
    for (const b of open) {
      const id = b.playId as string
      if (subs.current.has(id)) continue
      const unsub = streamPlay(id, (tick) => {
        setBoxes((bs) => bs.map((x) => (x.playId === id ? { ...x, pnl: parseFloat(tick.pnl), multiplier: tick.multiplier } : x)))
        if (TERMINAL.has(tick.status)) {
          const box = boxesRef.current.find((x) => x.playId === id)
          if (box) void api.getPlay(id).then(({ play }) => finalizeBox(box.key, play)).catch(() => {})
        }
      })
      subs.current.set(id, unsub)
    }
    for (const [id, unsub] of subs.current) {
      if (!wanted.has(id)) {
        unsub()
        subs.current.delete(id)
      }
    }
  }, [openKey, finalizeBox])

  // Market rotated: drop everything tied to the old asset.
  useEffect(() => {
    for (const unsub of subs.current.values()) unsub()
    subs.current.clear()
    for (const t of removeTimers.current.values()) clearTimeout(t)
    removeTimers.current.clear()
    finalized.current.clear()
    setBoxes([])
    setSpot(null)
  }, [asset])

  useEffect(
    () => () => {
      for (const unsub of subs.current.values()) unsub()
      subs.current.clear()
      for (const t of removeTimers.current.values()) clearTimeout(t)
      removeTimers.current.clear()
    },
    [],
  )

  const cycleDuration = useCallback(() => {
    haptic('selection')
    setDurIdx((i) => (i + 1) % durations.length)
  }, [durations.length])

  const openCount = boxes.filter((b) => b.status === 'open').length
  useConsoleControls({
    knob: { label: 'TAP $', min: MIN_STAKE, max: MAX_STAKE, step: 1, value: tapBet, onChange: setTapBet, format: (v) => `$${v}`, disabled: !asset },
    action1: { label: durationLabel(duration), color: 'neutral', onPress: cycleDuration },
    action2: { label: 'CLEAR', color: 'down', onPress: cashOutAll, disabled: openCount === 0 },
    main: { label: 'CASH OUT ALL', color: 'up', onPress: cashOutAll, disabled: openCount === 0 },
  })

  // Candidate grid (faint) under the live (strong) boxes. Skip candidate bands already held.
  const activeIdx = new Set(boxes.map((b) => b.idx))
  const candidates: ChartBox[] = []
  if (bandHeight > 0 && spot != null) {
    const center = Math.floor(spot / bandHeight)
    for (let i = center - GRID_REACH; i <= center + GRID_REACH; i++) {
      if (activeIdx.has(i)) continue
      candidates.push({ lower: i * bandHeight, upper: (i + 1) * bandHeight, tint: 'neutral' })
    }
  }
  const activeBoxes: ChartBox[] = boxes.map((b) => ({
    lower: b.lower,
    upper: b.upper,
    tint: b.status === 'placing' ? 'neutral' : b.pnl >= 0 ? 'up' : 'down',
    strong: true,
  }))
  const overlayBoxes = [...candidates, ...activeBoxes]

  const totalPnl = boxes.reduce((s, b) => s + b.pnl, 0)
  const totalStake = boxes.filter((b) => b.status !== 'settling').reduce((s, b) => s + b.stake, 0)
  const showReadouts = boxes.length > 0

  return (
    <div className="relative flex h-full flex-col gap-3 p-4">
      <div className="flex items-baseline justify-between px-1 pt-1">
        <h1 className="text-xl font-extrabold tracking-tight">Tap</h1>
        <div className="tnum text-sm font-bold text-text-3">
          {openCount}/{MAX_BOXES} open
        </div>
      </div>

      <div className="screen relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-card">
        {marketsQ.isLoading ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="shimmer h-24 w-full rounded-2xl" />
          </div>
        ) : marketsQ.isError ? (
          <ScreenMessage title="Could not load markets" action="Retry" onAction={() => void marketsQ.refetch()} />
        ) : noLiveMarket ? (
          <ScreenMessage title="No live markets right now." action="Retry" onAction={() => void marketsQ.refetch()} />
        ) : (
          <>
            {asset ? (
              <Chart asset={asset} overlays={{ boxes: overlayBoxes }} onPrice={setSpot} onTap={onTapPrice} className="flex-1" />
            ) : (
              <div className="flex-1" />
            )}

            {showReadouts ? (
              <div className="flex items-end justify-between gap-3 px-4 pb-4">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-text-3">Live</div>
                  <div className={cnm('text-4xl font-extrabold leading-none', totalPnl >= 0 ? 'text-up' : 'text-down')}>
                    {totalPnl >= 0 ? '+' : '-'}$<Stat value={Math.abs(totalPnl)} />
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-text-3">At risk</div>
                  <div className="tnum text-lg font-bold text-text-2">
                    $<Stat value={totalStake} />
                  </div>
                </div>
              </div>
            ) : (
              <div className="px-4 pb-4 text-center text-sm text-text-3">Tap a box to bet it. Green means you're winning.</div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
