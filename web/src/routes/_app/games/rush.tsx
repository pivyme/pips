import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { Chart } from '@/components/game/Chart'
import { GameLeaderboardOverlay } from '@/components/game/GameLeaderboardOverlay'
import { InstructionOverlay } from '@/components/game/gamePanels'
import { GameScreen, ScreenMessage, SCREEN_STATES, Cell } from '@/components/game/screen'
import { LivePrice } from '@/components/game/LivePrice'
import { useConsoleControls } from '@/components/console/controls'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { useLiveMarkets } from '@/hooks/useLiveMarkets'
import { usePlayResolutionWatch, type LivePlaySnapshot } from '@/hooks/useGameRound'
import { haptic, hapticPattern } from '@/lib/haptics'
import { track as trackEvent, trackSettled } from '@/lib/track'
import { sound } from '@/lib/sound'
import { api, type PlayDTO, type PlayStatus, type RushOffer } from '@/lib/api'
import { placePlay } from '@/lib/sui/predict'
import { betLadder } from '@/lib/sui/config'
import { APPETITES, AUTO_MAX_TAKES, autoShouldTake } from '@/lib/rush'
import { errorCode, toastError } from '@/lib/errors'
import { useLabGate } from '@/lib/lab'
import { useTopUp } from '@/lib/chipGrant'
import { useAuth } from '@/lib/auth'
import { useActivePlay } from '@/lib/activePlay'
import { cnm } from '@/utils/style'
import { formatExactDecimal, formatStringToNumericDecimals } from '@/utils/format'

// RUSH: you are not choosing, you are accepting. The machine deals a band with a number on it, you have a
// few seconds, and passing is free. The band and its multiple are solved and quoted server-side and the take
// names the offer by id, so nothing about the bet is the client's to assert.
// Design: docs/games-ideation/CONCEPTS.md §11. ADMIN-only lab game, the server answers 404 for anyone else.
export const Route = createFileRoute('/_app/games/rush')({ component: RushScreen })

const STAKE_KEY = 'pips_stake_idx' // shared with the other games so the chip stays put across screens
const APPETITE_KEY = 'pips_rush_appetite'

const DEAL_POLL_MS = 700 // only fires while the table is empty; the server paces the real dealing
const TICK_MS = 150 // the timer ring drains on this, so it reads as motion rather than steps
const SETTLE_LOCK_MS = 4000 // too close to the buzzer for a mint to be worth taking chips for
const RESULT_MS = 5000 // how long a resolved take holds its slot before the rail frees up
const SPLASH_MS = 2200
const WATCHDOG_MS = 3000

type Status = PlayStatus | 'placing'
type Take = {
  key: string
  slot: number
  playId?: string
  status: Status
  stake: number
  multiplier: number
  band?: { lower: number; upper: number }
  expiry?: number
  openedAt?: number
  pnl?: string
  payout?: string
  maxPayout?: string
  lockPrice?: string
  won?: boolean
  doneAt?: number
}
type Dealt = RushOffer & { deadline: number } // deadline is local: server clocks and device clocks disagree
type Overlay = 'none' | 'howto' | 'board'

const isLive = (t: Take): boolean => t.status === 'placing' || t.status === 'pending' || t.status === 'open'
const isResolved = (t: Take): boolean => t.status === 'won' || t.status === 'lost' || t.status === 'cashed_out' || t.status === 'error'
const num = (v: string | undefined): number => (v ? parseFloat(v) || 0 : 0)
const usd = (n: number): string => n.toFixed(2)

