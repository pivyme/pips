// Line Rider engine. A neon trend line scrolls right to left; the player rides a pip on it with the
// thumbwheel. Hug the line and your score climbs (faster the tighter you hug, via a combo multiplier)
// and grip refills; drift off and the combo resets and grip drains; grip hits zero and the run ends.
// Pure score chase: the score only ever goes up, the challenge is surviving the ramp for a big one.
//
// Framework-free on purpose: the field + every bit of juice draw here at 60fps, and only a small
// HUD snapshot is pushed out (throttled) for the DOM overlay. React owns phase + the leaderboard.

export interface RideHud {
  score: number
  multiplier: number // the combo: higher the longer you hug, resets on a slip
  grip: number // 0..1 survival meter
  elapsed: number // seconds into the run
  onLine: boolean
  intensity: number // 0..1 difficulty ramp, surfaced so the audio bed can build with the run
}

export interface RideCallbacks {
  onHud: (hud: RideHud) => void
  onEnd: (finalScore: number) => void
  onMilestone?: (multiplier: number) => void // crossed an integer multiplier (a "level up")
  onRegain?: () => void // snapped back onto the line after a slip
  reduced?: boolean // soften flashes/particles for reduced-motion
}

// --- Tuning. All feel lives here; the rest is plumbing. ---
const PIP_X_FRAC = 0.32 // pip sits here horizontally; line flows in from the right (the future)
const Y_MIN = 0.16 // line stays inside this vertical band (clear of the DOM top bar + readout)
const Y_MAX = 0.84
const PIP_LO = 0.92 // wheel 0 -> pip near bottom, wheel 1 -> pip near top (a touch past the line)
const PIP_HI = 0.08
const SEG_PX = 12 // world spacing between generated line points
const WARMUP_S = 2 // difficulty stays at zero this long so players get the hang of it first
const SPEED0 = 95 // px/s scroll at the start
const SPEED1 = 360 // px/s scroll at full difficulty
const SPEED_CREEP = 6 // px/s added per second once past full ramp (so a run always eventually breaks)
const RAMP_S = 34 // seconds from warmup to full difficulty (was a lazy 110: way too easy)
const BAND0 = 0.08 // on-line tolerance (half-band, normalized) early
const BAND1 = 0.04 // ...and late: tighter, so hugging gets harder
const PIP_TRACK = 16 // how fast the pip eases toward the wheel target (higher = snappier)
const BASE_RATE = 34 // score points per second at x1, hugging the edge
const MULT_RAMP = 0.55 // base multiplier gain per second on-line
const MULT_HUG = 1.5 // extra gain per second when hugging dead-center (skill reward)
const MULT_DECAY = 9 // multiplier lost per second while off-line
const GRIP_REFILL = 0.26 // grip per second regained on-line
const GRIP_DRAIN0 = 0.4 // grip per second lost off-line, early (recoverable while you learn)
const GRIP_DRAIN1 = 1.5 // ...and late: a slip at speed bleeds out fast
const DRAIN_CREEP = 0.02 // extra grip drain per second past full ramp
const GRACE_S = 0.12 // brief forgiveness before grip starts draining after a slip

const COOL = [0x2d, 0xe2, 0xd6] // x1 cyan
const WARM = [0xff, 0xc0, 0x16] // ~x4 amber
const HOT = [0xff, 0x5a, 0x4d] // x8+ hot red

interface Trail {
  x: number
  y: number
  life: number
}
interface Spark {
  x: number
  y: number
  vx: number
  vy: number
  life: number
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

// Heat color for the multiplier: cyan -> amber -> hot red as the streak climbs. Split so the per-frame
// draw can resolve the rgb once and only vary alpha, instead of redoing the lerp math per trail segment.
function heatRgb(mult: number): [number, number, number] {
  const t = clamp01((mult - 1) / 7)
  const [a, b] = t < 0.5 ? [COOL, WARM] : [WARM, HOT]
  const k = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5
  return [
    Math.round(lerp(a[0], b[0], k)),
    Math.round(lerp(a[1], b[1], k)),
    Math.round(lerp(a[2], b[2], k)),
  ]
}

// Exported so the DOM HUD (multiplier, pending) can tint to match the field.
export function heat(mult: number, alpha = 1): string {
  const [r, g, bl] = heatRgb(mult)
  return `rgba(${r},${g},${bl},${alpha})`
}

export class RideEngine {
  private ctx: CanvasRenderingContext2D
  private cb: RideCallbacks
  private raf = 0
  private ro: ResizeObserver | null = null
  private last = 0
  private running = false

