// Flappy Piper: one-button flappy, tap to flap through gaps in scrolling candlesticks, pure score chase, no chain, no funds.
// Framework-free like the line rider: draws at 60fps here, pushes only a HUD snapshot out to React, which owns phase and the leaderboard.

export interface FlapHud {
  score: number
  elapsed: number
  alive: boolean
}

export interface FlapCallbacks {
  onHud: (hud: FlapHud) => void
  onEnd: (finalScore: number) => void
  onScore?: (score: number) => void // cleared a candle gap (a satisfying tick)
  onCrash?: () => void
  reduced?: boolean // soften the trail / parallax for reduced-motion
}

// --- Tuning. All feel lives here; the rest is plumbing. ---
const BIRD_X_FRAC = 0.28 // character sits here horizontally; candles flow in from the right
const BIRD_H = 64
const BIRD_W = BIRD_H * (395 / 567) // native pips-white.svg aspect ratio
const BIRD_HIT_X = 16 // forgiving hitbox inside the wide top of the P
const BIRD_HIT_Y = 23
const GRAVITY = 5.6 // fast Flappy-style pull, normalized-height units per s^2
const FLAP_V = -1.42 // short, hard upward kick on every press
const VY_MAX = 2.65
const ROTATION_RESPONSE = 9
const SPEED0 = 138 // brisk world movement, eased slightly from the previous pass
const SPEED1 = 172
const RAMP_S = 48
const SPACING0 = 190
const SPACING1 = 165
const BODY_W = 30 // candle body width (px)
const WICK = 15 // how far the wick pokes into the gap (px)
const GAP0 = 0.205 // half-gap (normalized height) early
const GAP1 = 0.145 // ...and late: the larger character makes this meaningfully tight
const GAP_EDGE = 0.06 // keep both candles present: gap center stays this far inside its own half
const GAP_STEP = 0.28 // max gap-center move between consecutive candles (challenging but readable)
const LEAD_FRAC = 0.12 // a short runway before the first candle
const DEATH_GRAVITY = 7.2
const DEATH_VY_MAX = 3.2
const DEATH_MIN_S = 0.5
const DEATH_MAX_S = 0.9
const SHAKE_S = 0.34

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
const rgba = (c: ReadonlyArray<number>, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`

export class FlapEngine {
  private ctx: CanvasRenderingContext2D
  private cb: FlapCallbacks
  private bird: HTMLImageElement
  private birdReady = false
  private raf = 0
  private ro: ResizeObserver | null = null
  private last = 0
  private running = false
  private dying = false

  // view
  private w = 0
  private h = 0
  private dpr = 1

  // play state
  private birdY = 0.42 // normalized
  private birdOffsetX = 0
  private birdAngle = -0.35
  private vy = 0
  private score = 0
  private elapsed = 0
  private candles: Array<Candle> = []
  private spawnX = 0 // x at which the next candle drops in (tracks the world)
  private lastCenter = 0.42
  private parallax = 0 // scrolling offset for the faint background grid
  private trail: Array<Trail> = []
  private deathElapsed = 0
  private impactStrength = 0
  private impactX = 0
  private impactY = 0
  private lastHud = 0

  constructor(canvas: HTMLCanvasElement, cb: FlapCallbacks) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    this.cb = cb
    this.bird = new Image()
    this.bird.decoding = 'async'
    this.bird.onload = () => {
      this.birdReady = true
      if (!this.running) this.draw()
    }
    this.bird.src = '/pips-white.svg'
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
    this.birdY = 0.42
    this.birdOffsetX = 0
    this.birdAngle = -0.35
    this.vy = FLAP_V // PLAY is also the first flap, so the run responds on the first press
    this.score = 0
    this.elapsed = 0
    this.candles = []
    this.lastCenter = 0.42
    this.trail = []
    this.dying = false
    this.deathElapsed = 0
    this.impactStrength = 0
    this.lastHud = -1 // reset the HUD throttle clock so a replay pushes from frame one
    this.spawnX = this.w + this.w * LEAD_FRAC // runway before the first candle
    this.fillCandles()
    this.running = true
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
  }

  // The one input: a kick upward. Ignored unless a run is live.
  flap() {
    if (!this.running || this.dying) return
    this.vy = FLAP_V
    if (!this.cb.reduced) this.trail.push({ x: this.w * BIRD_X_FRAC, y: this.birdY * this.h, life: 1 })
  }

  stop() {
    this.running = false
    this.dying = false
    cancelAnimationFrame(this.raf)
  }

  destroy() {
    this.stop()
    this.bird.onload = null
    this.ro?.disconnect()
    this.ro = null
  }

  private difficulty(): number {
    return clamp01(this.elapsed / RAMP_S)
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
    const keepGoing = this.step(dt)
    this.draw()
    if (keepGoing) this.raf = requestAnimationFrame(this.frame)
  }

  private step(dt: number): boolean {
    if (this.dying) {
      return this.stepDeath(dt)
    }

    this.elapsed += dt
    const speed = lerp(SPEED0, SPEED1, this.difficulty())

    // gravity + integrate the character
    this.vy = Math.min(VY_MAX, this.vy + GRAVITY * dt)
    this.birdY += this.vy * dt
    this.updateBirdAngle(dt)
    this.parallax = (this.parallax + speed * 0.4 * dt) % 64

    // scroll candles in; recycle the ones that leave the left edge
    this.spawnX -= speed * dt
    for (const c of this.candles) c.x -= speed * dt
    while (this.candles.length && this.candles[0].x < -BODY_W) this.candles.shift()
    this.fillCandles()

    // trail drifts with the field and fades, compacted in place (a fresh filtered array every frame
    // was needless GC churn under the run)
    let kept = 0
    for (let i = 0; i < this.trail.length; i++) {
      const t = this.trail[i]
      t.x -= speed * dt
      t.life -= dt * 1.6
      if (t.life > 0 && t.x > -20) this.trail[kept++] = t
    }
    this.trail.length = kept

    // score: a candle whose body has fully passed the character
    const birdX = this.w * BIRD_X_FRAC
    for (const c of this.candles) {
      if (!c.scored && c.x + BODY_W / 2 < birdX) {
        c.scored = true
        this.score++
        this.cb.onScore?.(this.score)
      }
    }

    this.pushHud()

    // collisions: ceiling clamps (a forgiving bonk), floor and candles are fatal
    const hitYNorm = BIRD_HIT_Y / this.h
    if (this.birdY < hitYNorm) {
      this.birdY = hitYNorm
      this.vy = 0
    }
    if (this.birdY > 1 - hitYNorm) {
      this.beginDeath(birdX, this.h - 1, 0.72)
      return true
    }
    const rx = BODY_W / 2 + BIRD_HIT_X
    for (const c of this.candles) {
      if (Math.abs(c.x - birdX) > rx) continue
      const top = c.center - c.half
      const bottom = c.center + c.half
      const hitTop = this.birdY - hitYNorm < top
      const hitBottom = this.birdY + hitYNorm > bottom
      if (hitTop || hitBottom) {
        const impactY = (hitTop ? top : bottom) * this.h
        this.beginDeath(c.x - BODY_W / 2, impactY, 1)
        return true
      }
    }
    return true
  }

  private beginDeath(x: number, y: number, strength: number) {
    if (this.dying) return
    this.dying = true
    this.deathElapsed = 0
    this.impactStrength = strength
    this.impactX = x
    this.impactY = y
    this.birdOffsetX = 0
    this.vy = -0.18
    this.pushHud(true)
    this.cb.onCrash?.()
  }

  private stepDeath(dt: number): boolean {
    this.deathElapsed += dt
    this.vy = Math.min(DEATH_VY_MAX, this.vy + DEATH_GRAVITY * dt)
    this.birdY += this.vy * dt
    this.updateBirdAngle(dt, true)
    this.birdOffsetX -= Math.max(0, 52 * (1 - this.deathElapsed / 0.48)) * dt

    const fallenOut = this.birdY * this.h - BIRD_H / 2 > this.h
    if ((this.deathElapsed >= DEATH_MIN_S && fallenOut) || this.deathElapsed >= DEATH_MAX_S) {
      this.running = false
      this.dying = false
      this.cb.onEnd(this.score)
      return false
    }
    return true
  }

  private updateBirdAngle(dt: number, dying = false) {
    const fall = clamp01((this.vy + 0.3) / (DEATH_VY_MAX + 0.3))
    const target = dying ? lerp(-0.18, 1.42, fall) : Math.max(-0.45, Math.min(1.05, this.vy * 0.48))
    const blend = 1 - Math.exp(-ROTATION_RESPONSE * dt)
    this.birdAngle += (target - this.birdAngle) * blend
  }

  private pushHud(force = false) {
    if (!force && this.elapsed - this.lastHud < 0.05) return // throttle DOM updates to ~20Hz
    this.lastHud = this.elapsed
    this.cb.onHud({ score: this.score, elapsed: this.elapsed, alive: this.running && !this.dying })
  }

  private draw() {
    const ctx = this.ctx
    const { w, h } = this
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)

    ctx.save()
    if (this.dying && !this.cb.reduced && this.deathElapsed < SHAKE_S) {
      const life = 1 - this.deathElapsed / SHAKE_S
      const amount = 8 * this.impactStrength * life * life
      ctx.translate((Math.random() * 2 - 1) * amount, (Math.random() * 2 - 1) * amount)
    }

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

    // trail: a short white streak behind the character
    for (const t of this.trail) {
      ctx.fillStyle = rgba([0xff, 0xff, 0xff], 0.34 * t.life)
      ctx.beginPath()
      ctx.arc(t.x, t.y, 3 * t.life + 1, 0, Math.PI * 2)
      ctx.fill()
    }

    this.drawBird()
    if (this.dying) this.drawImpact()
    ctx.restore()

    if (this.dying) this.drawDeathVignette()
  }

  private drawBird() {
    const ctx = this.ctx
    const x = this.w * BIRD_X_FRAC + this.birdOffsetX
    const y = this.birdY * this.h

    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(this.birdAngle)
    if (this.birdReady) {
      ctx.drawImage(this.bird, -BIRD_W / 2, -BIRD_H / 2, BIRD_W, BIRD_H)
    } else {
      ctx.fillStyle = '#fff'
      ctx.font = '900 38px Gabarito, Inter, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('P', 0, 1)
    }
    ctx.restore()
  }

  private drawImpact() {
    if (this.deathElapsed >= 0.3 || this.cb.reduced) return
    const ctx = this.ctx
    const progress = this.deathElapsed / 0.3
    const alpha = (1 - progress) * this.impactStrength

    ctx.save()
    ctx.translate(this.impactX, this.impactY)
    ctx.lineCap = 'square'
    for (let i = 0; i < 8; i++) {
      const angle = i * Math.PI / 4
      const inner = 4 + progress * 7
      const outer = inner + 10 * (1 - progress)
      ctx.strokeStyle = i % 2 === 0 ? rgba([0xff, 0xff, 0xff], alpha) : rgba(RED, alpha)
      ctx.lineWidth = i % 2 === 0 ? 2 : 3
      ctx.beginPath()
      ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner)
      ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer)
      ctx.stroke()
    }
    ctx.restore()
  }

  private drawDeathVignette() {
    const ctx = this.ctx
    const { w, h } = this
    const impact = clamp01(1 - this.deathElapsed / 0.5)
    const alpha = this.impactStrength * (0.18 + impact * 0.62)
    const radius = Math.hypot(w, h) * 0.62
    const gradient = ctx.createRadialGradient(
      w / 2,
      h * 0.46,
      Math.min(w, h) * 0.18,
      w / 2,
      h * 0.46,
      radius,
    )
    gradient.addColorStop(0, 'rgba(255,50,40,0)')
    gradient.addColorStop(0.58, rgba(RED, alpha * 0.12))
    gradient.addColorStop(0.82, rgba(RED, alpha * 0.48))
    gradient.addColorStop(1, rgba(RED, alpha))
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, w, h)

    if (impact > 0) {
      ctx.fillStyle = rgba(RED, impact * this.impactStrength * 0.09)
      ctx.fillRect(0, 0, w, h)
    }
  }

  // One candlestick: a filled body with a 2px outline (the schematic line-art read), plus a wick
  // line poking `dir` (down for a top candle, up for a bottom one) toward the gap.
  private drawCandle(cx: number, top: number, bottom: number, color: ReadonlyArray<number>, dir: number) {
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
