import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useConsoleControls } from '@/components/console/controls'
import { Chart, type BandOverlay } from '@/components/game/Chart'
import { CoinCRT } from '@/components/game/CoinCRT'
import { Cell, GameReadout, GameScreen, GameStage, ScreenMessage } from '@/components/game/screen'
import { Stat } from '@/components/Stat'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { haptic } from '@/lib/haptics'
import { sound } from '@/lib/sound'
import { api, streamPlay, type PlayDTO, type PlayStatus } from '@/lib/api'
import { placePlay, cashOut } from '@/lib/sui/predict'
import { explorerTxUrl } from '@/lib/sui/config'
import { toastError } from '@/lib/errors'
import { notifyUnlocks } from '@/lib/achievements'
import { useAuth } from '@/lib/auth'
import { cnm } from '@/utils/style'
import { formatStringToNumericDecimals } from '@/utils/format'

// RANGE. Size a band around the live price with the knob (tighter = higher multiple), hit PLAY to lock
// it, then hold to the buzzer: a real mint_range that settles IN THE ZONE (spread-free $1·qty) or OUT
// OF RANGE (0) at the routed oracle's expiry, or CASH OUT early at the live mark. Every round is a real
// Predict position; demo mode runs the same flow on the in-memory model. The screen is the L-aperture
// (web/CLAUDE.md): a top bar + token selector over the chart, a notch-safe readout below. Teenage
// Engineering language throughout (docs/SCREEN.md): flat black, mono labels, one amber accent, green/
// red for facts.
export const Route = createFileRoute('/_app/games/range')({ component: RangeScreen })

// Stake ladder, scrubbed on the number wheel and clamped to the live balance (within MIN/MAX_STAKE).
const STAKE_LADDER = [1, 5, 10, 25, 50, 100] as const
const FALLBACK_ASSETS = ['BTC', 'ETH', 'SUI', 'SOL', 'DEEP']
// Token art. Only BTC has a real logo today; the rest fall back to a struck-ticker coin face.
const COIN_LOGOS: Record<string, string> = {
  BTC: '/assets/images/coins/btc-logo.png',
}
const pad2 = (n: number): string => String(n).padStart(2, '0')
const NOMINAL_ROUND_SEC = 30 // the idle multiplier preview's reference; the real round = oracle expiry
const RESULT_MS = 4200
const TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out', 'error'])

type Phase = 'idle' | 'placing' | 'open' | 'cashing' | 'result'
type Live = { markValue: string; pnl: string; multiplier: number; status: PlayStatus }
type Overlay = 'none' | 'howto' | 'history'

const money = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
// Compact price for the band recap: 67,210 -> 67.2k, 3.94 -> 3.94.
const compact = (n: number): string =>
  n >= 1000
    ? `${(n / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k`
    : n.toLocaleString('en-US', { maximumFractionDigits: n >= 1 ? 2 : 4 })

// Rough, monotonic estimate so the readout responds as the knob turns. Real value lands on mint.
function estimateMultiplier(halfPct: number, durationSec: number): number {
  const sigma = 0.6 * Math.sqrt(durationSec / 30) // ~1-sigma % move, scales with sqrt(T)
  const ratio = halfPct / sigma
  const prob = 1 - Math.exp(-ratio)
  return Math.max(1.05, Math.min(0.97 / Math.max(prob, 0.03), 99))
}