  // world / view
  private w = 0
  private h = 0
  private dpr = 1
  private safe = 24 // rim-safe inset (px), fed from --screen-rim

  // line generation (world space, indexed by segment)
  private pts: number[] = [] // normalized y per segment, head-relative
  private head = 0 // world segment index of pts[0]
  private worldX = 0 // px scrolled so far
  private genCur = 0.5
  private genGoal = 0.5
  private segsToGoal = 0

  // play state
  private target = 0.5 // pip target y (normalized), from the wheel
  private pipY = 0.5
  private score = 0
  private mult = 1
  private grip = 1
  private elapsed = 0
  private offFor = 0 // seconds continuously off the line
  private onFor = 0 // seconds continuously on the line
  private onLine = false
  private milestone = 1
  private trail: Trail[] = []
  private sparks: Spark[] = []
  private lastHud = 0

  constructor(canvas: HTMLCanvasElement, cb: RideCallbacks) {
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
    // Rim-safe inset is inherited from the screen layer as a CSS custom prop.
    const rim = parseFloat(getComputedStyle(canvas).getPropertyValue('--screen-rim'))
    this.safe = Number.isFinite(rim) && rim > 0 ? rim : 24
  }

  // The wheel writes the pip's target position. 0 = bottom, 1 = top.
  setTarget(norm: number) {
    this.target = clamp01(norm)
  }

