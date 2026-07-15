import { useEffect, useRef, useState } from 'react'
import { type PriceTick } from '@/lib/api'
import { priceBus } from '@/lib/priceBus'
import { isDemo } from '@/lib/demo'
import { env } from '@/env'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { cnm } from '@/utils/style'
import { formatPrice } from '@/utils/format'

// The single most important "feel" component. One canvas, one rAF loop reading refs. React
// never re-renders on a price tick. The line eases toward each price tick (the shared WS bus at
// ~10Hz, SSE fallback ~1s; interpolated, never stepped) while the x-axis scrolls continuously so
// motion never stalls between ticks. Reduced motion swaps to discrete, tick-driven redraws.

export interface ChartBox {
  lower: number
  upper: number
  tint?: 'up' | 'down' | 'neutral'
  // Active (placed) box: stronger fill/stroke so it reads over the faint candidate grid.
  strong?: boolean
}

// Range band. Idle: a live ±pct zone tracking the leading price. Locked: fixed price bounds carried
// by the play. Both span the full width, so the band reads the same before and after the lock.
export type BandOverlay =
  | { pct: number; locked?: false }
  // `sealed` freezes the band's live in/out lighting during the cash-out safety / settling window.
  // It is a neutral pending state, not a settlement verdict.
  | { lower: number; upper: number; locked: true; sealed?: boolean }

export interface ChartOverlays {
  // Entry: a clean reference line at the price you got in, faded in when a round opens.
  entry?: number
  // Target (Lucky): the strike the price must cross to win, with the side that wins. Drawn as a
  // bold amber line with the winning half shaded green (brighter when the live price is in it).
  target?: { price: number; side: 'up' | 'down' }
  band?: BandOverlay
  // Exact settled RESULT price after oracle.settlement_price exists.
  settle?: number
  boxes?: ChartBox[]
  // Time-anchored dots on the line (round start, settle): each maps by its timestamp on the same axis
  // as the price line, so they scroll with it. Dimmer than the live "now" dot. The now-dot rides between.
  markers?: Array<{ t: number; p: number }>
}

interface ChartProps {
  asset: string
  overlays?: ChartOverlays
  // Fixed pixel height, or omit to fill the parent (caller sizes the wrapper, e.g. flex-1).
  height?: number
  className?: string
  onPrice?: (price: number) => void
  // The chart's eased leading price, mirrored here every frame. Lets a readout track the line at
  // 60fps (the smooth value the player watches), instead of the ~1s raw onPrice ticks.
  livePriceRef?: { current: number }
  // A known current price (the market spot) to paint from immediately on mount, so the chart shows a
  // live line right away instead of a blank shimmer while the price stream warms up. Only seeds the
  // first frame (cosmetic warm-up history behind it); the stream then drives the real leading edge.
  initialPrice?: number
  onError?: () => void
  // Tap hit-test: maps a pointer-down to the price at that height. The canvas owns the
  // price<->y mapping (live, eased), so it is the only place this can be resolved correctly.
  onTap?: (price: number) => void
  // Degen: spark bursts + chart shake on momentum swings. On by default.
  degen?: boolean
  // The leading-edge price + momentum readout by the dot. Off hides the number (the masked,
  // not-yet-selected charts in Lucky's stack), leaving just the line + dot.
  showPriceTag?: boolean
}

type Particle = { x: number; y: number; vx: number; vy: number; born: number; color: string }

