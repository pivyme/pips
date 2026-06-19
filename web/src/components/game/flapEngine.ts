// Candle Hop engine. A one-button flappy: an amber pip flies through the gaps between
// candlesticks that scroll right to left. Tap to flap (a kick upward), gravity pulls it back
// down. Clear a gap and the score ticks up; clip a candle, the ceiling or the floor and the run
// ends, straight into the leaderboard. Pure score chase, no chain, no funds.
//
// Framework-free on purpose, same as the line rider: the field draws here at 60fps and only a
// small HUD snapshot is pushed out for the DOM overlay. React owns phase + the leaderboard.

export interface FlapHud {
  score: number
  elapsed: number
  alive: boolean
}

export interface FlapCallbacks {
  onHud: (hud: FlapHud) => void
  onEnd: (finalScore: number) => void
  onScore?: (score: number) => void // cleared a candle gap (a satisfying tick)
  reduced?: boolean // soften the trail / parallax for reduced-motion
}

// --- Tuning. All feel lives here; the rest is plumbing. ---
const PIP_X_FRAC = 0.3 // pip sits here horizontally; candles flow in from the right
const PIP_R = 6 // pip radius (px), also the collision radius
const GRAVITY = 2.5 // downward pull, normalized-height units per s^2
const FLAP_V = -0.82 // vertical velocity (norm/s) set on each flap (negative = up)
const VY_MAX = 1.35 // terminal fall speed so a long drop never gets silly-fast
const SPEED0 = 150 // px/s scroll at the start
const SPEED1 = 290 // px/s scroll at full difficulty
const RAMP_S = 45 // seconds from start to full difficulty
const SPEED_CREEP = 5 // px/s added per second past full ramp (a run always eventually breaks)
const SPACING0 = 215 // px between candle centers, early (roomy)
const SPACING1 = 178 // ...and late (tighter)
const BODY_W = 30 // candle body width (px)
const WICK = 15 // how far the wick pokes into the gap (px)
const GAP0 = 0.21 // half-gap (normalized height) early
const GAP1 = 0.135 // ...and late: threading gets harder
const GAP_EDGE = 0.06 // keep both candles present: gap center stays this far inside its own half
const GAP_STEP = 0.34 // max gap-center move between consecutive candles (keeps it fair)
const LEAD_FRAC = 0.55 // first candle sits this fraction of a screen-width past the right edge

const AMBER = '#FFC016'
const RED = [0xff, 0x5a, 0x4d] // top candles: bearish red
const GREEN = [0x34, 0xd3, 0x99] // bottom candles: bullish green

interface Candle {
  x: number // center x, px (scrolls left)
  center: number // gap center, normalized y
  half: number // gap half-height, normalized
  scored: boolean
}

