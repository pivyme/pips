// Line splash: short bursts of hairlines thrown off the device, minimal and fast. Fires on a skin
// pick today; the same call drops onto any hardware press later (`lineSplash({ x, y })`).
// One 2D canvas, rAF only while lines are alive, backing store released the moment it drains.
import { useEffect, useRef } from 'react'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { cnm } from '@/utils/style'
import { luminance } from './customize'

// App and studio each mount their own device, so each publishes its own box and its own layer.
export type SplashSource = 'app' | 'studio'

// ConsoleCanvas projects the device silhouette here so a scattered burst lands on the hardware, not
// the empty bench, plus an anchor per physical part (PLAY, the action caps, the knob) so a part pick
// bursts on the thing it changed. Coords are local to `el` (the canvas root), converted at fire time.
export type SplashAnchor = { x: number; y: number; rx: number; ry: number }
type DeviceBox = {
  el: HTMLElement
  x: number
  y: number
  w: number
  h: number
  parts?: Record<string, SplashAnchor[]>
}
const deviceBoxes: Partial<Record<SplashSource, DeviceBox>> = {}

export function setSplashDeviceBox(source: SplashSource, box: DeviceBox | null) {
  if (box) deviceBoxes[source] = box
  else delete deviceBoxes[source]
}

export type SplashOpts = {
  source?: SplashSource
  x?: number // viewport px. Omit both and the bursts scatter across the device instead.
  y?: number
  part?: string // a published part anchor ('play' | 'buttons' | 'knob' | 'glow' | 'wheel'); wins over the scatter
  colors?: string[]
  bursts?: number
  power?: number // scales reach + line count, 1 = default
}

const layers = new Map<SplashSource, (o: SplashOpts) => void>()

export function lineSplash(opts: SplashOpts = {}) {
  layers.get(opts.source ?? 'app')?.(opts)
}

type Line = {
  x: number
  y: number
  cos: number
  sin: number
  r0: number // gap between the origin and the line's tail, so nothing starts on the point itself
  reach: number
  w: number
  alpha: number
  color: string
  halo: string
  born: number
  life: number
}

const TAU = Math.PI * 2
const MAX_LINES = 200
// Hard out, so the streak is already decelerating by the time the eye finds it.
const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -9 * t))
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// The device is cream body, black screen and dark bench all at once, so no single colour reads
// everywhere: a dark skin vanishes on the screen, a light one vanishes on the shell. Every spoke is
// drawn as a pair, bright colour over its opposite, so one half of it always has something to sit on.
const haloFor = (color: string) =>
  luminance(color) > 0.5 ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.6)'