const WINDOW_MS = 30_000 // visible time span on the continuous axis
const MAX_VISIBLE = 48 // points kept for the discrete (reduced-motion) axis
// Leading-edge ease toward the latest tick, as a TIME CONSTANT (k = 1 - exp(-dt/tau)), so it is
// frame-rate independent and tracks a fast ~10Hz WS feed instead of gliding a second behind (a fixed
// per-frame lerp lagged at that cadence). ~130ms reads alive but smooth; the SSE fallback (~1s ticks)
// still glides cleanly through the same ease.
const EASE_TAU_MS = 130
const CENTER_SMOOTH = 0.06 // vertical recenter ease, slow so the frame stops breathing
const HALF_GROW = 0.12 // zoom-out ease when content needs more room
const HALF_SHRINK = 0.03 // zoom-in ease when there is slack, slow so the frame stays calm
const LIVE_CALM = 0.34 // ~3x slower recenter/zoom while a round is live, so entry/target barely drift
const FILL_SMOOTH = 0.08 // band right-zone -> full-width ease on lock
const PAD = 1.22 // headroom around the fitted content (tighter = the move fills more of the frame)
// Floor so a flat/degenerate line never zooms to infinity, not a target zoom level. Real testnet BTC
// moves only ~0.05% per round (see range.tsx BAND_LADDER) and the tightest range band is ±0.02%, so this
// has to sit well under that or it swamps real content and the line reads as barely moving. Kept as a
// last-resort guard; actual content (ticks + overlays) drives the frame almost all the time.
const MIN_HALF_PCT = 0.0001
const DOT_R = 7 // leading-edge dot radius (steady, no pulsing)
const MOM_LOOKBACK = 4000 // ms window for the momentum arrow's trend read
// Degen: burst particles + chart shake on a momentum swing. For when subtlety is not the goal.
// Tuned to the game feed: a per-tick move this big fires on the sharp wicks and fast trend stretches
// (a few percent of ticks), so the chart pops without buzzing constantly.
const SWING_PCT = 0.0014 // move size that counts as a swing and fires the effect
const SHAKE_AMP = 5 // px max chart shake on a swing
const SHAKE_DECAY = 0.82 // per-frame shake falloff
const PARTICLE_N = 12 // sparks per burst
const PARTICLE_LIFE = 520 // ms spark lifetime
const PARTICLE_GRAV = 0.00018 // px/ms^2 gravity pulling sparks down
const TAU = Math.PI * 2
const TOP_PAD = 18
const BOT_PAD = 18
// Warm-up history: a synthetic walk drawn back across the window on the first tick, so a freshly
// opened chart reads as a moving line instead of a flat bar. Cosmetic only (see seedHistory).
const SEED_N = 32 // pre-roll points, matched to the ~1s tick cadence over the window
const SEED_STEP_VOL = 0.0024 // per-step move size of the warm-up walk (fraction of price)
const SEED_MOMENTUM = 0.62 // walk persistence, so it forms natural runs instead of pure jitter
const SEED_MAX_DEV = 0.012 // clamp the warm-up's drift from the live price (never wanders far)
// Real mode's true volatility is far calmer than the fork's synthetic oracle (testnet BTC moves only
// ~0.05% per round), so the fork-tuned seed above reads far more volatile than the real ticks that
// replace it, leaving the frame over-wide for the seed's first WINDOW_MS on screen. Real mode gets its
// own tamer envelope; fork/demo keep the original numbers untouched.
const REAL_SEED_STEP_VOL = 0.0003
const REAL_SEED_MAX_DEV = 0.0015
// Cosmetic micro-life on the leading edge so the line is never dead-flat in the gaps between the ~1s
// oracle ticks. A zero-mean, mean-reverting wiggle, hard-clamped far under the min target offset
// (~0.15%), applied ONLY to the drawn dot + line tip, never to display.current (the 60fps P/L source),
// onPrice, the win-zone read, or the frame fit. So the line feels fluid while the readouts and the
// oracle stay exact, and it can never drift (the offset is pulled back to 0 every frame). Suppressed in
// real mode (LIVE_MICRO_FEED): the Binance-driven bus already carries genuine tick-level micro-motion,
// so the fake wiggle would double up. Fork/demo (slower feeds) keep it, byte-identical to before.
const SHIM_MOMENTUM = 0.9 // velocity persistence: a smooth drifting wiggle, not per-frame jitter
const SHIM_VOL = 0.0000016 // per-frame velocity impulse
const SHIM_REVERT = 0.05 // pull the offset back toward 0 each frame, so it never accumulates into drift
const SHIM_MAX = 0.005 // hard clamp: ±0.035% of price (about a quarter of the 2x target distance)
// Real mode (testnet / mainnet) drives the chart off the Binance-pinned display bus, which already has
// genuine tick-level micro-motion, so the cosmetic shim is switched off there. Fork (localnet/devnet)
// keeps it. Demo is resolved per-mount below (isDemo reads localStorage), and always keeps the shim.
const REAL_NETWORK = env.VITE_SUI_NETWORK === 'testnet' || env.VITE_SUI_NETWORK === 'mainnet'

type Point = { t: number; p: number }

function readColor(name: string): string {
  if (typeof window === 'undefined') return '#ffffff'
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || '#ffffff'
}

// Synthetic warm-up history anchored at the current price: an AR(1) walk (momentum + small noise)
// read backward across the visible window, so a freshly opened chart shows a natural moving line
// instead of a dead-flat baseline. Cosmetic only, the newest point is the live price and real ticks
// replace the whole seed within WINDOW_MS. Returns points oldest-first (push order).
function seedHistory(price: number, tNow: number, stepVol: number, maxDev: number): Point[] {
  // prices[k] = synthetic price k steps back in time; prices[1] anchors at the live price so the
  // warm-up joins the real leading edge seamlessly.
  const prices = new Array<number>(SEED_N + 1)
  prices[1] = price
  let vel = (Math.random() - 0.5) * stepVol
  let cur = price
  for (let k = 2; k <= SEED_N; k++) {
    vel = vel * SEED_MOMENTUM + (Math.random() - 0.5) * stepVol
    cur = cur * (1 + vel)
    const dev = (cur - price) / price
    if (dev > maxDev) cur = price * (1 + maxDev)
    else if (dev < -maxDev) cur = price * (1 - maxDev)
    prices[k] = cur
  }
  const out: Point[] = []
  for (let k = SEED_N; k >= 1; k--) {
    out.push({ t: tNow - (k / SEED_N) * WINDOW_MS, p: prices[k] })
  }
  return out
}