  start() {
    // Seed the line dead flat right where the pip sits, so the run always opens ON the line (never
    // a free death). Clamp into the line's band so the pip and line truly coincide at extremes.
    const startY = Math.max(Y_MIN, Math.min(Y_MAX, lerp(PIP_LO, PIP_HI, this.target)))
    this.pts = []
    this.head = 0
    this.worldX = 0
    this.genCur = startY
    this.genGoal = startY
    this.segsToGoal = 30 // hold flat through the warmup, then the line starts to move
    this.pipY = startY
    this.score = 0
    this.mult = 1
    this.grip = 1
    this.elapsed = 0
    this.offFor = 0
    this.onFor = 0
    this.onLine = true
    this.milestone = 1
    this.trail = []
    this.sparks = []
    this.lastHud = -1 // reset the HUD throttle clock, else a replay (elapsed back to 0) never pushes
    this.running = true
    this.last = performance.now()
    this.fillToWidth()
    this.raf = requestAnimationFrame(this.frame)
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

  // 0..1 ramp, but flat at 0 through the warmup so the opening few seconds stay gentle.
  private difficulty(): number {
    return clamp01((this.elapsed - WARMUP_S) / RAMP_S)
  }

  // Seconds past full difficulty. Drives endless escalation (speed + grip drain) so even a great
  // run eventually breaks, which is what makes a high score worth chasing.
  private over(): number {
    return Math.max(0, this.elapsed - WARMUP_S - RAMP_S)
  }

  // Generate the next segment's y: ease toward a goal, reroll the goal periodically (more often and
  // farther as difficulty rises), with rare sharp spikes late so the line can jab.
  private nextY(): number {
    const d = this.difficulty()
    if (this.segsToGoal <= 0) {
      const spike = d > 0.35 && Math.random() < 0.05 + d * 0.12
      const span = lerp(0.16, 0.52, d) * (spike ? 1.7 : 1)
      const lo = Math.max(Y_MIN, this.genCur - span)
      const hi = Math.min(Y_MAX, this.genCur + span)
      this.genGoal = lo + Math.random() * (hi - lo)
      const base = lerp(16, 3.2, d)
      this.segsToGoal = Math.max(2, Math.round((spike ? base * 0.35 : base) * (0.6 + Math.random() * 0.8)))
    }
    this.segsToGoal--
    const ease = lerp(0.09, 0.3, d)
    this.genCur += (this.genGoal - this.genCur) * ease
    return Math.max(Y_MIN, Math.min(Y_MAX, this.genCur))
  }

  // Keep enough points to cover the visible width plus read-ahead to the right.
  private fillToWidth() {
    const need = Math.ceil(this.w / SEG_PX) + 4
    while (this.pts.length < need) this.pts.push(this.nextY())
  }

  // The line's normalized y at a given screen x (interpolated between the two surrounding points).
  private lineYAt(screenX: number): number {
    const worldPos = (this.worldX + screenX) / SEG_PX
    const i = Math.floor(worldPos - this.head)
    if (i < 0 || i + 1 >= this.pts.length) return this.pts[Math.max(0, Math.min(this.pts.length - 1, i))] ?? 0.5
    const f = worldPos - this.head - i
    return lerp(this.pts[i], this.pts[i + 1], f)
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
    const d = this.difficulty()
    this.elapsed += dt

    // scroll the world; advance head as points leave the left edge
    const speed = lerp(SPEED0, SPEED1, d) + this.over() * SPEED_CREEP
    this.worldX += speed * dt
    while ((this.head + 1) * SEG_PX < this.worldX) {
      this.pts.shift()
      this.head++
    }
    this.fillToWidth()

    // pip eases toward the wheel target
    const targetY = lerp(PIP_LO, PIP_HI, this.target)
    this.pipY += (targetY - this.pipY) * Math.min(1, dt * PIP_TRACK)

    // on the line?
    const pipX = this.w * PIP_X_FRAC
    const lineY = this.lineYAt(pipX)
    const band = lerp(BAND0, BAND1, d)
    const dist = Math.abs(this.pipY - lineY)
    const onLine = dist <= band
    if (onLine && !this.onLine) this.cb.onRegain?.()
    if (onLine) {
      this.onFor += dt
      this.offFor = 0
    } else {
      this.offFor += dt
      this.onFor = 0
    }
    this.onLine = onLine

    if (onLine) {
      const hug = 1 - clamp01(dist / band) // 0 at the band edge, 1 dead-center
      this.mult += dt * (MULT_RAMP + MULT_HUG * hug)
      this.score += dt * BASE_RATE * this.mult * (0.5 + 0.5 * hug)
      this.grip = Math.min(1, this.grip + dt * GRIP_REFILL)
      // perfect-hug sparkle
      if (hug > 0.85 && !this.cb.reduced && Math.random() < dt * 22) {
        this.sparks.push({
          x: pipX,
          y: this.pipY * this.h,
          vx: (Math.random() - 0.5) * 40,
          vy: (Math.random() - 0.5) * 40 - 10,
          life: 1,
        })
      }
    } else {
      this.mult = Math.max(1, this.mult - dt * MULT_DECAY)
      // No grip loss during the warmup: the opening seconds are a free practice window to find
      // the line and get a feel for the wheel, exactly as they should be.
      if (this.offFor > GRACE_S && this.elapsed > WARMUP_S) {
        this.grip -= dt * (lerp(GRIP_DRAIN0, GRIP_DRAIN1, d) + this.over() * DRAIN_CREEP)
      }
    }

    // multiplier "level up" feedback on each integer crossing
    const floor = Math.floor(this.mult)
    if (floor > this.milestone) {
      this.milestone = floor
      this.cb.onMilestone?.(floor)
    } else if (this.mult < this.milestone) {
      this.milestone = Math.max(1, Math.floor(this.mult))
    }

    // trail (ink on the scrolling tape): laid at the pip, drifts left with the world
    this.trail.push({ x: pipX, y: this.pipY * this.h, life: 1 })
    // Drift + fade, then compact in place (a fresh filtered array every frame was needless GC churn).
    let kept = 0
    for (let i = 0; i < this.trail.length; i++) {
      const t = this.trail[i]
      t.x -= speed * dt
      t.life -= dt * 0.7
      if (t.life > 0 && t.x > -20) this.trail[kept++] = t
    }
    this.trail.length = kept

    let liveSparks = 0
    for (let i = 0; i < this.sparks.length; i++) {
      const s = this.sparks[i]
      s.x += s.vx * dt
      s.y += s.vy * dt
      s.vy += 60 * dt
      s.life -= dt * 2.2
      if (s.life > 0) this.sparks[liveSparks++] = s
    }
    this.sparks.length = liveSparks

    this.pushHud()

    if (this.grip <= 0) {
      this.grip = 0
      this.running = false
      cancelAnimationFrame(this.raf)
      this.draw() // final frame
      this.cb.onEnd(this.score)
    }
  }

  private pushHud(force = false) {
    const now = this.elapsed
    if (!force && now - this.lastHud < 0.05) return // throttle DOM updates to ~20Hz
    this.lastHud = now
    this.cb.onHud({
      score: this.score,
      multiplier: this.mult,
      grip: this.grip,
      elapsed: this.elapsed,
      onLine: this.onLine,
      intensity: this.difficulty(),
    })
  }

  private draw() {
    const ctx = this.ctx
    const { w, h } = this
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)

    const pipX = w * PIP_X_FRAC
    const d = this.difficulty()
    const band = lerp(BAND0, BAND1, d)
    // Resolve the heat color once per frame; build only the varying alpha per use (hc). Was a full
    // lerp+round per trail segment per frame.
    const [hr, hg, hb] = heatRgb(this.mult)
    const hc = (a: number) => `rgba(${hr},${hg},${hb},${a})`
    const hue = hc(1)

    // faint vertical "now" guide at the pip
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(pipX, 0)
    ctx.lineTo(pipX, h)
    ctx.stroke()

    // tolerance band around the line (this is what makes it readable: you can SEE "on")
    const step = 6
    ctx.beginPath()
    for (let x = 0; x <= w; x += step) {
      const y = this.lineYAt(x) * h
      if (x === 0) ctx.moveTo(x, y - band * h)
      else ctx.lineTo(x, y - band * h)
    }
    for (let x = w; x >= 0; x -= step) {
      const y = this.lineYAt(x) * h
      ctx.lineTo(x, y + band * h)
    }
    ctx.closePath()
    ctx.fillStyle = hc(0.07)
    ctx.fill()

    // The trend line, glowing, heat-colored. Layered translucent strokes fake the neon halo: a wide
    // faint pass, a mid pass, then the crisp bright core, all the same hue. This replaces a per-frame
    // shadowBlur (a full-width gaussian blur every frame, the line-rider stutter). The halo still
    // flares with the multiplier the way the old blur radius did.
    const flare = Math.min(1, this.mult / 10) // mirrors the old 12->30px blur ramp
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.beginPath()
    for (let x = 0; x <= w; x += step) {
      const y = this.lineYAt(x) * h
      if (x === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.strokeStyle = hc(0.12 + 0.1 * flare)
    ctx.lineWidth = 9 + 7 * flare
    ctx.stroke()
    ctx.strokeStyle = hc(0.3 + 0.12 * flare)
    ctx.lineWidth = 5
    ctx.stroke()
    ctx.strokeStyle = hue
    ctx.lineWidth = 2.4
    ctx.stroke()

    // trail
    if (this.trail.length > 1) {
      ctx.lineWidth = 3
      ctx.lineCap = 'round'
      for (let i = 1; i < this.trail.length; i++) {
        const a = this.trail[i - 1]
        const b = this.trail[i]
        ctx.strokeStyle = hc(0.5 * b.life)
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
    }

    // sparks
    for (const s of this.sparks) {
      ctx.fillStyle = `rgba(255,255,255,${s.life})`
      ctx.fillRect(s.x - 1, s.y - 1, 2, 2)
    }

    // the pip
    const py = this.pipY * h
    ctx.save()
    ctx.shadowColor = hue
    ctx.shadowBlur = this.onLine ? 22 : 8
    ctx.fillStyle = this.onLine ? '#fff' : hue
    ctx.beginPath()
    ctx.arc(pipX, py, this.onLine ? 6 : 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    // lock ring when riding
    if (this.onLine) {
      ctx.strokeStyle = hc(0.6)
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(pipX, py, 11, 0, Math.PI * 2)
      ctx.stroke()
    }

    // grip bar, vertical on the rim-safe left edge; reds out and the field vignettes when low
    const gx = this.safe * 0.5
    const gTop = this.safe
    const gH = h - this.safe * 2
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.fillRect(gx, gTop, 4, gH)
    const low = this.grip < 0.28
    ctx.fillStyle = low ? '#ff5a4d' : hc(0.9)
    ctx.fillRect(gx, gTop + gH * (1 - this.grip), 4, gH * this.grip)

    if (low && !this.cb.reduced) {
      const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 12)
      const a = ((0.28 - this.grip) / 0.28) * 0.5 * pulse
      const g = ctx.createRadialGradient(w / 2, h / 2, h * 0.25, w / 2, h / 2, h * 0.75)
      g.addColorStop(0, 'rgba(255,90,77,0)')
      g.addColorStop(1, `rgba(255,90,77,${a})`)
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
    }
  }
}
