import { useEffect, useRef, useState } from 'react'
import { streamPrices, type PriceTick } from '@/lib/api'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { cnm } from '@/utils/style'

// The single most important "feel" component. One canvas, one rAF loop reading refs. React
// never re-renders on a price tick. The line glides toward each ~1s SSE tick (interpolated,
// never stepped) while the x-axis scrolls continuously so motion never stalls between ticks.
// Reduced motion swaps to discrete, tick-driven redraws with no continuous scroll.

export interface ChartBox {
  lower: number
  upper: number
  tint?: 'up' | 'down' | 'neutral'
}

export interface ChartOverlays {
  strike?: number
  band?: { lower: number; upper: number }
  boxes?: ChartBox[]
}

interface ChartProps {
  asset: string
  overlays?: ChartOverlays
  height?: number
  className?: string
  onPrice?: (price: number) => void
  onError?: () => void
}

const WINDOW_MS = 30_000 // visible time span on the continuous axis
const MAX_VISIBLE = 48 // points kept for the discrete (reduced-motion) axis
const SMOOTH = 0.15 // leading-edge ease toward the latest tick
const RANGE_SMOOTH = 0.1 // vertical auto-fit ease
const TAU = Math.PI * 2
const TOP_PAD = 18
const BOT_PAD = 18

type Point = { t: number; p: number }

function readColor(name: string): string {
  if (typeof window === 'undefined') return '#ffffff'
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || '#ffffff'
}

export function Chart({ asset, overlays, height = 220, className, onPrice, onError }: ChartProps) {
  const reduced = useReducedMotion()
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [hasData, setHasData] = useState(false)

  // Mutable render state, read by the draw loop. Never triggers React re-renders.
  const points = useRef<Point[]>([])
  const target = useRef<number>(0)
  const display = useRef<number>(0)
  const range = useRef<{ min: number; max: number }>({ min: 0, max: 1 })
  const overlaysRef = useRef<ChartOverlays | undefined>(overlays)
  const reducedRef = useRef(reduced)
  const sizeRef = useRef<{ w: number; h: number }>({ w: 0, h: height })
  const onPriceRef = useRef(onPrice)

  overlaysRef.current = overlays
  reducedRef.current = reduced
  onPriceRef.current = onPrice

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

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
      const h = height
      sizeRef.current = { w, h }
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (reducedRef.current) paint(performance.now())
    }
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)
    resize()

    const targetRange = (now: number): { min: number; max: number } => {
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
      const ov = overlaysRef.current
      if (ov?.strike != null) consider(ov.strike)
      if (ov?.band) {
        consider(ov.band.lower)
        consider(ov.band.upper)
      }
      if (ov?.boxes) {
        for (const b of ov.boxes) {
          consider(b.lower)
          consider(b.upper)
        }
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        const base = target.current || 1
        return { min: base * 0.999, max: base * 1.001 }
      }
      const span = hi - lo
      const pad = span > 0 ? span * 0.18 : Math.max(Math.abs(hi) * 0.001, 0.5)
      return { min: lo - pad, max: hi + pad }
    }

    const paint = (now: number) => {
      const { w, h } = sizeRef.current
      if (w === 0) return
      const continuous = !reducedRef.current
      const hasBoxes = Boolean(overlaysRef.current?.boxes?.length)
      const nowX = hasBoxes ? w * 0.58 : w * 0.92

      // Vertical auto-fit, eased so the frame breathes instead of jumping.
      const tr = targetRange(now)
      const r = range.current
      if (continuous) {
        r.min += (tr.min - r.min) * RANGE_SMOOTH
        r.max += (tr.max - r.max) * RANGE_SMOOTH
      } else {
        r.min = tr.min
        r.max = tr.max
      }
      const span = r.max - r.min || 1
      const plotH = h - TOP_PAD - BOT_PAD
      const y = (p: number) => TOP_PAD + (r.max - p) / span * plotH

      ctx.clearRect(0, 0, w, h)

      const pts = points.current
      const yDisp = y(display.current)

      // Overlays sit under the line.
      drawOverlays(ctx, overlaysRef.current, { w, nowX, y, C })

      // Build the visible line. Continuous: x by real time. Reduced: x by index step.
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

      // Direction tint over the visible window: green if we are up vs the oldest visible point.
      const ref = path.length > 1 ? path[0].y : yDisp
      const lineColor = yDisp <= ref ? C.up : C.down

      if (path.length > 1) {
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.lineWidth = 2
        ctx.strokeStyle = lineColor
        ctx.beginPath()
        ctx.moveTo(path[0].x, path[0].y)
        for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y)
        ctx.stroke()
      }

      // Leading edge: amber "now" dot with a soft glow that breathes (still in reduced motion).
      ctx.save()
      ctx.shadowColor = C.brand
      ctx.shadowBlur = continuous ? 12 + 4 * Math.sin(now / 320) : 8
      ctx.fillStyle = C.brand
      ctx.beginPath()
      ctx.arc(nowX, yDisp, 3.5, 0, TAU)
      ctx.fill()
      ctx.restore()
    }

    let raf = 0
    const loop = (now: number) => {
      const d = display.current
      display.current = d + (target.current - d) * SMOOTH
      paint(now)
      raf = requestAnimationFrame(loop)
    }

    const onTick = (tick: PriceTick) => {
      const p = parseFloat(tick.price)
      if (!Number.isFinite(p)) return
      if (!hasData) {
        // First price seeds the view so the line starts flat instead of sweeping in.
        display.current = p
        range.current = { min: p * 0.999, max: p * 1.001 }
        setHasData(true)
      }
      target.current = p
      points.current.push({ t: performance.now(), p })
      if (points.current.length > 600) points.current.splice(0, points.current.length - 600)
      onPriceRef.current?.(p)
      if (reducedRef.current) {
        display.current = p
        paint(performance.now())
      }
    }

    const unsub = streamPrices(asset, onTick, onError)
    if (!reduced) raf = requestAnimationFrame(loop)

    return () => {
      unsub()
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
    }
    // Re-subscribe + restart the loop on asset or motion-mode change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset, reduced, height])

  // Reset the series when the asset changes so a stale line never flashes.
  useEffect(() => {
    points.current = []
    setHasData(false)
  }, [asset])

  return (
    <div ref={wrapRef} className={cnm('relative w-full', className)} style={{ height }}>
      <canvas ref={canvasRef} className="block h-full w-full" />
      {!hasData && (
        <div className="shimmer pointer-events-none absolute inset-x-3 top-1/2 h-px -translate-y-1/2 rounded-full" />
      )}
    </div>
  )
}