export function Chart({ asset, overlays, height, className, onPrice, livePriceRef, initialPrice, onError, onTap, degen = true, showPriceTag = true }: ChartProps) {
  const reduced = useReducedMotion()
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [hasData, setHasData] = useState(false)

  // Mutable render state, read by the draw loop. Never triggers React re-renders.
  const points = useRef<Point[]>([])
  const target = useRef<number>(0)
  const display = useRef<number>(0)
  const seeded = useRef(false) // first-tick guard. A ref, not state: onTick reads it live, so the
  // flat baseline is seeded exactly once (state in the effect closure would be stale and re-seed).
  const range = useRef<{ min: number; max: number }>({ min: 0, max: 1 })
  const entryReveal = useRef(0) // 0 -> 1 fade-in as the entry line appears on a new round
  const targetReveal = useRef(0) // 0 -> 1 fade-in as the target line appears on a new round
  const momDir = useRef<'up' | 'down' | 'flat'>('flat') // momentum-arrow state, hysteretic
  const trendUp = useRef(true) // whole-line direction: green up / red down, flips on a real move
  const lastTickP = useRef(0) // last raw tick, to detect momentum swings
  const shake = useRef(0) // 0..1 chart-shake intensity, decays each frame
  const particles = useRef<Particle[]>([]) // live spark bursts
  const burst = useRef<string | null>(null) // pending burst color, spawned at the dot next paint
  const shimOff = useRef(0) // cosmetic micro-life offset (fraction of price), zero-mean + clamped
  const shimVel = useRef(0)
  const overlaysRef = useRef<ChartOverlays | undefined>(overlays)
  const reducedRef = useRef(reduced)
  const degenRef = useRef(degen)
  const showPriceTagRef = useRef(showPriceTag)
  const sizeRef = useRef<{ w: number; h: number }>({ w: 0, h: height ?? 0 })
  const rimRef = useRef(12) // rim-safe inset (px) for edge text, read from --screen-rim per resize
  const onPriceRef = useRef(onPrice)
  const onTapRef = useRef(onTap)
  const liveOutRef = useRef(livePriceRef)

  overlaysRef.current = overlays
  reducedRef.current = reduced
  degenRef.current = degen
  showPriceTagRef.current = showPriceTag
  onPriceRef.current = onPrice
  onTapRef.current = onTap
  liveOutRef.current = livePriceRef

  // Pointer-down -> price at that height, using the live eased range. Only y matters: a tap
  // selects a price band, time (x) is irrelevant to which box is hit.
  const handleTap = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onTapRef.current) return
    const yPx = e.clientY - e.currentTarget.getBoundingClientRect().top
    const { h } = sizeRef.current
    const plotH = h - TOP_PAD - BOT_PAD
    if (plotH <= 0) return
    const r = range.current
    const span = r.max - r.min || 1
    const price = r.max - ((yPx - TOP_PAD) / plotH) * span
    if (Number.isFinite(price)) onTapRef.current(price)
  }

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Real mode with a live backend feeds the Binance-pinned bus (real micro-motion), so the cosmetic
    // shim is off; fork and demo keep it. Resolved once per mount (isDemo reads localStorage at load).
    const liveMicroFeed = REAL_NETWORK && !isDemo()

    // Fresh series for this subscription. Must run before streamPrices so the first tick (the
    // demo emits one synchronously) seeds the flat baseline instead of landing as a lone dot.
    points.current = []
    seeded.current = false
    entryReveal.current = 0
    targetReveal.current = 0
    lastTickP.current = 0
    shake.current = 0
    particles.current = []
    burst.current = null
    setHasData(false)

    // Seed the flat baseline once: synthetic warm-up history anchored at `p`, the frame pre-fitted to
    // it, and the live edge parked at the price. Runs on the first real tick, or up front from an
    // initialPrice so the chart paints instantly instead of waiting on the stream. Guarded by `seeded`
    // so the first stream tick never re-seeds.
    const seedAt = (p: number, tNow: number): void => {
      seeded.current = true
      const seedPts = seedHistory(
        p,
        tNow,
        liveMicroFeed ? REAL_SEED_STEP_VOL : SEED_STEP_VOL,
        liveMicroFeed ? REAL_SEED_MAX_DEV : SEED_MAX_DEV,
      )
      let lo = p
      let hi = p
      for (const sp of seedPts) {
        if (sp.p < lo) lo = sp.p
        if (sp.p > hi) hi = sp.p
        points.current.push(sp)
      }
      const center = (lo + hi) / 2
      const half = Math.max(((hi - lo) / 2) * PAD, p * MIN_HALF_PCT)
      display.current = p
      target.current = p
      range.current = { min: center - half, max: center + half }
      setHasData(true)
    }

    // Paint immediately from the known current price (the market spot) so the chart is never a blank
    // shimmer while the stream warms up. The real ticks scroll in over this and the leading edge stays
    // the live price; only the history behind it is cosmetic.
    if (initialPrice != null && Number.isFinite(initialPrice) && initialPrice > 0) {
      seedAt(initialPrice, performance.now())
      onPriceRef.current?.(initialPrice)
    }

    const C = {
      text: readColor('--color-text'),
      brand: readColor('--color-brand-500'),
      up: readColor('--color-up'),
      down: readColor('--color-down'),
      line: readColor('--color-line-strong'),
    }

    // Crisp canvas sizing across DPR + responsive width.
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = wrap.clientWidth
      const h = height ?? wrap.clientHeight
      sizeRef.current = { w, h }
      // Edge labels must clear the device bevel: inset by the inherited --screen-rim (the full-bleed
      // line itself still tucks under it). Falls back when the var is absent (CSS shell / SSR).
      rimRef.current = Math.max(8, parseFloat(getComputedStyle(wrap).getPropertyValue('--screen-rim')) || 12)
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (reducedRef.current) paint(performance.now())
    }
    const ro = new ResizeObserver(resize)

    // Range band -> absolute price bounds. Idle: a live ±pct zone around the smoothed leading
    // price. Locked: the fixed strike bounds carried by the play. One source of truth (display),
    // so the band never jitters off the raw per-tick price.
    const resolveBand = (): { lower: number; upper: number } | null => {
      const b = overlaysRef.current?.band
      if (!b) return null
      if (b.locked) return { lower: b.lower, upper: b.upper }
      const c = display.current
      if (!Number.isFinite(c) || c <= 0) return null
      const half = (c * b.pct) / 100
      return { lower: c - half, upper: c + half }
    }

    const paint = (now: number) => {
      const { w, h } = sizeRef.current
      if (w === 0) return
      const continuous = !reducedRef.current
      const ov = overlaysRef.current
      const hasBoxes = Boolean(ov?.boxes?.length)
      const hasBand = Boolean(ov?.band)
      // Leave room on the right for a forward zone (band or boxes); else ride near the edge.
      const nowX = hasBoxes || hasBand ? w * 0.58 : w * 0.92
      const band = resolveBand()

      // Vertical content extent: visible points + the live edge + every overlay bound.
      let lo = Infinity
      let hi = -Infinity
      const consider = (v: number) => {
        if (!Number.isFinite(v)) return
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      const pts = points.current
      for (let i = 0; i < pts.length; i++) {
        if (reducedRef.current || now - pts[i].t <= WINDOW_MS) consider(pts[i].p)
      }
      consider(display.current)
      consider(target.current)
      if (ov?.entry != null) consider(ov.entry)
      if (ov?.target != null) consider(ov.target.price)
      if (ov?.settle != null) consider(ov.settle)
      if (band) {
        consider(band.lower)
        consider(band.upper)
      }
      if (ov?.boxes) {
        for (const b of ov.boxes) {
          consider(b.lower)
          consider(b.upper)
        }
      }
      if (ov?.markers) for (const m of ov.markers) consider(m.p)

      // Target window (center + half-height), padded, with a floor so a flat line never zooms in.
      let tCenter: number
      let tHalf: number
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        const base = target.current || display.current || 1
        tCenter = base
        tHalf = base * MIN_HALF_PCT
      } else {
        tCenter = (lo + hi) / 2
        tHalf = Math.max(((hi - lo) / 2) * PAD, Math.abs(tCenter) * MIN_HALF_PCT)
      }

      // Ease the frame: slow recenter, grow faster than it shrinks, and a hard clamp so live
      // content is never clipped. This is what kills the per-tick breathing/bouncing.
      const r = range.current
      let center = (r.min + r.max) / 2
      let half = (r.max - r.min) / 2
      if (!Number.isFinite(center) || half <= 0) {
        center = tCenter
        half = tHalf
      } else if (continuous) {
        // While a round is live, the entry/target lines are fixed-price references. Recentering the
        // frame makes them drift around the screen, which reads as the lines "not tracking" the price.
        // So ease the scale much calmer once a round is on; the hard clamp below still prevents clipping.
        const calm = ov?.entry != null || ov?.target != null ? LIVE_CALM : 1
        center += (tCenter - center) * CENTER_SMOOTH * calm
        half += (tHalf - half) * (tHalf > half ? HALF_GROW : HALF_SHRINK) * calm
        if (Number.isFinite(lo) && Number.isFinite(hi)) {
          const m = half * 0.06
          if (lo < center - half + m || hi > center + half - m) {
            const fitLo = Math.min(center - half, lo - m)
            const fitHi = Math.max(center + half, hi + m)
            center = (fitLo + fitHi) / 2
            half = (fitHi - fitLo) / 2
          }
        }
      } else {
        center = tCenter
        half = tHalf
      }
      range.current = { min: center - half, max: center + half }
      const span = half * 2 || 1
      const plotH = h - TOP_PAD - BOT_PAD
      const top = center + half
      const y = (p: number) => TOP_PAD + (top - p) / span * plotH

      const entryTarget = ov?.entry != null ? 1 : 0
      if (continuous) entryReveal.current += (entryTarget - entryReveal.current) * FILL_SMOOTH
      else entryReveal.current = entryTarget
      const targetTarget = ov?.target != null ? 1 : 0
      if (continuous) targetReveal.current += (targetTarget - targetReveal.current) * FILL_SMOOTH
      else targetReveal.current = targetTarget
      // Mirror the eased leading price out so a readout can track the line at 60fps.
      if (liveOutRef.current) liveOutRef.current.current = display.current

      ctx.clearRect(0, 0, w, h)

      // Degen chart-shake: jolt the whole frame on a swing, decaying fast. Translates the draw,
      // never the data, so the line geometry stays intact (no glitch).
      const degenOn = degenRef.current && continuous
      ctx.save()
      if (degenOn && shake.current > 0.02) {
        const s = SHAKE_AMP * shake.current
        ctx.translate((Math.random() - 0.5) * 2 * s, (Math.random() - 0.5) * 2 * s)
      }

      // Overlays sit under the line.
      drawOverlays(ctx, ov, band, { w, h, nowX, entryReveal: entryReveal.current, targetReveal: targetReveal.current, rim: rimRef.current, price: display.current, locked: Boolean(ov?.band?.locked), y, C })

      // Advance the cosmetic micro-life and apply it to the DRAWN leading edge only. Continuous mode
      // only, and only when the feed is NOT already lively (fork/demo); the real Binance-pinned bus
      // carries its own micro-motion, so the shim stays at 0 there. display.current itself is untouched,
      // so the P/L, the header price, the win-zone read, and the frame fit never see this wiggle.
      if (continuous && !liveMicroFeed) {
        shimVel.current = shimVel.current * SHIM_MOMENTUM + (Math.random() * 2 - 1) * SHIM_VOL
        shimOff.current += shimVel.current
        shimOff.current -= shimOff.current * SHIM_REVERT
        if (shimOff.current > SHIM_MAX) shimOff.current = SHIM_MAX
        else if (shimOff.current < -SHIM_MAX) shimOff.current = -SHIM_MAX
      } else {
        shimOff.current = 0
      }

      // Build the visible line. Continuous: x by real time. Reduced: x by index step.
      const yDisp = y(display.current * (1 + shimOff.current))
      const path: Array<{ x: number; y: number }> = []
      if (continuous) {
        const pxPerMs = nowX / WINDOW_MS
        for (let i = 0; i < pts.length; i++) {
          const x = nowX - (now - pts[i].t) * pxPerMs
          if (x < -4) continue
          path.push({ x, y: y(pts[i].p) })
        }
      } else {
        const vis = pts.slice(-MAX_VISIBLE)
        const step = nowX / Math.max(1, MAX_VISIBLE - 1)
        for (let i = 0; i < vis.length; i++) {
          const x = nowX - (vis.length - 1 - i) * step
          path.push({ x, y: y(vis[i].p) })
        }
      }
      path.push({ x: nowX, y: yDisp })

      // Whole-line direction: green while the price is rising, red while falling. Read over a short
      // MOM_LOOKBACK window with a small dead-zone, so it flips on a real move (not window-wide lag)
      // and holds steady through noise instead of strobing. Colors the whole line + the area fill.
      let trendRefP = display.current
      for (let i = pts.length - 1; i >= 0; i--) {
        if (now - pts[i].t >= MOM_LOOKBACK) {
          trendRefP = pts[i].p
          break
        }
      }
      const trendChange = (display.current - trendRefP) / (trendRefP || 1)
      if (trendChange > 0.0008) trendUp.current = true
      else if (trendChange < -0.0008) trendUp.current = false
      const lineColor = trendUp.current ? C.up : C.down

      if (path.length > 1) {
        // Soft area under the curve so it reads as a chart, not a lone stroke.
        ctx.beginPath()
        tracePath(ctx, path)
        ctx.lineTo(path[path.length - 1].x, h)
        ctx.lineTo(path[0].x, h)
        ctx.closePath()
        const g = ctx.createLinearGradient(0, TOP_PAD, 0, h)
        g.addColorStop(0, withAlpha(lineColor, 0.16))
        g.addColorStop(1, withAlpha(lineColor, 0))
        ctx.fillStyle = g
        ctx.fill()

        // The price line, smoothed so noisy ticks flow instead of zigzag. One color for the whole
        // line, set by the current direction above: green while rising, red while falling.
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.lineWidth = 2
        ctx.strokeStyle = lineColor
        ctx.beginPath()
        tracePath(ctx, path)
        ctx.stroke()
      }

      // Round markers: dim amber dots anchored in time (round start, settle), so they scroll with the
      // line. The now-dot rides between them; drawn first so the bright dot sits on top.
      if (continuous && ov?.markers?.length) {
        const pxPerMs = nowX / WINDOW_MS
        for (const m of ov.markers) {
          const mx = nowX - (now - m.t) * pxPerMs
          if (mx < -DOT_R || mx > w + DOT_R) continue
          const my = y(m.p)
          ctx.fillStyle = withAlpha(C.brand, 0.22)
          ctx.beginPath()
          ctx.arc(mx, my, DOT_R * 0.8, 0, TAU)
          ctx.fill()
          ctx.strokeStyle = withAlpha(C.brand, 0.5)
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.arc(mx, my, DOT_R * 0.8, 0, TAU)
          ctx.stroke()
        }
      }

      // Leading edge: a steady amber "now" dot with a soft, constant glow. No pulsing.
      ctx.save()
      ctx.shadowColor = C.brand
      ctx.shadowBlur = 14
      ctx.fillStyle = C.brand
      ctx.beginPath()
      ctx.arc(nowX, yDisp, DOT_R, 0, TAU)
      ctx.fill()
      ctx.restore()

      // Degen sparks: a burst flies off the tip on a swing, then drifts and fades.
      if (degenOn) {
        if (burst.current) {
          spawnBurst(particles.current, nowX, yDisp, burst.current, now)
          burst.current = null
        }
        drawParticles(ctx, particles.current, now)
      } else if (particles.current.length || shake.current) {
        particles.current = []
        shake.current = 0
      }

      // Momentum arrow + readable live price by the tip. With a band (Range) there is a clean
      // zone to the right, so it reads there; otherwise it stays left, clear of boxes/edge.
      // Suppressed on the masked charts (showPriceTag off) so a not-yet-selected market hides its price.
      if (showPriceTagRef.current && display.current > 0 && pts.length) {
        let refP = display.current
        for (let i = pts.length - 1; i >= 0; i--) {
          if (now - pts[i].t >= MOM_LOOKBACK) {
            refP = pts[i].p
            break
          }
        }
        // Hysteretic: flip to up/down past 0.08%, settle to flat only when nearly still.
        const change = (display.current - refP) / (refP || 1)
        if (change > 0.0008) momDir.current = 'up'
        else if (change < -0.0008) momDir.current = 'down'
        else if (Math.abs(change) < 0.0003) momDir.current = 'flat'
        const dir = momDir.current
        const momColor = dir === 'up' ? C.up : dir === 'down' ? C.down : withAlpha(C.text, 0.45)
        const price = formatPrice(display.current)

        ctx.save()
        ctx.font = '700 12px Inter, system-ui, sans-serif'
        ctx.textBaseline = 'middle'
        const aw = 9
        if (hasBand) {
          const ax = nowX + DOT_R + 9
          drawArrow(ctx, ax + aw / 2, yDisp, dir, momColor)
          ctx.textAlign = 'left'
          ctx.fillStyle = withAlpha(C.text, 0.82)
          ctx.fillText(price, ax + aw + 6, yDisp + 0.5)
        } else {
          const tx = nowX - DOT_R - 9
          ctx.textAlign = 'right'
          ctx.fillStyle = withAlpha(C.text, 0.82)
          ctx.fillText(price, tx, yDisp + 0.5)
          drawArrow(ctx, tx - ctx.measureText(price).width - 6 - aw / 2, yDisp, dir, momColor)
        }
        ctx.restore()
      }

      ctx.restore() // end degen shake transform
      if (degenOn && shake.current > 0.001) shake.current *= SHAKE_DECAY
    }

    // Observe + initial size now that paint exists. In reduced motion resize() paints
    // immediately, so it must run after paint is declared (was a TDZ crash on mount).
    ro.observe(wrap)
    resize()

    let raf = 0
    let lastNow = 0
    const loop = (now: number) => {
      // Frame-rate-independent ease. Clamp dt so a backgrounded tab (huge dt) doesn't snap the line.
      const dt = lastNow ? Math.min(now - lastNow, 100) : 16
      lastNow = now
      const k = 1 - Math.exp(-dt / EASE_TAU_MS)
      const d = display.current
      display.current = d + (target.current - d) * k
      paint(now)
      raf = requestAnimationFrame(loop)
    }

    const onTick = (tick: PriceTick) => {
      const p = parseFloat(tick.price)
      if (!Number.isFinite(p)) return
      const tNow = performance.now()
      // First tick seeds the warm-up history + fits the frame (unless already seeded up front from
      // initialPrice). The leading edge is the real price and real ticks scroll in over the seed,
      // which clears within WINDOW_MS. No real or settlement data is fabricated.
      if (!seeded.current) seedAt(p, tNow)
      // Momentum swing -> degen shake + spark burst (color follows the move's direction).
      const move = lastTickP.current ? (p - lastTickP.current) / lastTickP.current : 0
      lastTickP.current = p
      if (degenRef.current && !reducedRef.current && Math.abs(move) > SWING_PCT) {
        shake.current = Math.max(shake.current, Math.min(1, Math.abs(move) / (SWING_PCT * 2)))
        burst.current = move > 0 ? C.up : C.down
      }
      target.current = p
      points.current.push({ t: tNow, p })
      if (points.current.length > 600) points.current.splice(0, points.current.length - 600)
      onPriceRef.current?.(p)
      if (reducedRef.current) {
        display.current = p
        paint(performance.now())
      }
    }

    const unsub = priceBus.subscribe(asset, onTick, onError)
    if (!reduced) raf = requestAnimationFrame(loop)

    return () => {
      unsub()
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
    }
    // Re-subscribe + restart the loop on asset or motion-mode change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset, reduced, height])

  return (
    <div ref={wrapRef} className={cnm('relative w-full min-h-0', className)} style={height != null ? { height } : undefined}>
      <canvas
        ref={canvasRef}
        className="block h-full w-full"
        style={onTap ? { touchAction: 'manipulation', cursor: 'crosshair' } : undefined}
        onPointerDown={onTap ? handleTap : undefined}
      />
      {!hasData && (
        <div className="shimmer pointer-events-none absolute inset-x-3 top-1/2 h-px -translate-y-1/2 rounded-full" />
      )}
    </div>
  )
}

