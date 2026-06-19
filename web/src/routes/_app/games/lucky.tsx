import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useConsoleControls } from '@/components/console/controls'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { Chart } from '@/components/game/Chart'
import { Cell, GameScreen, ScreenMessage } from '@/components/game/screen'
import { Stat } from '@/components/Stat'
import { haptic } from '@/lib/haptics'
import { sound, slotSpin, slotTick, slotLock } from '@/lib/sound'
import { api, streamPlay, type LuckyParams, type PlayDTO, type PlayStatus, type Side } from '@/lib/api'
import { placePlay, cashOut } from '@/lib/sui/predict'
import { explorerTxUrl } from '@/lib/sui/config'
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
// Reel cycle pools (cosmetic blur before the snap). The real targets come from the dealt play.
const REEL_ASSETS = ['BTC', 'SUI', 'ETH']
const DIR_POOL = ['UP', 'DOWN']
const MULT_POOL = ['1.5x', '2x', '3x', '5x', '10x', '25x']
const SPIN_STOPS = [720, 980, 1240] // staggered reel stops (ms)
const SPIN_TOTAL = 1320
const RESULT_MS = 4200
const ROUND_SEC = 30 // fixed fast round; the play carries the authoritative duration
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

  const [betIdx, setBetIdx] = useState(2)
  const [phase, setPhase] = useState<Phase>('idle')
  const [play, setPlay] = useState<PlayDTO | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [spot, setSpot] = useState<number | null>(null)
  const [entryPrice, setEntryPrice] = useState<number | null>(null)
  const [secsLeft, setSecsLeft] = useState<number | null>(null)
  const [overlay, setOverlay] = useState<Overlay>('none')

  const finalized = useRef(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Entry line marks the dealt asset's first live price. Track the latest spot and the asset it
  // belongs to (set together in onPrice) so a round on a new asset never marks entry at the old one.
  const spotRef = useRef<number | null>(null)
  const spotAssetRef = useRef<string | null>(null)
  const chartAssetRef = useRef<string>('')

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
  const chartAsset = lp?.asset ?? liveAssets[0] ?? 'BTC'
  chartAssetRef.current = chartAsset
  // The entry line shows once a round is live (placed through to the result), marking where you got in.
  const showEntry = play != null && (phase === 'spinning' || phase === 'open' || phase === 'cashing' || phase === 'result')
  const strike = play?.market.strike ? parseFloat(play.market.strike) : undefined
  const spinning = phase === 'spinning'
  // Reels tumble from the instant SPIN is pressed through to the snap: the 'placing' wait (the
  // server deal) and the 'spinning' window. This is what makes the multi-second deal feel instant.
  const reelsCycling = phase === 'placing' || phase === 'spinning'
  const showReadouts = play != null && (phase === 'open' || phase === 'cashing' || phase === 'result')
  const multiplier = live?.multiplier ?? play?.multiplier ?? 0
  const value = live ? parseFloat(live.markValue) : bet
  const pnlNum = live ? parseFloat(live.pnl) : 0
  const playBet = play ? parseFloat(play.stake) : bet
  // The round ended and we are waiting on the settle frame (the buzzer freeze).
  const settling = phase === 'open' && secsLeft != null && secsLeft <= 0
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
      haptic(final.status === 'lost' ? 'error' : 'success')
      sound(final.status === 'lost' ? 'lose' : 'win')
      notifyUnlocks(unlocked)
      void refresh()
      // Settle/cashout moved the record: freshen stats (streak), achievements, and history.
      for (const key of ['stats', 'achievements', 'plays']) void qc.invalidateQueries({ queryKey: [key] })
      clearResetTimer()
      resetTimer.current = setTimeout(() => setPhase('idle'), RESULT_MS)
    },
    [refresh, qc],
  )

  // Live value while a play is open. The play comes back 'pending' the instant it's dealt (the reels
  // snap right away); the real Predict mint lands a moment later and the stream flips it to 'open'.
  // The stream closes on a terminal frame (the buzzer settle); we then refetch the finalized play to
  // grab the payout + redeem digest for the result + explorer link. A 'pending' that flips to 'error'
  // means the background mint could not open it (rare): chips are safe (a failed mint debits nothing),
  // so we re-rack cleanly instead of showing a loss.
  useEffect(() => {
    if (!play || phase !== 'open') return
    const unsub = streamPlay(
      play.id,
      (tick) => {
        setLive({ markValue: tick.markValue, pnl: tick.pnl, multiplier: tick.multiplier, status: tick.status })
        if (tick.status === 'error' && !finalized.current) {
          finalized.current = true
          toast.error('Could not open that play. Your chips are safe, spin again.')
          clearResetTimer()
          setPlay(null)
          setLive(null)
          setPhase('idle')
          return
        }
        if (RESULT_TERMINAL.has(tick.status) && !finalized.current) {
          finalized.current = true
          void api
            .getPlay(play.id)
            .then(({ play: final }) => finishResult(final, []))
            .catch(() => setPhase('idle'))
        }
      },
      () => {
        // SSE dropped: keep the last good readout, EventSource retries on its own.
      },
    )
    return unsub
  }, [play, phase, finishResult])

  useEffect(() => () => clearResetTimer(), [])

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
    if (entryPrice != null || !play) return
    if (spotAssetRef.current === play.market.asset && spotRef.current != null) {
      setEntryPrice(spotRef.current)
    }
  }, [spot, play, entryPrice])

  const doPlay = useCallback(async () => {
    if (phase !== 'idle' && phase !== 'result') return
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
    if (phase !== 'open' || !play) return
    setPhase('cashing')
    haptic('rigid')
    try {
      const { play: p, unlocked } = await cashOut(play.id)
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
  }, [phase, play, finishResult])

  // Round countdown for the TIME readout. At the buzzer the settle worker (or the demo stream)
  // produces the terminal frame; the stream effect above catches it. No auto-cash here.
  useEffect(() => {
    if (phase !== 'open' || !play) {
      setSecsLeft(null)
      return
    }
    const lenMs = ((play.params as LuckyParams).duration || ROUND_SEC) * 1000
    const endAt = (play.openedAt ? Date.parse(play.openedAt) : Date.now()) + lenMs
    const tick = () => setSecsLeft(Math.max(0, Math.ceil((endAt - Date.now()) / 1000)))
    tick()
    const iv = setInterval(tick, 250)
    return () => clearInterval(iv)
  }, [phase, play])

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
  const isOpen = phase === 'open' && confirmed
  const isOpening = phase === 'open' && !confirmed
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
    action1: { label: 'HOW TO', color: 'neutral', onPress: toggleHowto },
    action2: { label: 'HISTORY', color: 'neutral', onPress: toggleHistory },
    main: isOpen
      ? { label: 'CASH OUT', color: 'up', onPress: () => void doCashOut() }
      : isOpening
        ? { label: 'OPENING', color: 'up', onPress: () => {}, loading: true }
        : phase === 'cashing'
          ? { label: 'CASH OUT', color: 'up', onPress: () => {}, loading: true }
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
                <div className="tnum text-[34px] font-extrabold leading-none text-text">{spot != null ? priceLabel(spot) : '—'}</div>
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

            {/* The three reels: one full-width slot band, hairline-divided cells, no foot border. */}
            <div className="flex border-t border-line-strong">
              <Reel index={0} label="Asset" pool={REEL_ASSETS} target={lp?.asset} cycling={reelsCycling} landing={spinning} stopAt={SPIN_STOPS[0]} />
              <Reel
                index={1}
                label="Up Down"
                pool={DIR_POOL}
                target={lp ? sideLabel(lp.side) : undefined}
                cycling={reelsCycling}
                landing={spinning}
                stopAt={SPIN_STOPS[1]}
                accent={lp?.side === 'up' ? 'up' : lp?.side === 'down' ? 'down' : undefined}
              />
              <Reel
                index={2}
                label="Multiplier"
                pool={MULT_POOL}
                target={play ? fmtMult(play.multiplier) : undefined}
                cycling={reelsCycling}
                landing={spinning}
                stopAt={SPIN_STOPS[2]}
                accent="amber"
              />
            </div>
          </div>

          {/* CHART — its own band, bounded between the slot header and the footer so the leading
              dot never spills behind either zone (no full-bleed overflow). */}
          <div className="relative min-h-0 flex-1">
            {chartAsset ? (
              <Chart
                asset={chartAsset}
                overlays={showEntry && entryPrice != null ? { entry: entryPrice } : undefined}
                onPrice={(p) => {
                  spotRef.current = p
                  spotAssetRef.current = chartAssetRef.current
                  setSpot(p)
                }}
                className="absolute inset-0"
              />
            ) : null}
          </div>

          {/* FOOTER — full-width readout bar under the chart, one top hairline. The live VALUE while
              a round runs, the bet + how-to-start at rest. Content hugs the left, clear of the PLAY
              body in the bottom-right. */}
          <div className="shrink-0 border-t border-line-strong bg-black px-[var(--screen-rim,24px)] pb-[var(--screen-rim,24px)] pt-3.5">
            {/* Fixed height: the readout swaps between bet / dealing / value, but the card must not
                jump size as the copy changes, so the tallest state sets the floor for all of them. */}
            <div className="max-w-[60%] min-h-[120px]">
              {settling ? (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Status</div>
                  <div className="text-[30px] font-extrabold leading-none text-brand-500">
                    SETTLING<span className="animate-pulse">...</span>
                  </div>
                  <div className="mt-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-text-2">Locking in your round</div>
                </>
              ) : showReadouts ? (
                <>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Value</div>
                  <div className={cnm('text-[34px] font-extrabold leading-none', pnlNum >= 0 ? 'text-up' : 'text-down')}>
                    $<Stat value={value} />
                  </div>
                  <div className={cnm('mt-0.5 font-mono text-[12px] font-bold uppercase tracking-[0.08em]', pnlNum >= 0 ? 'text-up' : 'text-down')}>
                    {pnlNum >= 0 ? '+' : '-'}${money(Math.abs(pnlNum))}
                  </div>
                  <div className="mt-2.5 grid grid-cols-3 gap-x-3">
                    <Cell label="Multiplier" value={fmtMult(multiplier)} />
                    <Cell label="Target" value={strike != null ? priceLabel(strike) : '—'} />
                    <Cell label="Bet" value={`$${money(playBet)}`} />
                  </div>
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

      {phase === 'result' && play && <LuckyResult play={play} streak={streak} onDismiss={() => setPhase('idle')} />}
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
}: {
  index: number
  label: string
  pool: string[]
  target?: string
  cycling: boolean
  landing: boolean
  stopAt: number
  accent?: 'amber' | 'up' | 'down'
}) {
  const [shown, setShown] = useState<string>('—')
  const poolRef = useRef(pool)
  poolRef.current = pool

  useEffect(() => {
    if (!cycling) {
      setShown(target ?? '—')
      return
    }
    let stopped = false
    const iv = setInterval(() => {
      if (!stopped) {
        const p = poolRef.current
        setShown(p[Math.floor(Math.random() * p.length)])
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
            slotLock(index)
          }, stopAt)
        : undefined
    return () => {
      clearInterval(iv)
      if (to) clearTimeout(to)
    }
  }, [cycling, landing, target, stopAt, index])

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
  const locked = !cycling && shown !== '—'
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

// The win/loss/cash-out moment. Flat full-screen wash (docs/SCREEN.md: big, flat, momentary, no blur),
// the §10 copy, the signed amount, the streak on a win, and the explorer link when it is on-chain.
function LuckyResult({ play, streak, onDismiss }: { play: PlayDTO; streak: number; onDismiss: () => void }) {
  const reduced = useReducedMotion()
  const pnl = parseFloat(play.pnl ?? '0')
  const won = play.status === 'won'
  const cashed = play.status === 'cashed_out'
  const positive = won || (cashed && pnl >= 0)
  const head = won ? 'YOU WON' : cashed ? 'CASHED OUT' : 'MISSED'
  const digest = play.txRedeem ?? play.txMint
  const pop = reduced
    ? {}
    : { initial: { scale: 0.7, opacity: 0 }, animate: { scale: 1, opacity: 1 }, transition: { type: 'spring' as const, stiffness: 440, damping: 24 } }
  return (
    <button
      type="button"
      onClick={onDismiss}
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/90 text-center"
    >
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
      {!positive && <div className="font-mono text-[12px] uppercase tracking-[0.12em] text-text-3">Spin again</div>}
      {digest && (
        <a
          href={explorerTxUrl(digest)}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="mt-1 font-mono text-[11px] uppercase tracking-[0.08em] text-text-3 underline underline-offset-4 transition-colors hover:text-text-2"
        >
          View on explorer
        </a>
      )}
      <span className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-text-3">Tap to continue</span>
    </button>
  )
}

// HOW TO: a flat in-screen card of the rules. Plain terminology only, no banned words.
function HowTo({ onClose }: { onClose: () => void }) {
  const lines: Array<[string, string]> = [
    ['SPIN', 'Deals an asset, a direction, and a multiplier.'],
    ['TARGET', 'The price your pick must cross by the buzzer.'],
    ['WIN', 'Land past TARGET and you win bet × multiplier.'],
    ['CASH OUT', 'Take the live value any time before the buzzer.'],
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