function RushScreen() {
  const isLabUser = useLabGate()

  useEffect(() => {
    trackEvent('game.open', { game: 'rush' })
  }, [])

  const { refresh, user } = useAuth()
  const qc = useQueryClient()
  const { track } = useActivePlay()

  const [stakeIdx, setStakeIdx] = useLocalStorage(STAKE_KEY, 2)
  const [appetiteIdx, setAppetiteIdx] = useLocalStorage(APPETITE_KEY, 1)
  const [auto, setAuto] = useState(false)
  const [takes, setTakes] = useState<Take[]>([])
  const [offer, setOffer] = useState<Dealt | null>(null)
  const [spot, setSpot] = useState<number | null>(null)
  const [overlay, setOverlay] = useState<Overlay>('none')
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [splash, setSplash] = useState<{ pnl: number; payout: number; at: number } | null>(null)

  const livePriceRef = useRef(0)
  const keySeq = useRef(0)
  const resolvedIds = useRef<Set<string>>(new Set())
  const offerRef = useRef<Dealt | null>(null)
  const busyRef = useRef(false)
  const dealingRef = useRef(false)

  const { noLiveMarket, playsPaused, isLoading: marketsLoading, isError: marketsError } = useLiveMarkets()
  const statsQ = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() })
  const streak = statsQ.data?.stats.currentStreak ?? 0

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])

  const STAKE_LADDER = betLadder()
  const balance = parseFloat(user?.balance ?? '0') || 0
  const maxBetIdx = Math.max(0, STAKE_LADDER.reduce((acc, v, i) => (v <= balance ? i : acc), 0))
  const safeBetIdx = Math.min(stakeIdx, maxBetIdx)
  const stake = STAKE_LADDER[safeBetIdx]
  const cantAfford = balance < STAKE_LADDER[0]
  const appetite = APPETITES[Math.min(appetiteIdx, APPETITES.length - 1)]

  const asset = 'BTC'
  const live = useMemo(() => takes.filter(isLive), [takes])
  const expiry = live.find((t) => t.expiry != null)?.expiry ?? offer?.expiryMs ?? null
  const secsLeft = expiry != null ? Math.max(0, Math.ceil((expiry - nowMs) / 1000)) : null
  const remainingMs = expiry != null ? expiry - nowMs : null
  // The same clock that disarms a cash-out elsewhere: chips are never taken for a mint that cannot land.
  const armed = remainingMs == null || remainingMs > SETTLE_LOCK_MS
  const atMax = live.length >= AUTO_MAX_TAKES
  const onTable = offer != null && offer.deadline > nowMs
  const canTake = onTable && armed && !atMax && !busy && !cantAfford && !playsPaused && !noLiveMarket

  const spent = live.reduce((a, t) => a + t.stake, 0)
  const holding = spot == null ? [] : live.filter((t) => t.band && spot > t.band.lower && spot < t.band.upper)
  const holdingWin = holding.reduce((a, t) => a + num(t.maxPayout), 0)
  const toWin = live.reduce((a, t) => a + num(t.maxPayout), 0)

  useEffect(() => {
    offerRef.current = offer
  }, [offer])
  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  // A dealt band expires on its own countdown. Clearing it here is what makes the next beat deal a fresh one,
  // and it is never a penalty: passing is the rhythm.
  useEffect(() => {
    if (offer && offer.deadline <= nowMs) setOffer(null)
  }, [offer, nowMs])

  // The chip moved, so the deal it was quoted at is not this player's bet any more (the server drops it too).
  useEffect(() => {
    setOffer(null)
  }, [stake])

  // A greedier appetite bins a deal that no longer clears it; a lazier one keeps whatever is on the table.
  useEffect(() => {
    setOffer((o) => (o && o.multiplier < appetite ? null : o))
  }, [appetite])

  // Retire a resolved take once its verdict has been read, so the rail frees up and the dealing never stops.
  useEffect(() => {
    if (!takes.some((t) => t.doneAt != null && nowMs - t.doneAt > RESULT_MS)) return
    setTakes((prev) => prev.filter((t) => t.doneAt == null || nowMs - t.doneAt <= RESULT_MS))
  }, [takes, nowMs])

  // THE BEAT. Ask only while the table is empty; the server keeps one live offer per player and paces the
  // real quoting, so this loop cannot hammer the chain no matter how fast it polls.
  useEffect(() => {
    if (!isLabUser) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const beat = async () => {
      if (!alive) return
      const idle = !offerRef.current && !dealingRef.current && !busyRef.current
      if (idle && !cantAfford && !noLiveMarket && !playsPaused) {
        dealingRef.current = true
        try {
          const { offer: dealt, now } = await api.rushDeal(stake, appetite)
          if (alive && dealt) {
            // Offsets the server's own clock rather than trusting device time: a 3s window has no room for skew.
            setOffer({ ...dealt, deadline: Date.now() + Math.max(0, dealt.expiresAt - now) })
            haptic('low')
          }
        } catch {
          // A dead beat. The next one deals; a failed deal must never surface as an error to the player.
        } finally {
          dealingRef.current = false
        }
      }
      timer = setTimeout(() => void beat(), DEAL_POLL_MS)
    }
    timer = setTimeout(() => void beat(), 0)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [isLabUser, stake, appetite, cantAfford, noLiveMarket, playsPaused])

  const resolveTake = useCallback(
    (playId: string, final: PlayDTO) => {
      if (resolvedIds.current.has(playId)) return
      resolvedIds.current.add(playId)
      const pnl = num(final.pnl)
      const won = final.status === 'won' || (final.status === 'cashed_out' && pnl >= 0)
      setTakes((prev) =>
        prev.map((t) =>
          t.playId === playId
            ? {
                ...t,
                status: final.status,
                pnl: final.pnl,
                payout: final.payout ?? t.payout,
                maxPayout: final.maxPayout ?? t.maxPayout,
                multiplier: final.multiplier || t.multiplier,
                lockPrice: final.settlePrice ?? t.lockPrice,
                won,
                doneAt: Date.now(),
              }
            : t,
        ),
      )
      trackEvent('game.settled', { game: 'rush', result: final.status, pnl: final.pnl ?? '0' })
      // One splash per buzzer: takes sharing a market resolve within a beat of each other.
      setSplash((s) => {
        const fresh = s && Date.now() - s.at < SPLASH_MS ? s : { pnl: 0, payout: 0, at: Date.now() }
        return { pnl: fresh.pnl + pnl, payout: fresh.payout + num(final.payout), at: Date.now() }
      })
      hapticPattern(won ? 'win' : 'lose')
      sound(won ? 'win' : 'lose')
      void refresh()
      for (const key of ['stats', 'achievements', 'plays']) void qc.invalidateQueries({ queryKey: [key] })
    },
    [refresh, qc],
  )

  const handleSnapshot = useCallback((playId: string, s: LivePlaySnapshot) => {
    setTakes((prev) =>
      prev.map((t) =>
        t.playId === playId && !isResolved(t)
          ? {
              ...t,
              status: s.status === 'pending' || s.status === 'open' ? s.status : t.status,
              pnl: s.pnl,
              maxPayout: s.maxPayout ?? t.maxPayout,
              multiplier: s.multiplier || t.multiplier,
              lockPrice: s.lockPrice ?? t.lockPrice,
            }
          : t,
      ),
    )
  }, [])

  const handleTakeError = useCallback((playId: string) => {
    setTakes((prev) => prev.filter((t) => t.playId !== playId))
    setAuto(false) // a mint that died stops AUTO dead rather than retrying into the same wall
    toast.error('That take did not mint. Those chips are safe.', { id: 'rush-take-error' })
  }, [])

  // Take whatever is on the table. The body carries the offer id and nothing else: no band, no width, no price.
  const doTake = useCallback(async () => {
    const dealt = offerRef.current
    if (!dealt || busyRef.current) return
    // Both refs flip HERE, not in an effect: AUTO can re-enter within the same commit, and a stale ref would
    // take the same offer twice or fire a second mint under one press.
    offerRef.current = null
    busyRef.current = true
    setOffer(null) // the server consumed it on claim, so it leaves the table either way
    setBusy(true)
    haptic('rigid')
    trackEvent('game.play_tap', { game: 'rush', stake, tier: `${appetite}x` })
    const used = new Set(takes.filter((t) => !isResolved(t)).map((t) => t.slot))
    let slot = 1
    while (used.has(slot)) slot++
    const key = `t${keySeq.current++}`
    setTakes((prev) => [...prev, { key, slot, status: 'placing', stake, multiplier: dealt.multiplier }])
    const tapAt = Date.now()
    try {
      const { play: p } = await placePlay('rush', { stake, asset, offerId: dealt.id })
      track({ id: p.id, game: 'rush' })
      setTakes((prev) =>
        prev.map((t) =>
          t.key === key
            ? {
                ...t,
                playId: p.id,
                status: p.status,
                multiplier: p.multiplier || t.multiplier,
                maxPayout: p.maxPayout,
                expiry: p.market.expiry ?? undefined,
                openedAt: Date.now(),
                band:
                  p.market.lower != null && p.market.upper != null
                    ? { lower: parseFloat(p.market.lower), upper: parseFloat(p.market.upper) }
                    : { lower: parseFloat(dealt.lower), upper: parseFloat(dealt.upper) },
              }
            : t,
        ),
      )
      haptic('heavy')
      trackEvent('game.play_open', { game: 'rush', latencyms: Date.now() - tapAt })
    } catch (e) {
      // The take never minted, so it never existed. Drop the chip rather than leave a ghost on the rail.
      setTakes((prev) => prev.filter((t) => t.key !== key))
      setAuto(false)
      trackEvent('game.play_error', { game: 'rush', code: errorCode(e) })
      toastError(e)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [stake, appetite, takes, track])

  // AUTO turns the knob into the whole game. Every stop condition lives in one tested function (lib/rush.ts),
  // and a failed mint kills it above rather than retrying.
  useEffect(() => {
    if (!autoShouldTake({ auto, takes: live.length, hasOffer: onTable, busy, canAfford: !cantAfford, armed })) return
    void doTake()
  }, [auto, live.length, onTable, busy, cantAfford, armed, doTake])

  const topUp = useTopUp()
  const goTopUp = useCallback(() => void topUp(), [topUp])

  const toggleAuto = useCallback(() => {
    setAuto((a) => {
      trackEvent('game.auto', { game: 'rush', on: !a })
      return !a
    })
    haptic('rigid')
  }, [])

  const rotateInfo = useCallback(() => setOverlay((o) => (o === 'none' ? 'howto' : o === 'howto' ? 'board' : 'none')), [])
  const infoLabel = overlay === 'none' ? 'HOW TO' : overlay === 'howto' ? 'RANKS' : 'CLOSE'

  useConsoleControls({
    knob: {
      label: 'APPETITE',
      min: 0,
      max: APPETITES.length - 1,
      step: 1,
      // Never locked: this dial does not pick a bet, it sets what the machine is allowed to deal, so it stays
      // live all round and the whole stream thins and fattens under the thumb.
      value: Math.min(appetiteIdx, APPETITES.length - 1),
      onChange: (v: number) => {
        setAppetiteIdx(v)
        trackSettled('game.knob_change', { game: 'rush', tier: `${APPETITES[v]}x` })
      },
      format: (v) => `≥${APPETITES[Math.min(v, APPETITES.length - 1)]}x`,
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
    action2: { label: auto ? 'AUTO ON' : 'AUTO OFF', color: auto ? 'amber' : 'neutral', onPress: toggleAuto },
    main: cantAfford
      ? { label: 'TOP UP', color: 'amber', onPress: goTopUp }
      : busy
        ? { label: 'TAKING', color: 'amber', onPress: () => {}, loading: true }
        : canTake
          ? { label: 'TAKE', color: 'up', onPress: () => void doTake() }
          : { label: 'TAKE', color: 'neutral', onPress: () => {} },
  })

  if (!isLabUser) return null

  // The dealt band rides the chart the same way a taken one does, because it IS the bet: what is drawn is
  // what mints. Taken bands carry the slot number their chip does; the offer carries none, it is not a
  // position yet.
  const bands = [
    ...takes
      .filter((t) => t.band)
      .map((t) => ({
        lower: t.band!.lower,
        upper: t.band!.upper,
        state: (isResolved(t) ? (t.won ? 'won' : 'lost') : 'live') as 'live' | 'won' | 'lost',
        n: t.slot,
        t0: t.openedAt,
        t1: t.expiry,
      })),
    ...(onTable && offer
      ? [{ lower: parseFloat(offer.lower), upper: parseFloat(offer.upper), state: 'live' as const, t1: offer.expiryMs }]
      : []),
  ]
  const overlays = bands.length ? { bands } : undefined

  const ringFrac = onTable && offer ? Math.max(0, Math.min(1, (offer.deadline - nowMs) / 3500)) : 0
  const offerSecs = onTable && offer ? Math.max(0, Math.ceil((offer.deadline - nowMs) / 1000)) : 0
  const ordered = [...takes].sort((a, b) => a.slot - b.slot)
  const floorCost = `$${usd(stake * AUTO_MAX_TAKES)}`

  return (
    <GameScreen>
      {takes
        .filter((t) => t.playId && !isResolved(t))
        .map((t) => (
          <TakeWatch key={t.playId} playId={t.playId!} refresh={refresh} onSnapshot={handleSnapshot} onResolved={resolveTake} onError={handleTakeError} />
        ))}

      {marketsLoading ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="shimmer h-24 w-2/3" />
        </div>
      ) : marketsError ? (
        <ScreenMessage {...SCREEN_STATES.marketsError} />
      ) : playsPaused && live.length === 0 ? (
        <ScreenMessage {...SCREEN_STATES.playsPaused} />
      ) : noLiveMarket && live.length === 0 ? (
        <ScreenMessage {...SCREEN_STATES.noMarket} />
      ) : (
        <div className="relative flex h-full flex-col">
          {/* HEADER */}
          <div className="shrink-0 border-b border-line-strong bg-black pt-[calc(var(--screen-rim,24px)+12px)]">
            <div className="flex items-start justify-between gap-3 px-[var(--screen-rim,24px)] pb-4">
              <div className="min-w-0">
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-text-3">Rush · {asset}</div>
                <div className="tnum text-[34px] font-extrabold leading-none text-text">
                  <LivePrice price={spot} />
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                  {live.length > 0 && secsLeft != null ? 'Ends in' : 'Balance'}
                </div>
                <div className="tnum text-xl font-bold leading-none text-text-2">
                  {live.length > 0 && secsLeft != null ? `${secsLeft}s` : user?.balance != null ? `$${formatStringToNumericDecimals(user.balance, 2)}` : '—'}
                </div>
                {streak > 0 && (
                  <div className="mt-1 inline-flex items-center border border-brand-500/60 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-brand-500">
                    Streak {streak}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* THE RAIL: four slots, the cap made visible. Filled slots ride to their own buzzer. */}
          {takes.length > 0 && (
            <div className="shrink-0 border-b border-line-strong bg-black px-[var(--screen-rim,24px)] py-2">
              <div className="grid grid-cols-4 gap-1.5">
                {ordered.map((t) => (
                  <TakeChip key={t.key} t={t} spot={spot} nowMs={nowMs} />
                ))}
                {Array.from({ length: Math.max(0, AUTO_MAX_TAKES - ordered.length) }).map((_, i) => (
                  <GhostSlot key={`ghost-${i}`} />
                ))}
              </div>
            </div>
          )}

          {/* CHART: the dealt band and every taken one. */}
          <div className="relative min-h-0 flex-1">
            {/* ON THE TABLE: the deal, its multiple, and a ring draining to nothing. Empty reads as DEALING,
                never as a stall, because passing is free and must never look like a miss. */}
            <div className="pointer-events-none absolute right-[var(--screen-rim,24px)] top-3 z-10 text-right">
              <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                {onTable ? 'On the table' : 'Dealing'}
              </div>
              {onTable && offer ? (
                <div className="mt-0.5 flex items-center justify-end gap-2">
                  <TimerRing frac={ringFrac} secs={offerSecs} />
                  <span className="tnum text-[30px] font-extrabold leading-none text-brand-500">{offer.multiplier.toFixed(2)}x</span>
                  <span className="font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-text-3">est</span>
                </div>
              ) : (
                <div className="shimmer mt-1.5 ml-auto h-[6px] w-16" />
              )}
            </div>

            {splash != null && nowMs - splash.at < SPLASH_MS && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden">
                <span key={splash.at} className={cnm('wave-splash tnum font-black leading-none text-[clamp(44px,12vh,84px)]', splash.pnl >= 0 ? 'text-up' : 'text-down')}>
                  {splash.pnl >= 0 ? `+$${usd(splash.payout)}` : `−$${usd(Math.abs(splash.pnl))}`}
                </span>
              </div>
            )}

            <Chart asset={asset} overlays={overlays} livePriceRef={livePriceRef} onPrice={(p) => setSpot(p)} className="absolute inset-0" />
          </div>

          {/* FOOTER — left-only, clear of the knob and PLAY body. */}
          <div className="shrink-0 border-t border-line-strong bg-black px-[var(--screen-rim,24px)] pb-[var(--screen-rim,24px)] pt-3.5 min-h-[var(--screen-notch,21%)]">
            <div className="max-w-[60%]">
              {live.length > 0 ? (
                <>
                  <div className="flex items-center gap-2">
                    <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">If it ends now</div>
                    <span
                      className={cnm(
                        'inline-flex items-center border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.1em]',
                        holding.length > 0 ? 'border-up/60 text-up' : 'border-down/60 text-down',
                      )}
                    >
                      {holding.length} of {live.length} holding
                    </span>
                  </div>
                  <div className={cnm('tnum text-[40px] font-extrabold leading-none', holding.length > 0 ? 'text-up' : 'text-down')}>
                    {holding.length > 0 ? `+$${formatExactDecimal(String(holdingWin), { absolute: true })}` : '$0.00'}
                  </div>
                  <div className="mt-2.5 grid grid-cols-3 gap-x-3">
                    <Cell label="Taken" value={`${live.length} of ${AUTO_MAX_TAKES}`} />
                    <Cell label="Stack" value={`$${usd(spent)}`} />
                    <Cell label="All in" value={`$${usd(toWin)}`} />
                  </div>
                </>
              ) : (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Appetite</div>
                  <div className="flex items-baseline gap-2">
                    <span className="tnum text-[36px] font-extrabold leading-none text-brand-500">≥{appetite}x</span>
                    <span className="font-mono text-[13px] font-bold uppercase tracking-[0.08em] text-text-2">
                      {appetiteIdx === 0 ? 'constant' : appetiteIdx >= APPETITES.length - 2 ? 'rare' : 'steady'}
                    </span>
                  </div>
                  <div className="mt-2.5 grid grid-cols-3 gap-x-3">
                    <Cell label="Per take" value={`$${stake}`} />
                    <Cell label={`All ${AUTO_MAX_TAKES}`} value={floorCost} />
                    <Cell label="Auto" value={auto ? 'ON' : 'OFF'} />
                  </div>
                  {/* The true floor cost of a full rail, stated before the first chip is committed. */}
                  <div className="mt-2.5 font-mono text-[11px] font-semibold uppercase leading-snug tracking-[0.08em] text-text-2">
                    Every take costs ${stake} · <span className="text-text-3">a full rail of {AUTO_MAX_TAKES} costs {floorCost}</span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {overlay === 'howto' && (
        <InstructionOverlay
          compact
          lines={[
            ['DEAL', 'The machine offers a band with a multiple on it, every few seconds.'],
            ['TAKE', 'Mints whatever is on the table right now. Passing costs nothing.'],
            ['APPETITE', 'The knob sets the least the machine may offer. Greedy goes quiet.'],
            ['AUTO', 'Takes every deal that clears your appetite, up to four a round.'],
          ]}
        />
      )}
      {overlay === 'board' && <GameLeaderboardOverlay game="rush" title="Rush" />}
    </GameScreen>
  )
}

// The offer's countdown, drawn as a ring because it is the one number the player is racing.
function TimerRing({ frac, secs }: { frac: number; secs: number }) {
  const R = 9
  const C = 2 * Math.PI * R
  return (
    <span className="relative inline-flex h-[26px] w-[26px] items-center justify-center">
      <svg viewBox="0 0 26 26" className="absolute inset-0 -rotate-90">
        <circle cx="13" cy="13" r={R} fill="none" stroke="currentColor" strokeWidth="2" className="text-line-strong" />
        <circle
          cx="13"
          cy="13"
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - frac)}
          className={frac < 0.34 ? 'text-down' : 'text-brand-500'}
        />
      </svg>
      <span className="tnum relative text-[10px] font-bold leading-none text-text-2">{secs}</span>
    </span>
  )
}

// One slot on the rail: money while it rides, the verdict in place when it lands. Mirrors Range's board, on
// purpose, since a player who knows one knows the other.
function TakeChip({ t, spot, nowMs }: { t: Take; spot: number | null; nowMs: number }) {
  const resolved = isResolved(t)
  const inZone = t.band != null && spot != null && spot > t.band.lower && spot < t.band.upper
  const settling = isLive(t) && t.expiry != null && nowMs >= t.expiry
  const payout = num(t.maxPayout) || t.stake * t.multiplier
  const label =
    t.status === 'placing'
      ? '···'
      : resolved
        ? t.won
          ? `+$${usd(num(t.payout) || t.stake + num(t.pnl))}`
          : `−$${usd(Math.abs(num(t.pnl)))}`
        : `$${usd(payout)}`
  const frac =
    isLive(t) && !settling && t.expiry != null && t.openedAt != null && t.expiry > t.openedAt
      ? Math.max(0, Math.min(1, (t.expiry - nowMs) / (t.expiry - t.openedAt)))
      : null
  return (
    <span
      className={cnm(
        'tnum relative flex h-9 w-full items-center justify-center overflow-hidden border font-mono text-[12px] font-bold leading-none tracking-[0.02em]',
        t.status === 'placing'
          ? 'animate-pulse border-dashed border-line-strong text-text-3'
          : resolved
            ? t.won
              ? 'border-up bg-up/20 text-up'
              : 'border-down text-down opacity-70'
            : settling
              ? 'animate-pulse border-line-strong text-text-2'
              : inZone
                ? 'border-up bg-up/20 text-up'
                : 'border-down/70 text-down',
      )}
    >
      <span className="absolute left-1 top-0.5 text-[8px] font-bold leading-none opacity-50">{t.slot}</span>
      <span className="px-1">{label}</span>
      {frac != null && (
        <>
          <span className="absolute inset-x-0 bottom-0 h-[3px] bg-current opacity-20" />
          <span className="absolute bottom-0 left-0 h-[3px] bg-current opacity-90" style={{ width: `${frac * 100}%` }} />
        </>
      )}
    </span>
  )
}

function GhostSlot() {
  return (
    <span className="flex h-9 w-full items-center justify-center border border-dashed border-line">
      <span className="h-1 w-1 rounded-full bg-line-strong" />
    </span>
  )
}

// One SSE + watchdog per open take, the same hidden-watcher pattern the Range board and PRESS use.
function TakeWatch({
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