function drawOverlays(
  ctx: CanvasRenderingContext2D,
  ov: ChartOverlays | undefined,
  band: { lower: number; upper: number } | null,
  ctxv: { w: number; h: number; nowX: number; entryReveal: number; targetReveal: number; rim: number; price: number; locked: boolean; y: (p: number) => number; C: Record<string, string> },
) {
  const { w, h, nowX, entryReveal, targetReveal, rim, price, locked, y, C } = ctxv

  // TARGET label rides the RIGHT edge (the amber hero), ENTRY stays on the LEFT. Opposite corners, so
  // the two can never stack into each other the way the old both-on-the-left pair did on a small move.
  const labelX = w - rim - 2
  const clampLabelY = (v: number): number => Math.max(11, Math.min(h - 8, v))

  if (band) {
    const top = y(band.upper)
    const bot = y(band.lower)
    const left = 0 // full width in both states: the band reads the same idle and locked.
    // Once locked, the band reads its own win/lose: the live price inside lifts the amber fill and
    // brightens the edges (you're in the zone); outside dims the fill and tints the crossed edge red.
    // The idle preview stays a neutral amber zone. While SEALED (cash-out safety / settling), suppress
    // the live verdict and show one neutral pending zone.
    const sealed = ov?.band?.locked === true && ov.band.sealed === true
    const inside = !sealed && price > band.lower && price <= band.upper
    const lit = locked && inside
    ctx.fillStyle = withAlpha(C.brand, lit ? 0.16 : locked ? 0.06 : 0.1)
    ctx.fillRect(left, top, w - left, bot - top)
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    const edge = (yy: number, hot: boolean) => {
      ctx.strokeStyle = withAlpha(hot ? C.down : C.brand, hot ? 0.85 : lit ? 0.7 : 0.5)
      ctx.beginPath()
      ctx.moveTo(left, yy)
      ctx.lineTo(w, yy)
      ctx.stroke()
    }
    edge(top, !sealed && locked && !inside && price > band.upper)
    edge(bot, !sealed && locked && !inside && price <= band.lower)
    ctx.setLineDash([])
    // Edge price labels, so the exact band is always readable (the etched field-guide detail). Inset
    // off the rim like ENTRY: the band spans full width (left = 0), so a bare left+4 would sit under
    // the device's beveled edge. Clamp to the rim-safe inset so the front panel never covers it.
    const labelLX = Math.max(left, rim) + 4
    ctx.save()
    ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.fillStyle = withAlpha(C.text, 0.7)
    ctx.fillText(formatPrice(band.upper), labelLX, top - 7)
    ctx.fillText(formatPrice(band.lower), labelLX, bot + 7)
    ctx.restore()
  }

  if (ov?.entry != null && entryReveal > 0.01) {
    const ys = y(ov.entry)
    const a = entryReveal
    // A clean solid reference at the price you got in. Neutral white (amber stays the live "now"
    // dot), faded in on entry so it reads as "you entered here", not permanent chart furniture.
    ctx.strokeStyle = withAlpha(C.text, 0.42 * a)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, ys)
    ctx.lineTo(w, ys)
    ctx.stroke()
    ctx.save()
    ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.fillStyle = withAlpha(C.text, 0.85 * a)
    // Inset off the left rim, flipped below the line when it sits too near the top to label above it.
    ctx.fillText(`ENTRY ${formatPrice(ov.entry)}`, rim + 2, clampLabelY(ys - 16 < 4 ? ys + 14 : ys - 9))
    ctx.restore()
  }

  // Target (Lucky): the line the price must cross to win. The winning half is shaded green and
  // brightens when the live price is inside it, so "am I winning" is readable straight off the
  // chart. The line itself is the one amber accent (SCREEN.md). Faded in on a new round.
  if (ov?.target != null && targetReveal > 0.01) {
    const { price: tp, side } = ov.target
    const a = targetReveal
    const ys = y(tp)
    const winUp = side === 'up'
    const inWin = winUp ? price > tp : price < tp
    const grad = ctx.createLinearGradient(0, ys, 0, winUp ? 0 : h)
    grad.addColorStop(0, withAlpha(C.up, (inWin ? 0.2 : 0.08) * a))
    grad.addColorStop(1, withAlpha(C.up, 0))
    ctx.fillStyle = grad
    ctx.fillRect(0, winUp ? 0 : ys, w, winUp ? ys : h - ys)

    ctx.strokeStyle = withAlpha(C.brand, (inWin ? 1 : 0.78) * a)
    ctx.lineWidth = 1.5
    ctx.setLineDash([5, 4])
    ctx.beginPath()
    ctx.moveTo(0, ys)
    ctx.lineTo(w, ys)
    ctx.stroke()
    ctx.setLineDash([])

    ctx.save()
    ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'right'
    ctx.fillStyle = withAlpha(C.brand, 0.95 * a)
    // The move the price has to make in your direction, spelled out next to the strike, so a target a
    // hair from entry still reads as a real directional bet (and never looks like it equals entry).
    const mv = ov.entry != null && ov.entry > 0 ? ((tp - ov.entry) / ov.entry) * 100 : null
    const mvStr = mv != null ? `  ${mv >= 0 ? '+' : ''}${Math.abs(mv) >= 1 ? mv.toFixed(1) : mv.toFixed(2)}%` : ''
    ctx.fillText(`TARGET ${formatPrice(tp)}${mvStr}`, labelX, clampLabelY(winUp ? ys - 10 : ys + 12))
    ctx.restore()
  }

  if (ov?.boxes?.length) {
    for (const b of ov.boxes) {
      const top = y(b.upper)
      const bot = y(b.lower)
      const tint = b.tint === 'up' ? C.up : b.tint === 'down' ? C.down : C.text
      ctx.fillStyle = withAlpha(tint, b.strong ? 0.2 : 0.07)
      ctx.fillRect(nowX, top, w - nowX, bot - top)
      ctx.strokeStyle = withAlpha(tint, b.strong ? 0.85 : 0.28)
      ctx.lineWidth = b.strong ? 1.5 : 1
      ctx.strokeRect(nowX + 0.5, top + 0.5, w - nowX - 1, bot - top - 1)
    }
  }

  // RESULT line: the exact oracle settlement_price after the settlement transaction lands. Green
  // inside the band, red outside.
  if (ov?.settle != null && Number.isFinite(ov.settle)) {
    const ys = y(ov.settle)
    const inWin = band ? ov.settle > band.lower && ov.settle <= band.upper : true
    const col = inWin ? C.up : C.down
    ctx.save()
    ctx.strokeStyle = col
    ctx.lineWidth = 2.5
    ctx.shadowColor = col
    ctx.shadowBlur = 10
    ctx.beginPath()
    ctx.moveTo(0, ys)
    ctx.lineTo(w, ys)
    ctx.stroke()
    ctx.shadowBlur = 0
    ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'right'
    ctx.fillStyle = col
    ctx.fillText(`RESULT ${formatPrice(ov.settle)}`, labelX, clampLabelY(ys - 11))
    ctx.restore()
  }
}