interface Trail {
  x: number
  y: number
  life: number
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const rgba = (c: number[], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`

export class FlapEngine {
  private ctx: CanvasRenderingContext2D
  private cb: FlapCallbacks
  private raf = 0
  private ro: ResizeObserver | null = null
  private last = 0
  private running = false

  // view
  private w = 0
  private h = 0
  private dpr = 1

  // play state
  private pipY = 0.42 // normalized
  private vy = 0
  private score = 0
  private elapsed = 0
  private candles: Candle[] = []
  private spawnX = 0 // x at which the next candle drops in (tracks the world)
  private lastCenter = 0.42
  private parallax = 0 // scrolling offset for the faint background grid
  private trail: Trail[] = []
  private dead = 0 // >0 while the death flash plays out on the final frame
  private lastHud = 0

  constructor(canvas: HTMLCanvasElement, cb: FlapCallbacks) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    this.cb = cb
    this.measure(canvas)
    this.ro = new ResizeObserver(() => this.measure(canvas))
    this.ro.observe(canvas)
  }

  private measure(canvas: HTMLCanvasElement) {
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    this.dpr = Math.min(2, window.devicePixelRatio || 1)
    this.w = rect.width
    this.h = rect.height
    canvas.width = Math.round(this.w * this.dpr)
    canvas.height = Math.round(this.h * this.dpr)
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    if (!this.running) this.draw() // keep the idle frame painted behind the title overlay
  }

  start() {
    this.pipY = 0.42
    this.vy = 0
    this.score = 0
    this.elapsed = 0
    this.candles = []
    this.lastCenter = 0.42
    this.trail = []
    this.dead = 0
    this.lastHud = -1 // reset the HUD throttle clock so a replay pushes from frame one
    this.spawnX = this.w + this.w * LEAD_FRAC // runway before the first candle
    this.fillCandles()
    this.running = true
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
  }

  // The one input: a kick upward. Ignored unless a run is live.
  flap() {
    if (!this.running) return
    this.vy = FLAP_V
    if (!this.cb.reduced) this.trail.push({ x: this.w * PIP_X_FRAC, y: this.pipY * this.h, life: 1 })
  }

  stop() {
    this.running = false
    cancelAnimationFrame(this.raf)
  }

  destroy() {
    this.stop()
    this.ro?.disconnect()
    this.ro = null
  }

  private difficulty(): number {
    return clamp01(this.elapsed / RAMP_S)
  }

  private over(): number {
    return Math.max(0, this.elapsed - RAMP_S)
  }

  private spacing(): number {
    return lerp(SPACING0, SPACING1, this.difficulty())
  }

  // Pick the next gap center, near the last one (fair, readable) and clamped so both candles
  // always stay on screen.
  private nextCenter(half: number): number {
    const lo = half + GAP_EDGE
    const hi = 1 - half - GAP_EDGE
    let c = this.lastCenter + (Math.random() * 2 - 1) * GAP_STEP
    c = Math.max(lo, Math.min(hi, c))
    this.lastCenter = c
    return c
  }

  // Keep candles queued out to just past the right edge.
  private fillCandles() {
    const half = lerp(GAP0, GAP1, this.difficulty())
    while (this.spawnX < this.w + this.spacing()) {
      this.candles.push({ x: this.spawnX, center: this.nextCenter(half), half, scored: false })
      this.spawnX += this.spacing()
    }
  }

  private frame = (now: number) => {
    if (!this.running) return
    let dt = (now - this.last) / 1000
    this.last = now
    if (dt > 0.05) dt = 0.05 // clamp big stalls (tab switch) so the sim never lurches
    this.step(dt)
    this.draw()
    if (this.running) this.raf = requestAnimationFrame(this.frame)
  }

  private step(dt: number) {
    this.elapsed += dt
    const speed = lerp(SPEED0, SPEED1, this.difficulty()) + this.over() * SPEED_CREEP

    // gravity + integrate the pip
    this.vy = Math.min(VY_MAX, this.vy + GRAVITY * dt)
    this.pipY += this.vy * dt
    this.parallax = (this.parallax + speed * 0.4 * dt) % 64

    // scroll candles in; recycle the ones that leave the left edge
    this.spawnX -= speed * dt
    for (const c of this.candles) c.x -= speed * dt
    while (this.candles.length && this.candles[0].x < -BODY_W) this.candles.shift()
    this.fillCandles()

    // trail drifts with the field and fades
    for (const t of this.trail) {
      t.x -= speed * dt
      t.life -= dt * 1.6
    }
    this.trail = this.trail.filter((t) => t.life > 0 && t.x > -20)

    // score: a candle whose body has fully passed the pip
    const pipX = this.w * PIP_X_FRAC
    for (const c of this.candles) {
      if (!c.scored && c.x + BODY_W / 2 < pipX) {
        c.scored = true
        this.score++
        this.cb.onScore?.(this.score)
      }
    }

    this.pushHud()

    // collisions: ceiling clamps (a forgiving bonk), floor and candles are fatal
    const rNorm = PIP_R / this.h
    if (this.pipY < rNorm) {
      this.pipY = rNorm
      this.vy = 0
    }
    if (this.pipY > 1 - rNorm) {
      this.die()
      return
    }
    const rx = BODY_W / 2 + PIP_R
    for (const c of this.candles) {
      if (Math.abs(c.x - pipX) > rx) continue
      const top = c.center - c.half
      const bottom = c.center + c.half
      if (this.pipY - rNorm < top || this.pipY + rNorm > bottom) {
        this.die()
        return
      }
    }
  }

  private die() {
    this.running = false
    cancelAnimationFrame(this.raf)
    this.dead = 1
    this.pushHud(true)
    this.draw() // final frame carries the death flash
    this.cb.onEnd(this.score)
  }

  private pushHud(force = false) {
    if (!force && this.elapsed - this.lastHud < 0.05) return // throttle DOM updates to ~20Hz
    this.lastHud = this.elapsed
    this.cb.onHud({ score: this.score, elapsed: this.elapsed, alive: this.running })
  }

  private draw() {
    const ctx = this.ctx
    const { w, h } = this
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)

    // faint scrolling grid for a sense of motion (the still chrome the data slides over)
    if (!this.cb.reduced) {
      ctx.strokeStyle = 'rgba(255,255,255,0.035)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let x = -this.parallax; x <= w; x += 64) {
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
      }
      ctx.stroke()
    }

    // ceiling + floor hairlines bound the field
    ctx.strokeStyle = 'rgba(255,255,255,0.16)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, 0.5)
    ctx.lineTo(w, 0.5)
    ctx.moveTo(0, h - 0.5)
    ctx.lineTo(w, h - 0.5)
    ctx.stroke()

    // candles: top hangs down (red), bottom rises (green), each with a wick poking into the gap
    for (const c of this.candles) {
      const topY = (c.center - c.half) * h
      const botY = (c.center + c.half) * h
      this.drawCandle(c.x, 0, topY, RED, +1)
      this.drawCandle(c.x, botY, h, GREEN, -1)
    }

    // trail: a short amber streak behind the pip
    for (const t of this.trail) {
      ctx.fillStyle = rgba([0xff, 0xc0, 0x16], 0.5 * t.life)
      ctx.beginPath()
      ctx.arc(t.x, t.y, 3 * t.life + 1, 0, Math.PI * 2)
      ctx.fill()
    }

    // the pip
    const pipX = w * PIP_X_FRAC
    const py = this.pipY * h
    ctx.save()
    ctx.shadowColor = AMBER
    ctx.shadowBlur = 18
    ctx.fillStyle = AMBER
    ctx.beginPath()
    ctx.arc(pipX, py, PIP_R, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()

    // death flash: a red wash on the final frame
    if (this.dead > 0) {
      ctx.fillStyle = rgba(RED, 0.28)
      ctx.fillRect(0, 0, w, h)
    }
  }

  // One candlestick: a filled body with a 2px outline (the schematic line-art read), plus a wick
  // line poking `dir` (down for a top candle, up for a bottom one) toward the gap.
  private drawCandle(cx: number, top: number, bottom: number, color: number[], dir: number) {
    const ctx = this.ctx
    const x = cx - BODY_W / 2
    const hgt = bottom - top
    if (hgt <= 0) return
    ctx.fillStyle = rgba(color, 0.15)
    ctx.fillRect(x, top, BODY_W, hgt)
    ctx.strokeStyle = rgba(color, 0.95)
    ctx.lineWidth = 2
    ctx.strokeRect(x + 1, top, BODY_W - 2, hgt)
    // wick: from the body edge that faces the gap, poking into it
    const wickFrom = dir > 0 ? bottom : top
    ctx.beginPath()
    ctx.moveTo(cx, wickFrom)
    ctx.lineTo(cx, wickFrom + dir * WICK)
    ctx.lineWidth = 3
    ctx.stroke()
  }
}
