import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { Chart } from '@/components/game/Chart'
import { GameLeaderboardOverlay } from '@/components/game/GameLeaderboardOverlay'
import { FooterStatusPanel, InstructionOverlay, ResultOverlay } from '@/components/game/gamePanels'
import { GameScreen, ScreenMessage, SCREEN_STATES, Cell } from '@/components/game/screen'
import { LivePrice } from '@/components/game/LivePrice'
import { useConsoleControls } from '@/components/console/controls'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { useLiveMarkets } from '@/hooks/useLiveMarkets'
import { usePlayResolutionWatch, type LivePlaySnapshot } from '@/hooks/useGameRound'
import { haptic, hapticPattern } from '@/lib/haptics'
import { track as trackEvent, trackSettled } from '@/lib/track'
import { sound } from '@/lib/sound'
import { api, type PlayDTO, type PlayStatus } from '@/lib/api'
import { cashOut, placePlay } from '@/lib/sui/predict'
import { betLadder } from '@/lib/sui/config'
import { errorCode, toastError } from '@/lib/errors'
import { useLabGate } from '@/lib/lab'
import { useTopUp } from '@/lib/chipGrant'
import { useAuth } from '@/lib/auth'
import { useActivePlay } from '@/lib/activePlay'
import { cnm } from '@/utils/style'
import { formatExactDecimal, formatStringToNumericDecimals } from '@/utils/format'

// PRESS: you open wide and safe, then the machine dares you to tighten. Every press is one more mint_range on
// the SAME expiry, nested strictly inside the box before it, so at the buzzer every box holding the price pays
// and the innermost pays all of them at once. The greed is entirely self-inflicted, which is the whole game.
// Design: docs/games-ideation/CONCEPTS.md §4. ADMIN-only lab game, the server answers 404 for anyone else.
export const Route = createFileRoute('/_app/games/press')({ component: PressScreen })

const STAKE_KEY = 'pips_stake_idx' // shared with the other games so the chip stays put across screens
const OPEN_KEY = 'pips_press_open'

// The opening widths, by target win probability. Mirrors PRESS_OPEN_PROBS in backend/src/services/games-real.ts;
// the server owns the real ladder, this is only what the knob reads out before the mint snaps it.
const OPEN_PROBS = [0.72, 0.62, 0.52, 0.42]
const OPEN_LABELS = ['WIDEST', 'WIDE', 'MID', 'TIGHT']
const PRESS_MAX = 4
const PRESS_TIGHTEN = 0.5
const QUOTE_HAIRCUT = 0.04 // matches the server's REAL_RANGE_QUOTE_HAIRCUT so the estimate agrees before the snap

const RESULT_MS = 6500
const SETTLE_LOCK_MS = 5000 // the settling freeze: PRESS and FOLD both disarm here, chips are never taken for a mint that cannot land
const WATCHDOG_MS = 3000

type Status = PlayStatus | 'placing'
type Box = {
  key: string
  step: number // 0 is the opening box, then one per press
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
}
type Overlay = 'none' | 'howto' | 'board'

const isLive = (b: Box): boolean => b.status === 'placing' || b.status === 'pending' || b.status === 'open'
const isResolved = (b: Box): boolean => b.status === 'won' || b.status === 'lost' || b.status === 'cashed_out' || b.status === 'error'
const num = (v: string | undefined): number => (v ? parseFloat(v) || 0 : 0)
const fmtPrice = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 0 })