// Momentum indicator centered on (cx, cy): up/down triangle, or a flat bar when still.
function drawArrow(ctx: CanvasRenderingContext2D, cx: number, cy: number, dir: 'up' | 'down' | 'flat', color: string) {
  const w = 4.5
  const hh = 5
  ctx.fillStyle = color
  if (dir === 'flat') {
    ctx.fillRect(cx - w, cy - 1, w * 2, 2)
    return
  }
  ctx.beginPath()
  if (dir === 'up') {
    ctx.moveTo(cx, cy - hh)
    ctx.lineTo(cx + w, cy + 3)
    ctx.lineTo(cx - w, cy + 3)
  } else {
    ctx.moveTo(cx, cy + hh)
    ctx.lineTo(cx + w, cy - 3)
    ctx.lineTo(cx - w, cy - 3)
  }
  ctx.closePath()
  ctx.fill()
}

// Degen spark burst: radial sparks off the tip, biased upward, gravity-pulled, fading out.
function spawnBurst(arr: Particle[], x: number, y: number, color: string, now: number) {
  for (let i = 0; i < PARTICLE_N; i++) {
    const ang = Math.random() * TAU
    const spd = 0.03 + Math.random() * 0.1
    arr.push({ x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - 0.02, born: now, color })
  }
  // Cap so a rapid run of swings can't grow the array unbounded.
  if (arr.length > 160) arr.splice(0, arr.length - 160)
}

