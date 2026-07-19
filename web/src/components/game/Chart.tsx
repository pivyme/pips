import { useEffect, useRef, useState } from 'react'
import { type PriceTick } from '@/lib/api'
import { priceBus } from '@/lib/priceBus'
import { isDemo } from '@/lib/demo'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { cnm } from '@/utils/style'
import { formatPrice } from '@/utils/format'

// One canvas, one rAF loop reading refs, so React never re-renders on a price tick; the line eases
// continuously toward each tick instead of stepping. Reduced motion swaps this for discrete redraws.

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
  // `sealed` freezes the band's live in/out lighting during the cash-out/settling window (neutral, not a verdict).
  // `confirming` is the ~1s mint-landing window: shows the resolved band with a soft pulse, no win/lose verdict yet.
  | { lower: number; upper: number; locked: true; sealed?: boolean; confirming?: boolean }

// Live chart geometry, published each paint so a DOM overlay (the crowd layer) can pin nodes to the
// price line in the canvas's coordinate space. One object, mutated in place, never reallocated.
// Consumer maps a price to y with: topPad + (top - price) / span * plotH.
export interface ChartGeometry {
  w: number // css px width
  h: number // css px height
  nowX: number // x of the leading edge (the "now" dot)
  top: number // price at the top of the visible window
  span: number // price span across plotH
  plotH: number // plotted height in px (h minus top/bottom pad)
  topPad: number // px inset above the plot
  price: number // live eased leading price (matches the now dot)
}

export interface ChartOverlays {
  // Entry: a clean reference line at the price you got in, faded in when a round opens.
  entry?: number
  // Target (Lucky): the strike that must be crossed to win; drawn as a bold amber line with the
  // winning half shaded green (brighter when the live price is inside).
  target?: { price: number; side: 'up' | 'down' }
  band?: BandOverlay
  // Range-v2 multiplay: each locked band anchored in TIME from its entry (t0) to its cutoff/expiry (t1), so it
  // scrolls left with the line while the now-dot rides from the band's left edge toward its right. Edges light
  // green/red by whether the live price rides inside. `n` is the slot number (flag near the cutoff edge) tying
  // the chip strip to the chart. t0/t1 are Date.now epoch ms; omit them to fall back to a static forward lane.
  bands?: Array<{ lower: number; upper: number; state?: 'live' | 'won' | 'lost'; n?: number; t0?: number; t1?: number }>
  // Range-v2 aim: where the NEXT play's band would land, a live ±pct bracket tracking the price (amber, dashed).
  aim?: { pct: number; tag?: string }
  // Exact settled RESULT price after oracle.settlement_price exists.
  settle?: number
  boxes?: ChartBox[]
  // Time-anchored dots (e.g. each position's entry) mapped by Date.now epoch on the same axis as the price line,
  // so they scroll left with it. Dimmer than the live "now" dot, which rides between them.
  markers?: Array<{ t: number; p: number }>
}

interface ChartProps {
  asset: string
  overlays?: ChartOverlays
  // Fixed pixel height, or omit to fill the parent (caller sizes the wrapper, e.g. flex-1).
  height?: number
  className?: string
  onPrice?: (price: number) => void
  // The chart's eased leading price, mirrored here every frame, so a readout can track the line at
  // 60fps instead of the ~1s raw onPrice ticks.
  livePriceRef?: { current: number }
  // Published geometry snapshot each paint, so a DOM overlay can pin to the price line (crowd layer).
  geometryRef?: { current: ChartGeometry | null }
  // A known current price to paint from immediately on mount, instead of a blank shimmer while the
  // stream warms up. Only seeds the first frame; the stream then drives the real leading edge.
  initialPrice?: number
  onError?: () => void
  // Tap hit-test: maps a pointer-down to the price at that height; only the canvas owns the live
  // price<->y mapping, so it is the only place this can be resolved correctly.
  onTap?: (price: number) => void
  // Degen: spark bursts + chart shake on momentum swings. On by default.
  degen?: boolean
  // The leading-edge price + momentum readout by the dot; off hides the number (masked,
  // not-yet-selected charts in Lucky's stack), leaving just the line + dot.
  showPriceTag?: boolean
  // Settlement freeze: at the buzzer the round's price is fixed on-chain, so the line must stop chasing
  // live ticks. Holds the tip at the buzzer value, then eases it onto overlays.settle (the exact on-chain
  // RESULT) so the dot lands on the result line instead of drifting past it.
  frozen?: boolean
}

type Particle = { x: number; y: number; vx: number; vy: number; born: number; color: string }