function PressScreen() {
  const isLabUser = useLabGate()

  useEffect(() => {
    trackEvent('game.open', { game: 'press' })
  }, [])

  const { refresh, user } = useAuth()
  const qc = useQueryClient()
  const { track } = useActivePlay()

  const [stakeIdx, setStakeIdx] = useLocalStorage(STAKE_KEY, 2)
  const [openIdx, setOpenIdx] = useLocalStorage(OPEN_KEY, 1)
  const [boxes, setBoxes] = useState<Box[]>([])
  const [spot, setSpot] = useState<number | null>(null)
  const [overlay, setOverlay] = useState<Overlay>('none')
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [busy, setBusy] = useState<'none' | 'press' | 'fold'>('none')
  const [wave, setWave] = useState<{ pnl: number; payout: number; at: number } | null>(null)

  const livePriceRef = useRef(0)
  const keySeq = useRef(0)
  const resolvedIds = useRef<Set<string>>(new Set())
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inBoxRef = useRef<boolean | null>(null)

  const { noLiveMarket, playsPaused, isLoading: marketsLoading, isError: marketsError } = useLiveMarkets()
  const statsQ = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() })
  const streak = statsQ.data?.stats.currentStreak ?? 0

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 250)
    return () => clearInterval(id)
  }, [])

  const STAKE_LADDER = betLadder()
  const balance = parseFloat(user?.balance ?? '0') || 0
  const maxBetIdx = Math.max(0, STAKE_LADDER.reduce((acc, v, i) => (v <= balance ? i : acc), 0))
  const safeBetIdx = Math.min(stakeIdx, maxBetIdx)
  const stake = STAKE_LADDER[safeBetIdx]
  const cantAfford = balance < STAKE_LADDER[0]

  const asset = 'BTC'
  const live = useMemo(() => boxes.filter(isLive), [boxes])
  const inPlay = live.length > 0
  // The innermost box is the tightest one riding, which is both what the next press nests inside and the one
  // the price has to stay inside for PRESS to stay armed.
  const inner = useMemo(
    () => live.filter((b) => b.band).sort((a, b) => a.band!.upper - a.band!.lower - (b.band!.upper - b.band!.lower))[0],
    [live],
  )
  const expiry = live.find((b) => b.expiry != null)?.expiry ?? null
  const secsLeft = expiry != null ? Math.max(0, Math.ceil((expiry - nowMs) / 1000)) : null
  const remainingMs = expiry != null ? expiry - nowMs : null
  const settling = inPlay && remainingMs != null && remainingMs <= 0
  // PRESS and FOLD disarm on the SAME clock. A mint submitted into the settling freeze may not land, and chips
  // must never be taken for a press that did not mint.
  const armed = inPlay && remainingMs != null && remainingMs > SETTLE_LOCK_MS && busy === 'none'
  const sealing = inPlay && remainingMs != null && remainingMs > 0 && remainingMs <= SETTLE_LOCK_MS

  const depth = live.length
  const atMax = depth >= PRESS_MAX
  const inBox = inner?.band && spot != null ? spot > inner.band.lower && spot < inner.band.upper : null
  const canPress = armed && !atMax && inBox === true && !cantAfford

  // What the round has cost, and what it pays if the buzzer lands in the innermost box. A display aggregation
  // across nested positions, never a chain read: every box holding the price pays its own multiple.
  const spent = live.reduce((a, b) => a + b.stake, 0)
  const toWin = live.reduce((a, b) => a + num(b.maxPayout), 0)
  // Live: only the boxes the price is actually inside right now.
  const holding = spot == null ? [] : live.filter((b) => b.band && spot > b.band.lower && spot < b.band.upper)
  const holdingWin = holding.reduce((a, b) => a + num(b.maxPayout), 0)

  // The next press, estimated. Anchored on the innermost box's REAL minted multiple wherever one exists,
  // because the analytic model disagrees with the chain's surface by enough to matter (a box modelled at
  // 1.61x really minted at 1.15x). Probability halves per press, so the multiple roughly doubles. Tagged
  // `est` either way, and snapped from OrderMinted on mint (L-012).
  const anchorMult = inner?.multiplier ?? 0
  const nextMultEst =
    anchorMult > 0
      ? anchorMult / PRESS_TIGHTEN
      : Math.max(1.01, (1 / Math.max(0.03, OPEN_PROBS[openIdx] * Math.pow(PRESS_TIGHTEN, depth))) * (1 - QUOTE_HAIRCUT))

  const clearResetTimer = () => {
    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = null
  }
  useEffect(() => () => clearResetTimer(), [])

  const resolveBox = useCallback(
    (playId: string, final: PlayDTO) => {
      if (resolvedIds.current.has(playId)) return
      resolvedIds.current.add(playId)
      const pnl = num(final.pnl)
      const won = final.status === 'won' || (final.status === 'cashed_out' && pnl >= 0)
      setBoxes((prev) =>
        prev.map((b) =>
          b.playId === playId
            ? {
                ...b,
                status: final.status,
                pnl: final.pnl,
                payout: final.payout ?? b.payout,
                maxPayout: final.maxPayout ?? b.maxPayout,
                multiplier: final.multiplier || b.multiplier,
                lockPrice: final.settlePrice ?? b.lockPrice,
                band:
                  final.market.lower != null && final.market.upper != null
                    ? { lower: parseFloat(final.market.lower), upper: parseFloat(final.market.upper) }
                    : b.band,
                won,
              }
            : b,
        ),
      )
      trackEvent('game.settled', { game: 'press', result: final.status, pnl: final.pnl ?? '0' })
      // One splash per buzzer, not one per box: the whole stack resolves within a beat of itself.
      setWave((w) => {
        const fresh = w && Date.now() - w.at < 2500 ? w : { pnl: 0, payout: 0, at: Date.now() }
        return { pnl: fresh.pnl + pnl, payout: fresh.payout + num(final.payout), at: Date.now() }
      })
      void refresh()
      for (const key of ['stats', 'achievements', 'plays']) void qc.invalidateQueries({ queryKey: [key] })
      clearResetTimer()
      resetTimer.current = setTimeout(() => {
        setBoxes([])
        setWave(null)
      }, RESULT_MS)
    },
    [refresh, qc],
  )

  const handleSnapshot = useCallback((playId: string, s: LivePlaySnapshot) => {
    setBoxes((prev) =>
      prev.map((b) =>
        b.playId === playId && !isResolved(b)
          ? {
              ...b,
              status: s.status === 'pending' || s.status === 'open' ? s.status : b.status,
              pnl: s.pnl,
              maxPayout: s.maxPayout ?? b.maxPayout,
              multiplier: s.multiplier || b.multiplier,
              lockPrice: s.lockPrice ?? b.lockPrice,
            }
          : b,
      ),
    )
  }, [])

  const handleBoxError = useCallback((playId: string) => {
    setBoxes((prev) => prev.map((b) => (b.playId === playId ? { ...b, status: 'error' } : b)))
    toast.error('That box did not mint. Those chips are safe.', { id: 'press-box-error' })
  }, [])

  // One mint: the opening box at step 0, or a tighter one nested inside. The server reads the depth and the
  // parent box off the player's own open positions, so this sends only the opening width.
  const mintBox = useCallback(
    async (step: number) => {
      const key = `b${keySeq.current++}`
      setBoxes((prev) => [...prev, { key, step, status: 'placing', stake, multiplier: 0 }])
      try {
        const { play: p } = await placePlay('press', { stake, asset, open: openIdx })
        track({ id: p.id, game: 'press' })
        setBoxes((prev) =>
          prev.map((b) =>
            b.key === key
              ? {
                  ...b,
                  playId: p.id,
                  status: p.status,
                  multiplier: p.multiplier,
                  maxPayout: p.maxPayout,
                  expiry: p.market.expiry ?? undefined,
                  openedAt: Date.now(),
                  band:
                    p.market.lower != null && p.market.upper != null
                      ? { lower: parseFloat(p.market.lower), upper: parseFloat(p.market.upper) }
                      : undefined,
                }
              : b,
          ),
        )
        haptic('heavy')
        return true
      } catch (e) {
        // The box never minted, so it never existed. Drop it rather than leave a ghost in the stack.
        setBoxes((prev) => prev.filter((b) => b.key !== key))
        trackEvent('game.play_error', { game: 'press', code: errorCode(e) })
        toastError(e)
        return false
      }
    },
    [stake, openIdx, track],
  )

  const doPlay = useCallback(async () => {
    if (busy !== 'none' || inPlay) return
    if (playsPaused) {
      trackEvent('friction.sponsor_paused', { game: 'press' })
      toast.error('Plays paused while we top up. Back in a moment.', { id: 'paused' })
      return
    }
    if (noLiveMarket) {
      toast.error('No game running right now. Try again in a sec.', { id: 'no-market' })
      return
    }
    clearResetTimer()
    resolvedIds.current = new Set()
    setWave(null)
    setBoxes([])
    setBusy('press')
    haptic('rigid')
    trackEvent('game.play_tap', { game: 'press', stake, tier: OPEN_LABELS[openIdx] })
    const tapAt = Date.now()
    if (await mintBox(0)) trackEvent('game.play_open', { game: 'press', latencyms: Date.now() - tapAt })
    setBusy('none')
  }, [busy, inPlay, playsPaused, noLiveMarket, stake, openIdx, mintBox])

  const doPress = useCallback(async () => {
    if (!canPress) return
    setBusy('press')
    haptic('rigid')
    trackEvent('game.press', { game: 'press', step: depth, stake })
    await mintBox(depth)
    setBusy('none')
  }, [canPress, depth, stake, mintBox])

  // FOLD: cash every nested box at its live bid and end the round early. The other half of the game.
  const doFold = useCallback(async () => {
    if (!armed || !inPlay) return
    const open = boxes.filter((b) => b.playId && b.status === 'open')
    if (open.length === 0) return
    setBusy('fold')
    trackEvent('game.fold', { game: 'press', step: open.length, pnl: String(holdingWin) })
    const settled = await Promise.allSettled(open.map((b) => cashOut(b.playId!)))
    for (const r of settled) {
      if (r.status === 'fulfilled') resolveBox(r.value.play.id, r.value.play)
    }
    const failed = settled.filter((r) => r.status === 'rejected')
    // A box that would not close is still riding; say so rather than leave the screen implying it folded.
    if (failed.length > 0) toast.error(`${failed.length} box could not fold and is still riding.`, { id: 'press-fold' })
    else {
      hapticPattern('cashOut')
      sound('win')
    }
    setBusy('none')
  }, [armed, inPlay, boxes, holdingWin, resolveBox])

  const topUp = useTopUp()
  const goTopUp = useCallback(() => void topUp(), [topUp])

  // A light tick each time the line crosses into or out of the innermost box: that live gain and loss of a
  // number you already earned is the tension, and it should be felt, not just seen.
  useEffect(() => {
    if (inBox == null || !inPlay) {
      inBoxRef.current = null
      return
    }
    if (inBoxRef.current != null && inBoxRef.current !== inBox) haptic('low')
    inBoxRef.current = inBox
  }, [inBox, inPlay])

  const anyResolved = boxes.some(isResolved)
  const roundDone = boxes.length > 0 && !inPlay && anyResolved
  const dismiss = useCallback(() => {
    clearResetTimer()
    setBoxes([])
    setWave(null)
  }, [])

  const rotateInfo = useCallback(() => setOverlay((o) => (o === 'none' ? 'howto' : o === 'howto' ? 'board' : 'none')), [])
  const infoLabel = overlay === 'none' ? 'HOW TO' : overlay === 'howto' ? 'RANKS' : 'CLOSE'

  useConsoleControls({
    knob: {
      label: 'OPEN',
      min: 0,
      max: OPEN_PROBS.length - 1,
      step: 1,
      // Locked for the round: the opening width sized boxes that are already on chain, so moving it mid-round
      // would be describing a bet nobody placed.
      value: openIdx,
      onChange: (v: number) => {
        if (inPlay) return
        setOpenIdx(v)
        trackSettled('game.knob_change', { game: 'press', tier: OPEN_LABELS[v] })
      },
      format: (v) => (inPlay ? 'LOCKED' : OPEN_LABELS[v]),
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
    // FOLD sits opposite PRESS and means the opposite thing, so it is red and dead unless it can actually fire.
    action2: armed && inPlay ? { label: 'FOLD', color: 'down', onPress: () => void doFold() } : { label: 'FOLD', color: 'neutral', onPress: () => {} },
    main: roundDone
      ? { label: 'CONTINUE', color: 'amber', onPress: dismiss }
      : settling
        ? { label: 'SETTLING', color: 'amber', onPress: () => {}, loading: true }
        : sealing
          ? { label: 'FINAL', color: 'amber', onPress: () => {}, loading: true }
          : busy === 'fold'
            ? { label: 'FOLDING', color: 'down', onPress: () => {}, loading: true }
            : busy === 'press'
              ? { label: inPlay ? 'PRESSING' : 'OPENING', color: 'amber', onPress: () => {}, loading: true }
              : inPlay
                ? atMax
                  ? { label: 'ALL IN', color: 'neutral', onPress: () => {} }
                  : canPress
                    ? { label: 'PRESS', color: 'up', onPress: () => void doPress() }
                    : { label: 'PRESS', color: 'neutral', onPress: () => {} }
                : cantAfford
                  ? { label: 'TOP UP', color: 'amber', onPress: goTopUp }
                  : { label: 'PLAY', color: 'amber', onPress: () => void doPlay() },
  })

  if (!isLabUser) return null

  // Every box as a time-anchored lane, so the nesting is drawn box-in-box AND the moment of each press is
  // visible in the shape. The innermost lane is the one the eye should land on.
  const bands = boxes
    .filter((b) => b.band)
    .map((b) => ({
      lower: b.band!.lower,
      upper: b.band!.upper,
      state: (isResolved(b) ? (b.won ? 'won' : 'lost') : 'live') as 'live' | 'won' | 'lost',
      n: b.step + 1,
      t0: b.openedAt,
      t1: b.expiry,
    }))
  const settlePx = boxes.find((b) => b.lockPrice)?.lockPrice
  const overlays = bands.length ? { bands, settle: roundDone && settlePx ? parseFloat(settlePx) : undefined } : undefined

  const firstRun = !statsQ.isLoading && (statsQ.data?.stats.gamesPlayed ?? 0) === 0
  const floorCost = `$${(stake * PRESS_MAX).toFixed(2)}`
  const resultBox = boxes.find((b) => isResolved(b))

  return (
    <GameScreen>
      {boxes
        .filter((b) => b.playId && !isResolved(b))
        .map((b) => (
          <BoxWatch key={b.playId} playId={b.playId!} refresh={refresh} onSnapshot={handleSnapshot} onResolved={resolveBox} onError={handleBoxError} />
        ))}

      {marketsLoading ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="shimmer h-24 w-2/3" />
        </div>
      ) : marketsError ? (
        <ScreenMessage {...SCREEN_STATES.marketsError} />
      ) : playsPaused && !inPlay ? (
        <ScreenMessage {...SCREEN_STATES.playsPaused} />
      ) : noLiveMarket && !inPlay ? (
        <ScreenMessage {...SCREEN_STATES.noMarket} />
      ) : (
        <div className="relative flex h-full flex-col">
          {/* HEADER */}
          <div className="shrink-0 border-b border-line-strong bg-black pt-[calc(var(--screen-rim,24px)+12px)]">
            <div className="flex items-start justify-between gap-3 px-[var(--screen-rim,24px)] pb-4">
              <div className="min-w-0">
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-text-3">Press · {asset}</div>
                <div className="tnum text-[34px] font-extrabold leading-none text-text">
                  <LivePrice price={spot} />
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                  {sealing || settling ? 'Final' : inPlay && secsLeft != null ? 'Ends in' : 'Available'}
                </div>
                <div className="tnum text-xl font-bold leading-none text-text-2">
                  {inPlay && secsLeft != null ? `${secsLeft}s` : user?.balance != null ? `$${formatStringToNumericDecimals(user.balance, 2)}` : '—'}
                </div>
                {streak > 0 && (
                  <div className="mt-1 inline-flex items-center border border-brand-500/60 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-brand-500">
                    Streak {streak}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* CHART — the nested boxes. */}
          <div className="relative min-h-0 flex-1">
            {/* The stack, one rung per box, tightest last. This is the teach: three rungs lit means three pay. */}
            {bands.length > 0 && (
              <div className="pointer-events-none absolute right-[var(--screen-rim,24px)] top-3 z-10 flex flex-col items-end gap-1">
                {boxes
                  .filter((b) => b.band)
                  .map((b) => {
                    const holdingThis = spot != null && spot > b.band!.lower && spot < b.band!.upper
                    return (
                      <div
                        key={b.key}
                        className={cnm(
                          'flex items-center gap-2 border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em]',
                          isResolved(b)
                            ? b.won
                              ? 'border-up/60 text-up'
                              : 'border-down/60 text-down'
                            : holdingThis
                              ? 'border-up/60 text-up'
                              : 'border-down/60 text-down',
                        )}
                      >
                        <span className="tabular-nums">{b.step + 1}</span>
                        <span className="tnum">{b.multiplier > 0 ? `${b.multiplier.toFixed(2)}x` : '—'}</span>
                      </div>
                    )
                  })}
              </div>
            )}
            <Chart asset={asset} overlays={overlays} livePriceRef={livePriceRef} onPrice={(p) => setSpot(p)} frozen={settling} className="absolute inset-0" />
          </div>

          {/* FOOTER — left-only, clear of the knob and PLAY body. */}
          <div className="shrink-0 border-t border-line-strong bg-black px-[var(--screen-rim,24px)] pb-[var(--screen-rim,24px)] pt-3.5 min-h-[var(--screen-notch,21%)]">
            <div className="max-w-[60%]">
              {busy === 'press' && !inPlay ? (
                <FooterStatusPanel kicker="Opening" head="OPENING" recap={`${asset} · ${OPEN_LABELS[openIdx]}`} sweep />
              ) : busy === 'press' ? (
                <FooterStatusPanel kicker={`Press ${depth + 1} of ${PRESS_MAX}`} head="PRESSING" recap={`${asset} · tighter`} sweep />
              ) : busy === 'fold' ? (
                <FooterStatusPanel kicker="Closing every box" head="FOLDING" tone="up" recap={`${holding.length} of ${depth} holding`} sweep />
              ) : settling ? (
                <FooterStatusPanel kicker="Settling" head="SETTLING" recap={`${depth} ${depth === 1 ? 'box' : 'boxes'}`} progress={80} />
              ) : sealing ? (
                <FooterStatusPanel kicker={`Locked · settles in ${secsLeft ?? 0}s`} head="FINAL SECONDS" recap={`${holding.length} of ${depth} holding`} progress={90} />
              ) : roundDone && wave ? (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Round</div>
                  <div className={cnm('tnum text-[40px] font-extrabold leading-none', wave.pnl >= 0 ? 'text-up' : 'text-down')}>
                    {wave.pnl >= 0 ? '+' : '-'}${formatExactDecimal(String(Math.abs(wave.pnl)), { absolute: true })}
                  </div>
                  <div className="mt-1 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-text-3">
                    Collected ${formatExactDecimal(String(wave.payout), { absolute: true })} on {depth || boxes.length} {boxes.length === 1 ? 'box' : 'boxes'}
                  </div>
                </>
              ) : inPlay ? (
                <>
                  <div className="flex items-center gap-2">
                    <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">If it ends now</div>
                    <span
                      className={cnm(
                        'inline-flex items-center border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.1em]',
                        holding.length > 0 ? 'border-up/60 text-up' : 'border-down/60 text-down',
                      )}
                    >
                      {holding.length} of {depth} holding
                    </span>
                  </div>
                  <div className={cnm('tnum text-[40px] font-extrabold leading-none', holding.length > 0 ? 'text-up' : 'text-down')}>
                    {holding.length > 0 ? `+$${formatExactDecimal(String(holdingWin), { absolute: true })}` : '$0.00'}
                  </div>
                  <div className="mt-2.5 grid grid-cols-3 gap-x-3">
                    <Cell label="Stack" value={`$${spent.toFixed(2)}`} />
                    <Cell label="All in" value={`$${toWin.toFixed(2)}`} />
                    <Cell label={atMax ? 'Pressed' : 'Next est'} value={atMax ? `${depth} of ${PRESS_MAX}` : `${nextMultEst.toFixed(2)}x`} />
                  </div>
                </>
              ) : firstRun ? (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Welcome</div>
                  <div className="text-[22px] font-extrabold uppercase leading-none tracking-[0.02em] text-text">Press</div>
                  <div className="mt-2.5 font-mono text-[11px] font-semibold uppercase leading-snug tracking-[0.08em] text-text-2">
                    Open wide, then <span className="text-brand-500">PRESS</span> to tighten
                  </div>
                </>
              ) : (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Opening box</div>
                  {/* No opening multiple is quoted here on purpose: the analytic model reads ~40% high against
                      the chain's surface, and the real number lands off OrderMinted a second later. */}
                  <div className="flex items-baseline gap-2">
                    <span className="tnum text-[36px] font-extrabold leading-none text-brand-500">{OPEN_LABELS[openIdx]}</span>
                    <span className="font-mono text-[13px] font-bold uppercase tracking-[0.08em] text-text-2">
                      {openIdx === 0 ? 'safest' : openIdx === OPEN_PROBS.length - 1 ? 'pays most' : 'box'}
                    </span>
                  </div>
                  <div className="mt-2.5 grid grid-cols-3 gap-x-3">
                    <Cell label="Per box" value={`$${stake}`} />
                    <Cell label={`All ${PRESS_MAX}`} value={floorCost} />
                    <Cell label="Presses" value={`${PRESS_MAX} max`} />
                  </div>
                  {/* The true floor cost of a full round, stated before the first chip is committed. */}
                  <div className="mt-2.5 font-mono text-[11px] font-semibold uppercase leading-snug tracking-[0.08em] text-text-2">
                    Every box costs ${stake} · <span className="text-text-3">pressing all {PRESS_MAX} costs {floorCost}</span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {roundDone && resultBox?.playId && (
        <ResultOverlay
          play={
            {
              ...(resultBox as unknown as PlayDTO),
              status: (wave?.pnl ?? 0) >= 0 ? 'won' : 'lost',
              pnl: String(wave?.pnl ?? 0),
              payout: String(wave?.payout ?? 0),
            } as PlayDTO
          }
          streak={streak}
          winTitle={holding.length > 1 ? 'STACKED' : 'HELD IT'}
          cashoutTitle="FOLDED"
          loseTitle="DROPPED IT"
          detail={
            <div className="mt-2 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-text-2">
              <div>
                {boxes.filter((b) => b.won).length} of {boxes.filter((b) => b.band).length} boxes paid
                {settlePx ? ` · closed ${fmtPrice(parseFloat(settlePx))}` : ''}
              </div>
            </div>
          }
        />
      )}
      {overlay === 'howto' && (
        <InstructionOverlay
          compact
          lines={[
            ['OPEN', 'The knob sets your first box. Wide is safe and pays little.'],
            ['PRESS', 'Mints a tighter box inside the last one, for another stake.'],
            ['PAY', 'Every box holding the price at the buzzer pays. The innermost pays them all.'],
            ['FOLD', 'Closes every box at once, early, for whatever they are worth now.'],
          ]}
        />
      )}
      {overlay === 'board' && <GameLeaderboardOverlay game="press" title="Press" />}
    </GameScreen>
  )
}

// One SSE + watchdog per open box, the same hidden-watcher pattern the Range board uses.
function BoxWatch({
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