export function LineSplashLayer({
  source = 'app',
  className,
}: {
  source?: SplashSource
  className?: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const reduced = useReducedMotion()

  useEffect(() => {
    if (reduced) return
    const cv = ref.current
    const ctx = cv?.getContext('2d')
    if (!cv || !ctx) return

    const lines: Line[] = []
    let raf = 0
    let cssW = 0
    let cssH = 0

    // Sized on demand and dropped back to 0x0 when the last line dies: an idle full-stage canvas at
    // DPR 2 is a few MB of backing store sitting there for an effect that runs for half a second.
    const sizeCanvas = () => {
      const r = cv.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      cssW = r.width
      cssH = r.height
      cv.width = Math.round(r.width * dpr)
      cv.height = Math.round(r.height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      return r
    }
    const release = () => {
      cv.width = 0
      cv.height = 0
      cssW = 0
      cssH = 0
    }

    const step = (now: number) => {
      raf = 0
      ctx.clearRect(0, 0, cssW, cssH)
      // Plain alpha, not additive: additive hairlines vanish over a cream body, and half the skins are light.
      ctx.lineCap = 'round'
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i]
        const t = (now - l.born) / l.life
        if (t >= 1) {
          lines.splice(i, 1)
          continue
        }
        if (t <= 0) continue // still staggered out
        // The tail leaves late and eases on the same curve, so the line stretches out of the origin
        // and collapses into its own head instead of sliding along at a fixed length.
        const head = l.r0 + l.reach * easeOutExpo(t)
        const tail = l.r0 + l.reach * easeOutExpo(Math.max(0, (t - 0.26) / 0.74))
        const x0 = l.x + l.cos * tail
        const y0 = l.y + l.sin * tail
        const x1 = l.x + l.cos * head
        const y1 = l.y + l.sin * head
        ctx.globalAlpha = l.alpha * (t < 0.06 ? t / 0.06 : Math.pow(1 - t, 1.2))
        ctx.beginPath()
        ctx.moveTo(x0, y0)
        ctx.lineTo(x1, y1)
        ctx.strokeStyle = l.halo
        ctx.lineWidth = l.w + 2.4
        ctx.stroke()
        ctx.strokeStyle = l.color
        ctx.lineWidth = l.w
        ctx.stroke()
      }
      ctx.globalAlpha = 1
      if (lines.length) raf = requestAnimationFrame(step)
      else release()
    }

    const fire = (o: SplashOpts) => {
      const rect = cssW ? cv.getBoundingClientRect() : sizeCanvas()
      if (rect.width < 40 || rect.height < 40) return

      // The device's live projected geometry, in this canvas's space.
      const box = deviceBoxes[source]
      const br = box ? box.el.getBoundingClientRect() : null
      const dx = br ? br.left - rect.left : 0
      const dy = br ? br.top - rect.top : 0

      const point = o.x !== undefined && o.y !== undefined
      const power = o.power ?? 1
      const colors = o.colors?.length ? o.colors : ['#ffffff']
      const u = Math.min(rect.width, rect.height)
      const now = performance.now()

      // Where the bursts land. rx/ry is the hole in the middle: on a part it is the control's own
      // projected shape, so the spokes ring the knob or the PLAY cap instead of stabbing through it.
      const spots: Array<{ x: number; y: number; span: number; rx: number; ry: number; spokes?: number }> = []
      const anchors = o.part && box?.parts ? box.parts[o.part] : undefined
      const dot = u * 0.013
      if (point) {
        spots.push({
          x: (o.x as number) - rect.left,
          y: (o.y as number) - rect.top,
          span: u * 0.055 * power,
          rx: dot,
          ry: dot,
        })
      } else if (anchors?.length) {
        for (const a of anchors) {
          if (a.rx <= 0 || a.ry <= 0) continue
          const ratio = Math.max(a.rx / a.ry, a.ry / a.rx)
          spots.push({
            x: dx + a.x,
            y: dy + a.y,
            // Sized off the control, not the stage: a zoomed-in knob gets a bigger ring than a
            // thumbnail-sized action cap, which is what makes it read as belonging to that part.
            span: clamp(Math.sqrt(a.rx * a.ry) * 0.45 * power, u * 0.035, u * 0.14),
            rx: a.rx * 1.08,
            ry: a.ry * 1.08,
            // A long control (the drum) needs more spokes or the ring reads as four stray ticks.
            spokes: ratio > 1.8 ? 8 : undefined,
          })
        }
        // A lone control (PLAY, the knob) gets one wider echo, so it still reads as a burst, not a ring.
        if (spots.length === 1) {
          const s = spots[0]
          spots.push({ ...s, span: s.span * 1.25, rx: s.rx * 1.14, ry: s.ry * 1.14 })
        }
      }
      // Scatter is also the fallback: a part whose anchor has not been projected yet (the canvas
      // never placed its camera) must still splash somewhere rather than silently do nothing.
      if (!spots.length) {
        // One burst per band down the device, not three dice rolls: pure random clusters them in a
        // corner often enough that the whole thing reads as "sometimes it works".
        const n = o.bursts ?? 3
        const bx = box ? dx + box.x : rect.width * 0.25
        const by = box ? dy + box.y : rect.height * 0.2
        const bw = box ? box.w : rect.width * 0.5
        const bh = box ? box.h : rect.height * 0.5
        for (let b = 0; b < n; b++) {
          spots.push({
            x: bx + bw * (0.14 + Math.random() * 0.72),
            y: by + bh * ((b + 0.2 + Math.random() * 0.6) / n),
            span: u * (0.045 + Math.random() * 0.025) * power,
            rx: dot,
            ry: dot,
          })
        }
      }

      // One burst per beat, not a shower: a few deliberate marks read cool, a dozen overlapping ones
      // read like static.
      const w0 = clamp(u * 0.006, 2, 3.2)
      spots.forEach((s, b) => {
        const delay = b * (52 + Math.random() * 26)
        const n = s.spokes ?? 5 + ((Math.random() * 2) | 0) // 5 or 6
        const base = Math.random() * TAU
        const color = colors[(Math.random() * colors.length) | 0]
        const halo = haloFor(color)
        for (let i = 0; i < n; i++) {
          const a = base + (i / n) * TAU + (Math.random() - 0.5) * (TAU / n) * 0.22
          const cos = Math.cos(a)
          const sin = Math.sin(a)
          lines.push({
            x: s.x,
            y: s.y,
            cos,
            sin,
            // Start on the control's outline, not on a circle around it, so a tall drum and a square
            // cap both get an even margin.
            r0: (s.rx * s.ry) / Math.hypot(s.ry * cos, s.rx * sin),
            // Lines inside a burst stay near the same length; the burst is the shape, not each spoke.
            reach: s.span * (0.86 + Math.random() * 0.28),
            w: w0 + Math.random() * 0.5,
            alpha: 0.9 + Math.random() * 0.1,
            color,
            halo,
            born: now + delay,
            life: 250 + Math.random() * 80,
          })
        }
      })

      if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
      if (!raf) raf = requestAnimationFrame(step)
    }

    layers.set(source, fire)
    // A live burst is half a second long, so a mid-flight resize just re-sizes and keeps going.
    const ro = new ResizeObserver(() => {
      if (cssW) sizeCanvas()
    })
    ro.observe(cv)

    return () => {
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
      if (layers.get(source) === fire) layers.delete(source)
      lines.length = 0
      release()
    }
  }, [source, reduced])

  return (
    <canvas
      ref={ref}
      aria-hidden
      className={cnm('pointer-events-none absolute inset-0 h-full w-full', className)}
    />
  )
}