const WINDOW_MS = 30_000 // visible time span on the continuous axis
const MAX_VISIBLE = 48 // points kept for the discrete (reduced-motion) axis
// Ease toward the latest tick via a TIME CONSTANT (k = 1 - exp(-dt/tau)), frame-rate independent
// unlike a fixed per-frame lerp. ~130ms reads alive for both the ~10Hz WS feed and the ~1s SSE fallback.
const EASE_TAU_MS = 130
const CENTER_SMOOTH = 0.06 // vertical recenter ease, slow so the frame stops breathing
const HALF_GROW = 0.12 // zoom-out ease when content needs more room
const HALF_SHRINK = 0.03 // zoom-in ease when there is slack, slow so the frame stays calm
const LIVE_CALM = 0.34 // ~3x slower recenter/zoom while a round is live, so entry/target barely drift
const FILL_SMOOTH = 0.08 // band right-zone -> full-width ease on lock
const BAND_SMOOTH = 0.12 // per-frame ease for band width/reshape (~0.4s settle), so it shrinks/expands smoothly
const PAD = 1.22 // headroom around the fitted content (tighter = the move fills more of the frame)
// Last-resort floor so a flat/degenerate line never zooms to infinity, not a target zoom level.
// Must sit well under real testnet BTC's ~0.05% per-round move and the ±0.02% tightest range band.
const MIN_HALF_PCT = 0.0001
const DOT_R = 7 // leading-edge dot radius (steady, no pulsing)
const MOM_LOOKBACK = 4000 // ms window for the momentum arrow's trend read
// Degen: burst particles + chart shake on a momentum swing. For when subtlety is not the goal.
const SWING_PCT = 0.0014 // move size tuned to fire on sharp wicks/fast stretches, not constant buzz
const SHAKE_AMP = 5 // px max chart shake on a swing
const SHAKE_DECAY = 0.82 // per-frame shake falloff
const PARTICLE_N = 12 // sparks per burst
const PARTICLE_LIFE = 520 // ms spark lifetime
const PARTICLE_GRAV = 0.00018 // px/ms^2 gravity pulling sparks down
const TAU = Math.PI * 2
const TOP_PAD = 18
const BOT_PAD = 18
// Warm-up history: a synthetic walk drawn across the window on first tick, so a fresh chart isn't a
// flat bar. Cosmetic only (see seedHistory).
const SEED_N = 32 // pre-roll points, matched to the ~1s tick cadence over the window
const SEED_STEP_VOL = 0.0024 // per-step move size of the warm-up walk (fraction of price)
const SEED_MOMENTUM = 0.62 // walk persistence, so it forms natural runs instead of pure jitter
const SEED_MAX_DEV = 0.012 // clamp the warm-up's drift from the live price (never wanders far)
// Real BTC (~0.05%/round) is far calmer than the wide seed above, which would leave the frame over-wide
// for the seed's first WINDOW_MS. The real product feed gets its own tamer envelope; demo keeps the original numbers.
const REAL_SEED_STEP_VOL = 0.0003
const REAL_SEED_MAX_DEV = 0.0015
// Cosmetic micro-life so the line isn't flat between oracle ticks: a clamped wiggle on the drawn
// dot/line only, never display.current/onPrice/the win-zone read/the frame fit; off in real mode (Binance bus already has motion).
const SHIM_MOMENTUM = 0.9 // velocity persistence: a smooth drifting wiggle, not per-frame jitter
const SHIM_VOL = 0.0000016 // per-frame velocity impulse
const SHIM_REVERT = 0.05 // pull the offset back toward 0 each frame, so it never accumulates into drift
const SHIM_MAX = 0.005 // hard clamp: ±0.035% of price (about a quarter of the 2x target distance)
// The real product feed already has genuine micro-motion via the Binance bus, so the shim is off there.
// Demo is resolved per-mount below (isDemo reads localStorage) and always keeps the shim on.

type Point = { t: number; p: number }

function readColor(name: string): string {
  if (typeof window === 'undefined') return '#ffffff'
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || '#ffffff'
}