function drawOverlays(
  ctx: CanvasRenderingContext2D,
  ov: ChartOverlays | undefined,
  ctxv: { w: number; nowX: number; y: (p: number) => number; C: Record<string, string> },
) {
  if (!ov) return
  const { w, nowX, y, C } = ctxv

  if (ov.band) {
    const top = y(ov.band.upper)
    const bot = y(ov.band.lower)
    ctx.fillStyle = withAlpha(C.brand, 0.1)
    ctx.fillRect(0, top, w, bot - top)
    ctx.strokeStyle = withAlpha(C.brand, 0.5)
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(0, top)
    ctx.lineTo(w, top)
    ctx.moveTo(0, bot)
    ctx.lineTo(w, bot)
    ctx.stroke()
    ctx.setLineDash([])
  }

  if (ov.strike != null) {
    const ys = y(ov.strike)
    ctx.strokeStyle = withAlpha(C.brand, 0.7)
    ctx.lineWidth = 1
    ctx.setLineDash([5, 5])
    ctx.beginPath()
    ctx.moveTo(0, ys)
    ctx.lineTo(w, ys)
    ctx.stroke()
    ctx.setLineDash([])
  }

  if (ov.boxes?.length) {
    for (const b of ov.boxes) {
      const top = y(b.upper)
      const bot = y(b.lower)
      const tint = b.tint === 'up' ? C.up : b.tint === 'down' ? C.down : C.text
      ctx.fillStyle = withAlpha(tint, 0.08)
      ctx.fillRect(nowX, top, w - nowX, bot - top)
      ctx.strokeStyle = withAlpha(tint, 0.35)
      ctx.lineWidth = 1
      ctx.strokeRect(nowX + 0.5, top + 0.5, w - nowX - 1, bot - top - 1)
    }
  }
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