function drawParticles(ctx: CanvasRenderingContext2D, arr: Particle[], now: number) {
  if (!arr.length) return
  ctx.save()
  for (let i = arr.length - 1; i >= 0; i--) {
    const pt = arr[i]
    const age = now - pt.born
    if (age >= PARTICLE_LIFE) {
      arr.splice(i, 1)
      continue
    }
    const a = 1 - age / PARTICLE_LIFE
    const px = pt.x + pt.vx * age
    const py = pt.y + pt.vy * age + 0.5 * PARTICLE_GRAV * age * age
    ctx.globalAlpha = a
    ctx.fillStyle = pt.color
    ctx.shadowColor = pt.color
    ctx.shadowBlur = 6
    ctx.beginPath()
    ctx.arc(px, py, 2.2 * a + 0.6, 0, TAU)
    ctx.fill()
  }
  ctx.restore()
}

// Smooth a polyline through midpoints (quadratic) so noisy ticks read as a flowing curve.
function tracePath(ctx: CanvasRenderingContext2D, path: Array<{ x: number; y: number }>) {
  if (!path.length) return
  ctx.moveTo(path[0].x, path[0].y)
  for (let i = 1; i < path.length - 1; i++) {
    const xc = (path[i].x + path[i + 1].x) / 2
    const yc = (path[i].y + path[i + 1].y) / 2
    ctx.quadraticCurveTo(path[i].x, path[i].y, xc, yc)
  }
  ctx.lineTo(path[path.length - 1].x, path[path.length - 1].y)
}

// Apply an alpha to a hex or rgb token. Canvas needs concrete colors, so resolve tokens at
// runtime (no raw hex literals) and tint them here.
function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('#')) {
    const hex = color.slice(1)
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
    const n = parseInt(full, 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
  }
  if (color.startsWith('rgb')) {
    const inner = color.slice(color.indexOf('(') + 1, color.lastIndexOf(')'))
    const parts = inner.split(',').slice(0, 3).map((s) => s.trim())
    return `rgba(${parts.join(', ')}, ${alpha})`
  }
  return color
}