// Synthetic warm-up history anchored at the current price: an AR(1) walk read backward across the
// window, so a fresh chart isn't dead-flat. Cosmetic only, real ticks replace the seed within WINDOW_MS.
function seedHistory(price: number, tNow: number, stepVol: number, maxDev: number): Point[] {
  // prices[k] = synthetic price k steps back; prices[1] anchors at the live price so the warm-up joins the leading edge seamlessly.
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

export function Chart({ asset, overlays, height, className, onPrice, livePriceRef, geometryRef, initialPrice, onError, onTap, degen = true, showPriceTag = true, frozen = false }: ChartProps) {
  const reduced = useReducedMotion()
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [hasData, setHasData] = useState(false)

  // Mutable render state, read by the draw loop. Never triggers React re-renders.
  const points = useRef<Point[]>([])
  const target = useRef<number>(0)
  const display = useRef<number>(0)
  const seeded = useRef(false) // first-tick guard; a ref not state, so onTick reads it live and seeds exactly once
  const range = useRef<{ min: number; max: number }>({ min: 0, max: 1 })
  const entryReveal = useRef(0) // 0 -> 1 fade-in as the entry line appears on a new round
  const targetReveal = useRef(0) // 0 -> 1 fade-in as the target line appears on a new round
  // Eased band geometry so width changes (knob tier, round-clock shrink) and the idle->locked reshape glide
  // instead of snapping. Center + half, so the idle preview still tracks the live price with no lag.
  const bandC = useRef(0)
  const bandHalf = useRef(0)
  const bandMode = useRef<'none' | 'idle' | 'locked'>('none')
  // Range-v2 aim bracket: eased half-width so a knob tier change glides instead of snapping (mirrors the band).
  const aimHalf = useRef(0)
  const aimActive = useRef(false)
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
  const frozenRef = useRef(frozen)
  const sizeRef = useRef<{ w: number; h: number }>({ w: 0, h: height ?? 0 })
  const rimRef = useRef(12) // rim-safe inset (px) for edge text, read from --screen-rim per resize
  const onPriceRef = useRef(onPrice)
  const onTapRef = useRef(onTap)
  const liveOutRef = useRef(livePriceRef)
  const geomOutRef = useRef(geometryRef)
  const geomSnap = useRef<ChartGeometry>({ w: 0, h: 0, nowX: 0, top: 0, span: 1, plotH: 0, topPad: TOP_PAD, price: 0 })

  overlaysRef.current = overlays
  reducedRef.current = reduced
  degenRef.current = degen
  showPriceTagRef.current = showPriceTag
  frozenRef.current = frozen
  onPriceRef.current = onPrice
  onTapRef.current = onTap
  liveOutRef.current = livePriceRef
  geomOutRef.current = geometryRef

  // Pointer-down -> price at that height, using the live eased range; only y matters, time (x) is irrelevant to which box is hit.
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

    // The real product feed carries genuine micro-motion via Binance, so the shim is off; demo keeps it (resolved once per mount, isDemo reads localStorage at load).
    const liveMicroFeed = !isDemo()

    // Fresh series for this subscription; must run before streamPrices so demo's synchronous first tick seeds the baseline instead of landing as a lone dot.
    points.current = []
    seeded.current = false
    entryReveal.current = 0
    targetReveal.current = 0
    lastTickP.current = 0
    shake.current = 0
    particles.current = []
    burst.current = null
    setHasData(false)

    // Seed the flat baseline once: warm-up history anchored at `p`, frame pre-fitted, live edge parked at the price.
    // Runs on the first real tick or up front from initialPrice; guarded by `seeded` so the first stream tick never re-seeds.
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

    // Paint immediately from the known current price so the chart is never a blank shimmer while the stream warms up.
    // Real ticks scroll in over this; the leading edge stays the live price, only the history behind it is cosmetic.
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
      // Edge labels inset by the inherited --screen-rim to clear the device bevel (the full-bleed line still tucks under it); falls back when absent (CSS shell/SSR).
      rimRef.current = Math.max(8, parseFloat(getComputedStyle(wrap).getPropertyValue('--screen-rim')) || 12)
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (reducedRef.current) paint(performance.now())
    }
    const ro = new ResizeObserver(resize)

    // Range band -> absolute price bounds, eased. Idle: a live ±pct zone whose CENTER tracks the smoothed price
    // (no lag) while the half-width eases, so a knob tier change or the round-clock shrink glides instead of jumping.
    // Locked: fixed strike bounds, with the idle->locked reshape easing center+half in from the preview.
    // Uses display (smoothed), not the raw per-tick price, so the band never jitters.
    const resolveBand = (): { lower: number; upper: number } | null => {
      const b = overlaysRef.current?.band
      if (!b) {
        bandMode.current = 'none'
        return null
      }
      const cont = !reducedRef.current
      const locked = b.locked === true
      const c = display.current
      if (!locked && (!Number.isFinite(c) || c <= 0)) return null // no price yet to center the preview on
      const tc = locked ? (b.lower + b.upper) / 2 : c
      const th = locked ? (b.upper - b.lower) / 2 : (c * b.pct) / 100
      if (bandMode.current === 'none' || !cont) {
        bandC.current = tc // first appearance (or reduced motion): snap, never expand from a collapsed line
        bandHalf.current = th
      } else {
        // Idle center rides the live price with no lag; a locked center eases in from the preview on lock.
        bandC.current = locked ? bandC.current + (tc - bandC.current) * BAND_SMOOTH : tc
        bandHalf.current += (th - bandHalf.current) * BAND_SMOOTH
      }
      bandMode.current = locked ? 'locked' : 'idle'
      return { lower: bandC.current - bandHalf.current, upper: bandC.current + bandHalf.current }
    }

    // Range-v2 aim: the ±pct half-width eased in absolute price units, so a tier change glides the bracket
    // instead of snapping. Center tracks the live price directly (no lag); only the half-width eases.
    const resolveAimHalf = (): number | null => {
      const a = overlaysRef.current?.aim
      const c = display.current
      if (!a || !Number.isFinite(c) || c <= 0) {
        aimActive.current = false
        return null
      }
      const th = (c * a.pct) / 100
      if (!aimActive.current || reducedRef.current) aimHalf.current = th // first appearance / reduced motion: snap
      else aimHalf.current += (th - aimHalf.current) * BAND_SMOOTH
      aimActive.current = true
      return aimHalf.current
    }

    const paint = (now: number) => {
      const { w, h } = sizeRef.current
      if (w === 0) return
      const continuous = !reducedRef.current
      const ov = overlaysRef.current
      const hasBoxes = Boolean(ov?.boxes?.length)
      const hasBand = Boolean(ov?.band)
      const hasBands = Boolean(ov?.bands?.length)
      const hasAim = Boolean(ov?.aim)
      // Leave room on the right for a forward zone (band, boxes, multiplay lanes, or the aim bracket); else ride near the edge.
      const nowX = hasBoxes || hasBand || hasBands || hasAim ? w * 0.58 : w * 0.92
      const band = resolveBand()
      const aimHalfEased = resolveAimHalf()

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
      if (ov?.bands) {
        for (const b of ov.bands) {
          consider(b.lower)
          consider(b.upper)
        }
      }
      if (ov?.aim && aimHalfEased != null) {
        const c = display.current
        consider(c - aimHalfEased)
        consider(c + aimHalfEased)
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

      // Ease the frame: slow recenter, grow faster than shrink, hard-clamp so live content is never clipped; this is what kills per-tick breathing.
      const r = range.current
      let center = (r.min + r.max) / 2
      let half = (r.max - r.min) / 2
      if (!Number.isFinite(center) || half <= 0) {
        center = tCenter
        half = tHalf
      } else if (continuous) {
        // While a round is live, entry/target/locked bands are fixed-price references; recentering the frame would make them drift, reading as not-tracking.
        // Range-v2's locked bands anchor the frame exactly like Range's entry line, so the price visibly moves against them instead of the frame chasing it flat.
        // Ease the scale much calmer once a round is on; the hard clamp below still prevents clipping.
        const calm = ov?.entry != null || ov?.target != null || Boolean(ov?.bands?.length) ? LIVE_CALM : 1
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

      // Publish geometry for the DOM crowd overlay (pins avatars to the price line). Mutate one object, no alloc.
      if (geomOutRef.current) {
        const g = geomSnap.current
        g.w = w
        g.h = h
        g.nowX = nowX
        g.top = top
        g.span = span
        g.plotH = plotH
        g.topPad = TOP_PAD
        g.price = display.current
        geomOutRef.current.current = g
      }

      const entryTarget = ov?.entry != null ? 1 : 0
      if (continuous) entryReveal.current += (entryTarget - entryReveal.current) * FILL_SMOOTH
      else entryReveal.current = entryTarget
      const targetTarget = ov?.target != null ? 1 : 0
      if (continuous) targetReveal.current += (targetTarget - targetReveal.current) * FILL_SMOOTH
      else targetReveal.current = targetTarget
      // Mirror the eased leading price out so a readout can track the line at 60fps.
      if (liveOutRef.current) liveOutRef.current.current = display.current

      ctx.clearRect(0, 0, w, h)

      // Degen chart-shake: jolt the whole frame on a swing, decaying fast; translates the draw, never the data, so the line geometry stays intact.
      const degenOn = degenRef.current && continuous
      ctx.save()
      if (degenOn && shake.current > 0.02) {
        const s = SHAKE_AMP * shake.current
        ctx.translate((Math.random() - 0.5) * 2 * s, (Math.random() - 0.5) * 2 * s)
      }

      // Overlays sit under the line.
      drawOverlays(ctx, ov, band, { w, h, now, nowX, entryReveal: entryReveal.current, targetReveal: targetReveal.current, rim: rimRef.current, price: display.current, locked: Boolean(ov?.band?.locked), aimHalf: aimHalfEased, y, C })

      // Advance the cosmetic micro-life, applied to the DRAWN leading edge only, continuous mode and non-live feeds only (the real Binance bus already has its own).
      // display.current itself stays untouched, so P/L, header price, win-zone, and frame fit never see this wiggle.
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

      // Whole-line direction (green rising/red falling): read over MOM_LOOKBACK with a dead-zone so it flips on a real move, not lag, and holds through noise.
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

        // The price line, smoothed so noisy ticks flow instead of zigzag; one color for the whole line, set by the trend direction above.
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.lineWidth = 2
        ctx.strokeStyle = lineColor
        ctx.beginPath()
        tracePath(ctx, path)
        ctx.stroke()
      }

      // Round markers: dim amber dots anchored in time (round start, settle) so they scroll with the line; drawn first so the bright now-dot sits on top.
      if (continuous && ov?.markers?.length) {
        const pxPerMs = nowX / WINDOW_MS
        const nowEpoch = performance.timeOrigin + now
        for (const m of ov.markers) {
          const mx = nowX - (nowEpoch - m.t) * pxPerMs
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

      // Momentum arrow + live price by the tip: with a band (Range) there's a clean zone to the right so it reads there, otherwise it stays left clear of boxes/edge.
      // Suppressed when showPriceTag is off, so a not-yet-selected market hides its price.
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

      // Cutoff lines: the settlement boundary for each open expiry, scrolling in from the right toward the now-dot.
      // Faint as it enters view, ramping to bright white in the final seconds so the buzzer is unmissable. Drawn on
      // top of the line so it reads as a hard cut; when it reaches the now-dot the positions before it are settling.
      if (continuous && ov?.bands?.length) {
        const pxPerMs = nowX / WINDOW_MS
        const nowEpoch = performance.timeOrigin + now
        const expiries = Array.from(
          new Set(ov.bands.filter((b) => b.state !== 'won' && b.state !== 'lost' && b.t1 != null).map((b) => b.t1!)),
        )
        ctx.save()
        ctx.font = '700 9px ui-monospace, SFMono-Regular, Menlo, monospace'
        ctx.textBaseline = 'top'
        for (const t1 of expiries) {
          const secs = (t1 - nowEpoch) / 1000
          if (secs > 12) continue // only draw once it's closing in
          const cx = nowX - (nowEpoch - t1) * pxPerMs
          if (cx < nowX - 2 || cx > w + 2) continue
          const a = Math.max(0.14, Math.min(1, (12 - secs) / 6)) // faint far out, full white by ~6s
          const near = secs <= 8
          ctx.strokeStyle = withAlpha(C.text, a)
          ctx.lineWidth = near ? 1.6 : 1
          ctx.setLineDash(near ? [] : [3, 5])
          ctx.beginPath()
          ctx.moveTo(cx, TOP_PAD)
          ctx.lineTo(cx, h - BOT_PAD)
          ctx.stroke()
          ctx.setLineDash([])
          // Label sits just to the RIGHT of the line, flipping left only if it would clip the edge.
          const putRight = cx + 46 < w - rimRef.current
          ctx.textAlign = putRight ? 'left' : 'right'
          const lx = cx + (putRight ? 5 : -5)
          ctx.fillStyle = withAlpha(C.text, Math.min(1, a + 0.1))
          ctx.fillText('CUTOFF', lx, TOP_PAD + 2)
          if (secs > 0) ctx.fillText(`${Math.ceil(secs)}s`, lx, TOP_PAD + 13)
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

    // The exact on-chain settlement price once the RESULT is known (finite, positive), else null. The frozen
    // leading edge eases onto this so the dot lands on the RESULT line instead of the display feed's drift.
    const settlePin = (): number | null => {
      const s = overlaysRef.current?.settle
      return s != null && Number.isFinite(s) && s > 0 ? s : null
    }

    let raf = 0
    let lastNow = 0
    const loop = (now: number) => {
      // Frame-rate-independent ease. Clamp dt so a backgrounded tab (huge dt) doesn't snap the line.
      const dt = lastNow ? Math.min(now - lastNow, 100) : 16
      lastNow = now
      const k = 1 - Math.exp(-dt / EASE_TAU_MS)
      // Settled: pull the tip onto the on-chain RESULT. onTick holds target while frozen, so this wins.
      const pin = settlePin()
      if (pin != null) target.current = pin
      const d = display.current
      display.current = d + (target.current - d) * k
      paint(now)
      raf = requestAnimationFrame(loop)
    }

    const onTick = (tick: PriceTick) => {
      const p = parseFloat(tick.price)
      if (!Number.isFinite(p)) return
      const tNow = performance.now()
      // First tick seeds the warm-up history + fits the frame (unless already seeded from initialPrice).
      // The leading edge is the real price; real ticks scroll in over the seed and clear it within WINDOW_MS.
      if (!seeded.current) seedAt(p, tNow)
      // Frozen at the buzzer (or settled): the round's price is fixed on-chain, so stop chasing live ticks.
      // The tip holds its buzzer value, then the loop eases it onto the settle pin (RESULT), never past it.
      if (frozenRef.current || settlePin() != null) {
        if (reducedRef.current) {
          const pin = settlePin()
          if (pin != null) {
            target.current = pin
            display.current = pin
            paint(performance.now())
          }
        }
        return
      }
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
  ctxv: { w: number; h: number; now: number; nowX: number; entryReveal: number; targetReveal: number; rim: number; price: number; locked: boolean; aimHalf: number | null; y: (p: number) => number; C: Record<string, string> },
) {
  const { w, h, now, nowX, entryReveal, targetReveal, rim, price, locked, aimHalf, y, C } = ctxv

  // TARGET rides the RIGHT edge (the amber hero), ENTRY stays LEFT; opposite corners so they can never stack on a small move.
  const labelX = w - rim - 2
  const clampLabelY = (v: number): number => Math.max(11, Math.min(h - 8, v))

  if (band) {
    const top = y(band.upper)
    const bot = y(band.lower)
    const left = 0 // full width in both states: the band reads the same idle and locked.
    // Locked: live price inside lifts the amber fill + brightens edges, outside dims the fill and tints the crossed edge red; idle preview stays neutral amber.
    // SEALED/CONFIRMING suppress the live verdict into one neutral pending zone; confirming adds a soft pulse so it reads as finalizing, not frozen.
    const sealed = ov?.band?.locked === true && ov.band.sealed === true
    const confirming = ov?.band?.locked === true && ov.band.confirming === true
    const pulse = confirming ? 0.5 + 0.5 * Math.abs(Math.sin(performance.now() / 260)) : 1
    const neutral = sealed || confirming
    const inside = !neutral && price > band.lower && price <= band.upper
    const lit = locked && inside
    ctx.fillStyle = withAlpha(C.brand, (lit ? 0.16 : confirming ? 0.05 : locked ? 0.06 : 0.1) * pulse)
    ctx.fillRect(left, top, w - left, bot - top)
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    const edge = (yy: number, hot: boolean) => {
      ctx.strokeStyle = withAlpha(hot ? C.down : C.brand, (hot ? 0.85 : lit ? 0.7 : 0.5) * pulse)
      ctx.beginPath()
      ctx.moveTo(left, yy)
      ctx.lineTo(w, yy)
      ctx.stroke()
    }
    edge(top, !neutral && locked && !inside && price > band.upper)
    edge(bot, !neutral && locked && !inside && price <= band.lower)
    ctx.setLineDash([])
    // Edge price labels so the exact band is always readable. Band spans full width (left=0), so inset off the rim like ENTRY.
    // Clamp to the rim-safe inset so the device's beveled edge never covers the label.
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

  // Range-v2 multiplay: each locked band drawn as a rectangle anchored in TIME, from its entry (t0) to its
  // cutoff/expiry (t1), so it scrolls left with the line while the now-dot rides from the band's left edge
  // toward its right. Before the cutoff: fill + dashed edges light green inside / red out (the exact band you're
  // losing is visible), a left spine marks where the play was placed. Once the cutoff passes the settlement price
  // is locked, so the band STOPS reacting to the line: it freezes and PULSES, neutral while awaiting the verdict,
  // then green (won) / red (lost). A numbered flag near the cutoff edge ties to its chip. Missing t0/t1 falls back
  // to a static forward lane.
  if (ov?.bands?.length) {
    const pxPerMs = nowX / WINDOW_MS
    const nowEpoch = performance.timeOrigin + now
    const pulse = 0.45 + 0.55 * Math.abs(Math.sin(performance.now() / 300)) // shared breathing for every frozen/settled band
    const spanOf = (b: { t0?: number; t1?: number }): { xl: number; xr: number } => {
      const rawL = b.t0 != null ? nowX - (nowEpoch - b.t0) * pxPerMs : nowX
      const rawR = b.t1 != null ? nowX - (nowEpoch - b.t1) * pxPerMs : w
      const xl = Math.max(0, Math.min(rawL, w))
      const xr = Math.max(Math.min(rawR, w), xl + 1)
      return { xl, xr }
    }
    // A band's phase: live (reacts to the line), settling (cutoff passed, verdict pending), or the resolved verdict.
    const phaseOf = (b: { state?: 'live' | 'won' | 'lost'; t1?: number }): 'live' | 'settling' | 'won' | 'lost' =>
      b.state === 'won' || b.state === 'lost' ? b.state : b.t1 != null && nowEpoch >= b.t1 ? 'settling' : 'live'
    const rectEdges = (xl: number, xr: number, top: number, bot: number) => {
      ctx.beginPath()
      ctx.moveTo(xl, top)
      ctx.lineTo(xr, top)
      ctx.moveTo(xl, bot)
      ctx.lineTo(xr, bot)
      ctx.stroke()
    }
    ctx.save()
    for (const b of ov.bands) {
      const { xl, xr } = spanOf(b)
      const top = y(b.upper)
      const bot = y(b.lower)
      const phase = phaseOf(b)
      if (phase === 'live') {
        // Pre-cutoff: track the line. Green inside, red out. Overlaps deepen via stacked alpha.
        const inside = price > b.lower && price <= b.upper
        ctx.fillStyle = withAlpha(C.up, inside ? 0.14 : 0.05)
        ctx.fillRect(xl, top, xr - xl, bot - top)
        ctx.lineWidth = 1
        ctx.setLineDash([4, 4])
        ctx.strokeStyle = withAlpha(inside ? C.up : C.down, inside ? 0.45 : 0.55)
        rectEdges(xl, xr, top, bot)
        ctx.setLineDash([])
        // Left spine at entry: the placed gate the price scrolled in from.
        ctx.strokeStyle = withAlpha(inside ? C.up : C.down, 0.4)
        ctx.beginPath()
        ctx.moveTo(xl, top)
        ctx.lineTo(xl, bot)
        ctx.stroke()
      } else {
        // Cutoff passed: frozen, pulsing. Neutral white while settling, then the verdict color, never the live price.
        const col = phase === 'won' ? C.up : phase === 'lost' ? C.down : C.text
        const base = phase === 'won' ? 0.26 : phase === 'lost' ? 0.16 : 0.09
        ctx.fillStyle = withAlpha(col, base * pulse)
        ctx.fillRect(xl, top, xr - xl, bot - top)
        ctx.lineWidth = phase === 'settling' ? 1.4 : 1.8
        ctx.setLineDash([])
        ctx.strokeStyle = withAlpha(col, 0.95 * pulse)
        rectEdges(xl, xr, top, bot)
      }
    }
    // Numbered flags: one square per band, pinned to its cutoff edge (clamped on-screen), the same slot number as
    // its chip. Green when the price is inside (paying), red when out, neutral while settling, verdict when resolved.
    const FS = 14
    const gap = FS + 3
    const flags = ov.bands
      .filter((b) => b.n != null)
      .map((b) => ({ b, fx: Math.max(rim + FS, Math.min(w - rim - FS, spanOf(b).xr)) - FS, cy: (y(b.lower) + y(b.upper)) / 2 }))
      .sort((a, z) => a.cy - z.cy)
    for (const f of flags) f.cy = Math.max(FS, Math.min(h - FS, f.cy))
    for (let i = 1; i < flags.length; i++) if (flags[i].cy - flags[i - 1].cy < gap) flags[i].cy = flags[i - 1].cy + gap
    for (let i = flags.length - 1; i >= 0; i--) {
      const cap = h - FS - (flags.length - 1 - i) * gap
      if (flags[i].cy > cap) flags[i].cy = cap
    }
    ctx.font = '700 9px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const { b, fx, cy } of flags) {
      const phase = phaseOf(b)
      const inside = price > b.lower && price <= b.upper
      const col = phase === 'won' ? C.up : phase === 'lost' ? C.down : phase === 'settling' ? C.text : inside ? C.up : C.down
      const filled = phase === 'won' || phase === 'lost' || phase === 'settling' || inside
      const a = phase === 'settling' ? pulse : 1
      ctx.fillStyle = filled ? withAlpha(col, 0.92 * a) : 'rgba(0, 0, 0, 0.75)'
      ctx.fillRect(fx, cy - FS / 2, FS, FS)
      ctx.strokeStyle = withAlpha(col, 0.9 * a)
      ctx.lineWidth = 1
      ctx.strokeRect(fx + 0.5, cy - FS / 2 + 0.5, FS - 1, FS - 1)
      ctx.fillStyle = filled ? '#000' : withAlpha(col, 0.95)
      ctx.fillText(String(b.n), fx + FS / 2, cy + 0.5)
    }
    ctx.restore()
  }

  // Aim preview: where your NEXT band lands, a live ±pct bracket around the price (amber, dashed, with a
  // left spine at the now-dot so it reads as a gate about to drop). Distinct from the open lanes; hidden at MAX.
  if (ov?.aim && price > 0 && aimHalf != null) {
    const half = aimHalf
    const top = y(price + half)
    const bot = y(price - half)
    const fx = nowX
    ctx.save()
    // Faint on purpose: with a live stack the amber bracket must read as a preview, never another position.
    ctx.fillStyle = withAlpha(C.brand, 0.03)
    ctx.fillRect(fx, top, w - fx, bot - top)
    ctx.lineWidth = 1.2
    ctx.setLineDash([3, 4])
    ctx.strokeStyle = withAlpha(C.brand, 0.72)
    ctx.beginPath()
    ctx.moveTo(fx, top)
    ctx.lineTo(w, top)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(fx, bot)
    ctx.lineTo(w, bot)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.moveTo(fx, top)
    ctx.lineTo(fx, bot)
    ctx.stroke()
    ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'right'
    ctx.fillStyle = withAlpha(C.brand, 0.95)
    // Inset left of the multiplay flag column so the tag never collides with a band's numbered flag.
    ctx.fillText(ov.aim.tag ?? 'NEXT', w - rim - (ov.bands?.length ? 20 : 2), clampLabelY(top - 8))
    ctx.restore()
  }

  if (ov?.entry != null && entryReveal > 0.01) {
    const ys = y(ov.entry)
    const a = entryReveal
    // Confirming = the mint is still landing on chain (a real ~2-5s wait), so the entry reads as provisional:
    // dashed, dimmer, a soft pulse, and tagged CONFIRMING. It snaps to the solid neutral-white ENTRY reference
    // (amber stays the live now-dot) the instant the position is truly live, so "you entered here" is never faked ahead of the chain.
    const pending = ov?.band?.locked === true && ov.band.confirming === true
    const pulse = pending ? 0.55 + 0.45 * Math.abs(Math.sin(performance.now() / 260)) : 1
    ctx.strokeStyle = withAlpha(C.text, (pending ? 0.3 : 0.42) * a * pulse)
    ctx.lineWidth = 1
    if (pending) ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(0, ys)
    ctx.lineTo(w, ys)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.save()
    ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.fillStyle = withAlpha(C.text, (pending ? 0.7 : 0.85) * a * pulse)
    // Inset off the left rim, flipped below the line when it sits too near the top to label above it.
    const label = pending ? 'CONFIRMING' : 'ENTRY'
    ctx.fillText(`${label} ${formatPrice(ov.entry)}`, rim + 2, clampLabelY(ys - 16 < 4 ? ys + 14 : ys - 9))
    ctx.restore()
  }

  // Target (Lucky): the line the price must cross to win; the winning half shades green and brightens when price is inside, so "am I winning" reads straight off the chart.
  // The line itself is the one amber accent (SCREEN.md). It wipes in left->right as the deal's payoff; ys is always the true strike, only the drawn extent animates (never the price position).
  if (ov?.target != null && targetReveal > 0.01) {
    const { price: tp, side } = ov.target
    const a = targetReveal
    const ys = y(tp)
    // Front-loaded ease so the line "slams" across, then settles; the cubic saturates near full width well before targetReveal does.
    const wipe = w * (1 - Math.pow(1 - Math.min(1, targetReveal), 3))
    const winUp = side === 'up'
    const inWin = winUp ? price > tp : price < tp
    const grad = ctx.createLinearGradient(0, ys, 0, winUp ? 0 : h)
    grad.addColorStop(0, withAlpha(C.up, (inWin ? 0.2 : 0.08) * a))
    grad.addColorStop(1, withAlpha(C.up, 0))
    ctx.fillStyle = grad
    ctx.fillRect(0, winUp ? 0 : ys, wipe, winUp ? ys : h - ys)

    ctx.strokeStyle = withAlpha(C.brand, (inWin ? 1 : 0.78) * a)
    ctx.lineWidth = 1.5
    ctx.setLineDash([5, 4])
    ctx.beginPath()
    ctx.moveTo(0, ys)
    ctx.lineTo(wipe, ys)
    ctx.stroke()
    ctx.setLineDash([])

    // Label holds back until the wipe has crossed, then fades in over the remainder, so it never sits ahead of the line.
    const labelA = Math.max(0, Math.min(1, (targetReveal - 0.6) / 0.4))
    if (labelA > 0.01) {
      ctx.save()
      ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'right'
      ctx.fillStyle = withAlpha(C.brand, 0.95 * labelA)
      // Spells out the move needed in your direction next to the strike, so a target a hair from entry still reads as a real bet, not equal to entry.
      const mv = ov.entry != null && ov.entry > 0 ? ((tp - ov.entry) / ov.entry) * 100 : null
      const mvStr = mv != null ? `  ${mv >= 0 ? '+' : ''}${Math.abs(mv) >= 1 ? mv.toFixed(1) : mv.toFixed(2)}%` : ''
      ctx.fillText(`TARGET ${formatPrice(tp)}${mvStr}`, labelX, clampLabelY(winUp ? ys - 10 : ys + 12))
      ctx.restore()
    }
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

  // RESULT line: the exact oracle settlement_price after settlement lands; green inside the band, red outside.
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

// Apply alpha to a hex or rgb token; canvas needs concrete colors, so resolve tokens at runtime here.
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