export function RangeScreen() {
  const { refresh, user } = useAuth()
  const qc = useQueryClient()
  const reduced = useReducedMotion()
  const [crtOn, setCrtOn] = useLocalStorage('pips_range_crt', true)

  const [widthTenths, setWidthTenths] = useState(10) // knob: half-band in tenths of a percent
  const [stakeIdx, setStakeIdx] = useState(2)
  const [assetIdx, setAssetIdx] = useState(0)
  const [phase, setPhase] = useState<Phase>('idle')
  const [play, setPlay] = useState<PlayDTO | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [spot, setSpot] = useState<number | null>(null)
  const [secsLeft, setSecsLeft] = useState<number | null>(null)
  const [overlay, setOverlay] = useState<Overlay>('none')

  const finalized = useRef(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wasInside = useRef<boolean | null>(null) // last in/out band state, for the crossing tick

  const marketsQ = useQuery({ queryKey: ['markets'], queryFn: () => api.markets(), refetchInterval: 10_000 })
  const statsQ = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() })
  const markets = marketsQ.data?.markets ?? []
  const liveAssets = markets.filter((m) => m.live).map((m) => m.asset)
  const noLiveMarket = !marketsQ.isLoading && !marketsQ.isError && liveAssets.length === 0
  const streak = statsQ.data?.stats.currentStreak ?? 0

  const assets = liveAssets.length ? liveAssets : FALLBACK_ASSETS
  const asset = play?.params.asset ?? assets[Math.min(assetIdx, assets.length - 1)]

  // BET clamps to what the balance affords, so the wheel never offers an unplayable bet.
  const balance = parseFloat(user?.balance ?? '0') || 0
  const maxBetIdx = Math.max(0, STAKE_LADDER.reduce((acc, v, i) => (v <= balance ? i : acc), 0))
  const safeBetIdx = Math.min(stakeIdx, maxBetIdx)
  const stake = STAKE_LADDER[safeBetIdx]

  const halfPct = widthTenths / 10
  const canPlay = liveAssets.length > 0

  const liveMult = live?.multiplier ?? play?.multiplier
  const mult = liveMult ?? estimateMultiplier(halfPct, NOMINAL_ROUND_SEC)
  const idleMult = estimateMultiplier(halfPct, NOMINAL_ROUND_SEC)

  // Band overlay: a live ±halfPct preview while idle (the chart centers it on the smoothed price),
  // locked to the play's strike bounds once open. The chart animates the lock from a right-side zone
  // to full width, labels the edges, and tints by whether the live price sits inside.
  const lower = play?.market.lower ? parseFloat(play.market.lower) : null
  const upper = play?.market.upper ? parseFloat(play.market.upper) : null
  const band: BandOverlay | undefined =
    play && lower != null && upper != null
      ? { lower, upper, locked: true }
      : spot != null
        ? { pct: halfPct }
        : undefined
  const showBand = phase !== 'result' || play != null

  // Is the live price inside the locked band right now? Drives the open-state IN ZONE / OUT pill and
  // the tactile crossing tick. (lower, upper] matches the on-chain settlement rule.
  const inZone = lower != null && upper != null && spot != null ? spot > lower && spot <= upper : null

  const clearResetTimer = () => {
    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = null
  }

  const finishResult = useCallback(
    (final: PlayDTO, unlocked: string[]) => {
      finalized.current = true
      wasInside.current = null
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

  // Live value while a play is open. The stream closes on a terminal frame (the settle worker drives
  // the oracle to settlement and redeems an in-the-money position); we then refetch the finalized play
  // to grab the payout + redeem digest for the result + explorer link.
  useEffect(() => {
    if (!play || phase !== 'open') return
    const unsub = streamPlay(
      play.id,
      (tick) => {
        setLive({ markValue: tick.markValue, pnl: tick.pnl, multiplier: tick.multiplier, status: tick.status })
        if (TERMINAL.has(tick.status) && !finalized.current) {
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

  const doPlay = useCallback(async () => {
    if (phase !== 'idle' && phase !== 'result') return
    if (!canPlay) {
      toast.error('No live market right now. Try again in a sec.')
      return
    }
    clearResetTimer()
    finalized.current = false
    wasInside.current = null
    setOverlay('none')
    setPhase('placing')
    haptic('rigid')
    try {
      const { play: p } = await placePlay('range', { stake, asset, widthPct: halfPct * 2 })
      setPlay(p)
      setLive({ markValue: p.markValue, pnl: p.pnl, multiplier: p.multiplier, status: p.status })
      setPhase('open')
      haptic('heavy')
    } catch (e) {
      toastError(e)
      setPhase('idle')
    }
  }, [phase, canPlay, stake, asset, halfPct])

  const doCashOut = useCallback(async () => {
    if (phase !== 'open' || !play) return
    setPhase('cashing')
    haptic('rigid')
    try {
      const { play: p, unlocked } = await cashOut(play.id)
      finishResult(p, unlocked)
    } catch (e) {
      // The buzzer settle may have beaten the cash-out. Reconcile against the chain before complaining.
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

  // Round countdown to the routed oracle's real expiry. At the buzzer we HOLD (the readout shows
  // SETTLING) and let the settle worker drive the win/lose; the stream effect above catches the
  // terminal frame. An early Main cash-out exits sooner. No auto-cash here.
  useEffect(() => {
    if (phase !== 'open' || !play) {
      setSecsLeft(null)
      return
    }
    const lenMs = (play.params.duration || NOMINAL_ROUND_SEC) * 1000
    const endAt = (play.openedAt ? Date.parse(play.openedAt) : Date.now()) + lenMs
    const tick = () => setSecsLeft(Math.max(0, Math.ceil((endAt - Date.now()) / 1000)))
    tick()
    const iv = setInterval(tick, 250)
    return () => clearInterval(iv)
  }, [phase, play])

  // A tactile tick whenever the live price crosses into or out of your band (open only), so the
  // tension is felt, not just seen.
  useEffect(() => {
    if (phase !== 'open' || inZone == null) return
    if (wasInside.current != null && wasInside.current !== inZone) haptic('selection')
    wasInside.current = inZone
  }, [inZone, phase])

  const cycleAsset = useCallback(() => {
    haptic('selection')
    if (assets.length) setAssetIdx((i) => (i + 1) % assets.length)
  }, [assets.length])
  const toggleHowto = useCallback(() => {
    haptic('selection')
    setOverlay((o) => (o === 'howto' ? 'none' : 'howto'))
  }, [])
  const toggleHistory = useCallback(() => {
    haptic('selection')
    setOverlay((o) => (o === 'history' ? 'none' : 'history'))
  }, [])

  const isOpen = phase === 'open'
  useConsoleControls({
    knob: {
      label: 'RANGE',
      min: 1,
      max: 30,
      step: 1,
      value: widthTenths,
      onChange: setWidthTenths,
      format: (v) => `±${(v / 10).toFixed(1)}%`,
    },
    numberWheel: {
      label: 'USDC',
      min: 0,
      max: maxBetIdx,
      step: 1,
      value: safeBetIdx,
      onChange: setStakeIdx,
      format: (v) => `$${STAKE_LADDER[Math.min(v, maxBetIdx)]}`,
    },
    action1: { label: 'HOW TO', color: 'neutral', onPress: toggleHowto },
    action2: { label: 'HISTORY', color: 'neutral', onPress: toggleHistory },
    main: isOpen
      ? { label: 'CASH OUT', color: 'up', onPress: () => void doCashOut() }
      : phase === 'cashing'
        ? { label: 'CASH OUT', color: 'up', onPress: () => {}, loading: true }
        : {
            label: 'PLAY',
            color: 'amber',
            onPress: () => void doPlay(),
            loading: phase === 'placing',
          },
  })

  const pnlNum = live ? parseFloat(live.pnl) : 0
  const showReadouts = play != null && (phase === 'open' || phase === 'cashing' || phase === 'result')
  const settling = phase === 'open' && secsLeft != null && secsLeft <= 0
  const showZonePill = phase === 'open' && inZone != null && !settling
  const firstRun = !statsQ.isLoading && (statsQ.data?.stats.gamesPlayed ?? 0) === 0

  // The device screen is the L-shaped aperture (web/CLAUDE.md "The console screen"): a top bar, the
  // chart filling the slack height, then a notch-safe readout band the chart stops above. The rim
  // inset is owned by the GameScreen/GameStage/GameReadout layout, not set here.
  return (
    <GameScreen>
      {marketsQ.isLoading ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="shimmer h-24 w-2/3" />
        </div>
      ) : marketsQ.isError ? (
        <ScreenMessage title="Could not load markets" action="Retry" onAction={() => void marketsQ.refetch()} />
      ) : noLiveMarket ? (
        <ScreenMessage title="No live markets right now." action="Retry" onAction={() => void marketsQ.refetch()} />
      ) : (
        <>
          {/* top bar — full width. Left: market + live price. Right: balance at rest, the expiry
              countdown once a play is open. The chart fills the slack height behind it. */}
          <GameStage
            top={
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Range · {asset}</div>
                  <div className="tnum text-2xl font-extrabold leading-none text-text">
                    {spot != null
                      ? `$${spot.toLocaleString('en-US', { maximumFractionDigits: spot >= 1000 ? 0 : 2 })}`
                      : '—'}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
                    {showReadouts && secsLeft != null ? 'Ends in' : 'Balance'}
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
            }
          >
            {asset ? (
              <Chart
                asset={asset}
                overlays={showBand && band ? { band } : undefined}
                onPrice={(p) => setSpot(p)}
                className="absolute inset-0"
              />
            ) : null}
          </GameStage>

          {/* readout band — a hero number over a clean two-up grid: the prize multiple + stake at
              rest, the live PnL (with an IN ZONE / OUT tag) once a play runs, SETTLING at the buzzer. */}
          <GameReadout>
            {settling ? (
              <>
                <div>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Status</div>
                  <div className="text-[34px] font-extrabold leading-none text-brand-500">
                    SETTLING<span className="animate-pulse">...</span>
                  </div>
                </div>
                <div className="font-mono text-[12px] font-semibold uppercase tracking-[0.1em] text-text-2">Landing your round</div>
              </>
            ) : showReadouts ? (
              <>
                <div>
                  <div className="flex items-center gap-2">
                    <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Live PnL</div>
                    {showZonePill && (
                      <span
                        className={cnm(
                          'inline-flex items-center border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.1em]',
                          inZone ? 'border-brand-500/60 text-brand-500' : 'border-down/60 text-down',
                        )}
                      >
                        {inZone ? 'In zone' : 'Out'}
                      </span>
                    )}
                  </div>
                  <div className={cnm('text-4xl font-extrabold leading-none', pnlNum >= 0 ? 'text-up' : 'text-down')}>
                    {pnlNum >= 0 ? '+' : '-'}$<Stat value={Math.abs(pnlNum)} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-x-4">
                  <Cell label="Mult" value={`${mult.toFixed(2)}x`} />
                  <Cell label="Ends" value={secsLeft != null ? `${secsLeft}s` : '—'} />
                </div>
              </>
            ) : firstRun ? (
              <>
                <div>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Welcome</div>
                  <div className="tnum text-4xl font-extrabold leading-none text-brand-500">
                    ${formatStringToNumericDecimals(user?.balance ?? '0', 0)}
                  </div>
                </div>
                <div className="font-mono text-[12px] font-semibold uppercase tracking-[0.1em] text-text-2">
                  in play chips · size a band, hit <span className="text-brand-500">PLAY</span>
                </div>
              </>
            ) : (
              <>
                <div>
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">Pays</div>
                  <div className="tnum text-4xl font-extrabold leading-none text-brand-500">{idleMult.toFixed(2)}x</div>
                </div>
                <div className="grid grid-cols-2 gap-x-4">
                  <Cell label="Stake" value={`$${stake}`} />
                  <Cell label="Band" value={`±${halfPct.toFixed(1)}%`} />
                </div>
                <div className="font-mono text-[12px] font-semibold uppercase tracking-[0.1em] text-text-2">Tighter range, bigger prize</div>
              </>
            )}
          </GameReadout>

          {/* Token selector — idle only, so a live play keeps the chart + band clean. The token can't
              change mid-play anyway (it's locked to the open position). The right tile is the token's
              coin flipping behind the glass in low-res dithered amber, a little instrument vignette;
              the left button cycles the asset, the CRT pill toggles the dither. */}
          {phase === 'idle' && (
            <div className="absolute z-[6] flex flex-col gap-2 left-[var(--screen-rim,24px)] top-[calc(var(--screen-rim,24px)_+_50px)]">
              <div className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-text-3">Token</div>
              <div className="flex items-stretch gap-2">
                <button
                  type="button"
                  onClick={cycleAsset}
                  className="pointer-events-auto flex w-[84px] flex-col justify-between gap-1 border border-line-strong bg-black/70 px-2.5 py-2 text-left transition-colors hover:border-brand-500/60 active:scale-[0.99]"
                >
                  <span className="tnum font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-text-3">
                    {pad2(Math.max(0, assets.indexOf(asset)) + 1)}/{pad2(assets.length)}
                  </span>
                  <span className="text-[26px] font-extrabold uppercase leading-none text-text">{asset}</span>
                  <span className="font-mono text-[8px] font-bold uppercase tracking-[0.1em] text-brand-500">Tap to swap ▸</span>
                </button>
                <button
                  type="button"
                  onClick={cycleAsset}
                  aria-label={`Token ${asset}`}
                  className="pointer-events-auto relative h-[84px] w-[84px] shrink-0 border border-brand-500/50 bg-black transition-colors hover:border-brand-500 active:scale-[0.99]"
                >
                  <CoinCRT
                    ticker={asset ?? 'BTC'}
                    logoSrc={asset ? COIN_LOGOS[asset] : undefined}
                    crt={crtOn}
                    spin={!reduced}
                    lores={44}
                    className="absolute inset-[3px]"
                  />
                </button>
              </div>
              <button
                type="button"
                onClick={() => {
                  haptic('selection')
                  setCrtOn((v) => !v)
                }}
                className="pointer-events-auto inline-flex w-fit items-center gap-1.5 border border-line-strong px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.14em] transition-colors hover:border-brand-500/60"
              >
                <span className={cnm('h-1.5 w-1.5', crtOn ? 'bg-brand-500' : 'bg-text-3')} />
                <span className={crtOn ? 'text-brand-500' : 'text-text-3'}>CRT {crtOn ? 'On' : 'Off'}</span>
              </button>
            </div>
          )}
        </>
      )}

      {phase === 'result' && play && <RangeResult play={play} onDismiss={() => setPhase('idle')} />}
      {overlay === 'howto' && <HowTo onClose={() => setOverlay('none')} />}
      {overlay === 'history' && <History onClose={() => setOverlay('none')} />}
    </GameScreen>
  )
}

// The win/loss/cash-out moment. Flat full-screen wash (docs/SCREEN.md: big, flat, momentary, no blur),
// the §10 copy, the signed amount, the band recap, and the explorer link when it is on-chain.
function RangeResult({ play, onDismiss }: { play: PlayDTO; onDismiss: () => void }) {
  const reduced = useReducedMotion()
  const pnl = parseFloat(play.pnl ?? '0')
  const won = play.status === 'won'
  const cashed = play.status === 'cashed_out'
  const positive = won || (cashed && pnl >= 0)
  const head = won ? 'IN THE ZONE' : cashed ? 'CASHED OUT' : 'OUT OF RANGE'
  const lo = play.market.lower ? parseFloat(play.market.lower) : null
  const hi = play.market.upper ? parseFloat(play.market.upper) : null
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
      {lo != null && hi != null && (
        <div className="font-mono text-[12px] uppercase tracking-[0.12em] text-text-3">
          Band {compact(lo)} – {compact(hi)}
        </div>
      )}
      {!positive && <div className="font-mono text-[12px] uppercase tracking-[0.12em] text-text-3">Play again</div>}
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
    ['BAND', 'Turn the knob to size your price band. Tighter pays more.'],
    ['PLAY', 'Locks the band around the live price.'],
    ['WIN', 'Land inside the band at the buzzer to win stake × multiple.'],
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

// HISTORY: the player's recent Range rounds, newest first. Flat rows split by hairlines.
function History({ onClose }: { onClose: () => void }) {
  const q = useQuery({ queryKey: ['plays'], queryFn: () => api.plays({ limit: 30 }) })
  const plays = (q.data?.plays ?? []).filter((p) => p.game === 'range' && p.status !== 'open' && p.status !== 'pending').slice(0, 6)
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
        <div className="text-[14px] text-text-2">No plays yet. Size a band and hit PLAY.</div>
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
  const pnl = parseFloat(play.pnl ?? '0')
  const won = play.status === 'won' || (play.status === 'cashed_out' && pnl >= 0)
  const label = play.status === 'won' ? 'WON' : play.status === 'cashed_out' ? 'CASHED' : 'LOST'
  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="flex items-center gap-3">
        <span className="font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-text">{play.params.asset}</span>
        <span className="font-mono text-[12px] font-bold uppercase tracking-[0.06em] text-brand-500">{play.multiplier.toFixed(2)}x</span>
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
