// One sound instance for the whole app. Tiny WebAudio synth (no asset files): a bright two-note
// blip on a win, a soft fall on a loss. Mirrors haptics.ts: silent where unsupported and a no-op
// when the user's Sound setting is off, so callers never have to guard. Sounds only fire after a
// user gesture (a settle follows a tap), so autoplay policy is never hit.

let ctx: AudioContext | null = null
let enabled = true

type Sound = 'win' | 'lose'

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) return null
  if (!ctx) ctx = new Ctx()
  return ctx
}

// Master level for all synth voices (one-shots + BGM). The device SFX in consoleAudio.ts decode at
// full scale, so the synth bus is lifted to sit level with them. One knob to rebalance everything.
const SYNTH_LEVEL = 2.0
let synthBus: GainNode | null = null
function out(ac: AudioContext): AudioNode {
  if (!synthBus) {
    synthBus = ac.createGain()
    synthBus.gain.value = SYNTH_LEVEL
    synthBus.connect(ac.destination)
  }
  return synthBus
}

// Driven by the user's Sound setting (synced from the auth user). When off, every call no-ops
// and any running BGM is cut so the toggle takes effect immediately.
export function setSoundEnabled(value: boolean): void {
  enabled = value
  if (!value) stopBgm()
}

// A short percussive blip at a frequency, shaped by a quick attack + exponential decay.
function blip(ac: AudioContext, freq: number, start: number, dur: number, gain = 0.06): void {
  const osc = ac.createOscillator()
  const g = ac.createGain()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(freq, start)
  g.gain.setValueAtTime(0.0001, start)
  g.gain.exponentialRampToValueAtTime(gain, start + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  osc.connect(g).connect(out(ac))
  osc.start(start)
  osc.stop(start + dur + 0.02)
}

export function sound(kind: Sound): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume()
  const t = ac.currentTime
  if (kind === 'win') {
    // Rising major third: a small, satisfying "ding".
    blip(ac, 880, t, 0.12)
    blip(ac, 1318.5, t + 0.085, 0.16)
  } else {
    // Soft downward step: acknowledges the miss without nagging.
    blip(ac, 320, t, 0.16, 0.045)
    blip(ac, 240, t + 0.07, 0.2, 0.04)
  }
}

// --- Lucky slot voices. The reels make their own little instrument: a launch flourish, a quiet
// ratchet while they spin, and a snap that climbs per reel so landing all three resolves a chord.

// Spin-up: a quick three-step rise as the reels are dealt and start tumbling.
export function slotSpin(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume()
  const t = ac.currentTime
  blip(ac, 440, t, 0.06, 0.03)
  blip(ac, 660, t + 0.045, 0.06, 0.03)
  blip(ac, 880, t + 0.09, 0.09, 0.035)
}

// One ratchet tick: ultra-short, quiet, a hair of pitch jitter so a stream of them reads as
// mechanical reel motion rather than a held tone. Driven on an interval while the reels cycle.
export function slotTick(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume()
  const t = ac.currentTime
  const osc = ac.createOscillator()
  const g = ac.createGain()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(1300 + Math.random() * 500, t)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.016, t + 0.003)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.028)
  osc.connect(g).connect(out(ac))
  osc.start(t)
  osc.stop(t + 0.035)
}

// A reel lands: a short body "thunk" plus a bright ding that climbs by reel (A5, C#6, E6), so the
// three staggered stops land an A-major triad. The last reel rings a touch longer.
export function slotLock(step: number): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume()
  const t = ac.currentTime
  const osc = ac.createOscillator()
  const g = ac.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(190, t)
  osc.frequency.exponentialRampToValueAtTime(95, t + 0.09)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.05, t + 0.006)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12)
  osc.connect(g).connect(out(ac))
  osc.start(t)
  osc.stop(t + 0.14)
  const notes = [880, 1108.7, 1318.5]
  const last = step >= notes.length - 1
  blip(ac, notes[Math.min(step, notes.length - 1)], t + 0.005, last ? 0.22 : 0.13, 0.05)
}

// --- Candle Hop voices. A calm, loopable synth bed for the run plus two punchy one-shots: a
// bright "tuiing" that climbs a pentatonic ladder per cleared candle (so a streak feels good), and
// a falling synth sigh on a crash. The bed is a bed, not a foreground: low gain, soft filtering.

// A short noise burst reused for the hi-hat. Built once, lazily.
let noiseBuf: AudioBuffer | null = null
function noise(ac: AudioContext): AudioBuffer {
  if (noiseBuf) return noiseBuf
  const len = Math.floor(ac.sampleRate * 0.2)
  const buf = ac.createBuffer(1, len, ac.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  noiseBuf = buf
  return buf
}

// Four-bar loop, A minor (Am - F - C - G): a low bass root + three chord tones for the arp.
const BGM_BARS = [
  { bass: 110.0, arp: [220.0, 261.63, 329.63] }, // Am
  { bass: 87.31, arp: [220.0, 261.63, 349.23] }, // F
  { bass: 130.81, arp: [261.63, 329.63, 392.0] }, // C
  { bass: 98.0, arp: [246.94, 293.66, 392.0] }, // G
]
const BGM_TEMPO = 112
const BGM_STEP = 60 / BGM_TEMPO / 4 // sixteenth-note length, seconds
const BGM_STEPS = BGM_BARS.length * 16

function bgmKick(ac: AudioContext, dest: AudioNode, t: number): void {
  const o = ac.createOscillator()
  const g = ac.createGain()
  o.type = 'sine'
  o.frequency.setValueAtTime(135, t)
  o.frequency.exponentialRampToValueAtTime(48, t + 0.11)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.18, t + 0.006)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
  o.connect(g).connect(dest)
  o.start(t)
  o.stop(t + 0.2)
}

function bgmBass(ac: AudioContext, dest: AudioNode, freq: number, t: number): void {
  const o = ac.createOscillator()
  const g = ac.createGain()
  const f = ac.createBiquadFilter()
  o.type = 'triangle'
  o.frequency.setValueAtTime(freq, t)
  f.type = 'lowpass'
  f.frequency.value = 700
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.11, t + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26)
  o.connect(f).connect(g).connect(dest)
  o.start(t)
  o.stop(t + 0.3)
}

function bgmArp(ac: AudioContext, dest: AudioNode, freq: number, t: number): void {
  const o = ac.createOscillator()
  const g = ac.createGain()
  const f = ac.createBiquadFilter()
  o.type = 'triangle'
  o.frequency.setValueAtTime(freq, t)
  f.type = 'lowpass'
  f.frequency.value = 2400
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.06, t + 0.006)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
  o.connect(f).connect(g).connect(dest)
  o.start(t)
  o.stop(t + 0.22)
}

function bgmHat(ac: AudioContext, dest: AudioNode, t: number, accent: boolean): void {
  const src = ac.createBufferSource()
  const f = ac.createBiquadFilter()
  const g = ac.createGain()
  src.buffer = noise(ac)
  f.type = 'highpass'
  f.frequency.value = 7000
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(accent ? 0.04 : 0.025, t + 0.004)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05)
  src.connect(f).connect(g).connect(dest)
  src.start(t)
  src.stop(t + 0.06)
}

// Lay down one sixteenth step of the loop at time t: kick + bass on the beat, a rolling up-down
// arp on the eighths, soft hats on the offbeats.
function bgmStepAt(ac: AudioContext, dest: AudioNode, step: number, t: number): void {
  const chord = BGM_BARS[Math.floor(step / 16) % BGM_BARS.length]
  const s = step % 16
  if (s % 4 === 0) {
    bgmKick(ac, dest, t)
    bgmBass(ac, dest, s === 8 ? chord.bass * 2 : chord.bass, t) // octave bounce mid-bar for groove
  }
  if (s % 2 === 0) {
    const idx = [0, 1, 2, 1][(step >> 1) & 3]
    bgmArp(ac, dest, chord.arp[idx], t)
  }
  if (s === 2 || s === 6 || s === 10 || s === 14) {
    bgmHat(ac, dest, t, s === 6 || s === 14)
  }
}

let bgmTimer: ReturnType<typeof setInterval> | null = null
let bgmStepIdx = 0
let bgmNext = 0
let bgmBus: GainNode | null = null

// Start the looping bed. A short lookahead scheduler (the standard WebAudio pattern) keeps note
// timing tight regardless of timer jitter. No-op if sound is off or it is already running.
export function startBgm(): void {
  if (!enabled || bgmTimer) return
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume()
  const bus = ac.createGain()
  bus.gain.setValueAtTime(0.0001, ac.currentTime)
  bus.gain.exponentialRampToValueAtTime(0.3, ac.currentTime + 0.6) // ease the bed in (kept low: it's a bed)
  bus.connect(out(ac))
  bgmBus = bus
  bgmStepIdx = 0
  bgmNext = ac.currentTime + 0.08
  bgmTimer = setInterval(() => {
    if (!ac || !bgmBus) return
    while (bgmNext < ac.currentTime + 0.1) {
      bgmStepAt(ac, bgmBus, bgmStepIdx, bgmNext)
      bgmNext += BGM_STEP
      bgmStepIdx = (bgmStepIdx + 1) % BGM_STEPS
    }
  }, 25)
}

// Stop the bed with a quick fade so it never clicks off. Safe to call when nothing is playing.
export function stopBgm(): void {
  if (bgmTimer) {
    clearInterval(bgmTimer)
    bgmTimer = null
  }
  const bus = bgmBus
  bgmBus = null
  if (bus && ctx) {
    const now = ctx.currentTime
    bus.gain.cancelScheduledValues(now)
    bus.gain.setValueAtTime(Math.max(0.0001, bus.gain.value), now)
    bus.gain.exponentialRampToValueAtTime(0.0001, now + 0.18)
    setTimeout(() => bus.disconnect(), 260)
  }
}

// The "tuiing" climbs with the streak, but gently: it rises ~1.5 octaves spread over HOP_CAP
// candles, then holds. So an early streak nudges up slowly instead of pinning the top by score ~8.
const HOP_BASE = 783.99 // G5, the streak's first note
const HOP_RANGE = 1.5 // octaves of total climb across the whole streak
const HOP_CAP = 40 // candles to reach the top, then it stays there
let hopCombo = 0

export function hopResetCombo(): void {
  hopCombo = 0
}

// The "tuiing": a fast upward portamento on a triangle plus a shimmer an octave up, pitched a touch
// higher for every candle in the current streak.
export function hopScore(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume()
  const t = ac.currentTime
  const climb = Math.min(hopCombo, HOP_CAP) / HOP_CAP
  const base = HOP_BASE * Math.pow(2, HOP_RANGE * climb)
  hopCombo++
  const o = ac.createOscillator()
  const g = ac.createGain()
  o.type = 'triangle'
  o.frequency.setValueAtTime(base * 0.86, t)
  o.frequency.exponentialRampToValueAtTime(base, t + 0.05) // the slide that makes the "tuiing"
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.07, t + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
  o.connect(g).connect(out(ac))
  o.start(t)
  o.stop(t + 0.18)
  blip(ac, base * 2, t + 0.012, 0.1, 0.025) // shimmer
}

// The crash: two detuned saws sliding down a fifth under a closing lowpass, with a sub thud. A
// short synth sigh that lands the miss without being harsh.
export function hopLose(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume()
  const t = ac.currentTime
  const f = ac.createBiquadFilter()
  f.type = 'lowpass'
  f.frequency.setValueAtTime(1800, t)
  f.frequency.exponentialRampToValueAtTime(280, t + 0.55)
  const g = ac.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.12, t + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.62)
  f.connect(g).connect(out(ac))
  for (const [freq, detune] of [[330, -7] as const, [392, 7] as const]) {
    const o = ac.createOscillator()
    o.type = 'sawtooth'
    o.detune.value = detune
    o.frequency.setValueAtTime(freq, t)
    o.frequency.exponentialRampToValueAtTime(freq * 0.6, t + 0.55)
    o.connect(f)
    o.start(t)
    o.stop(t + 0.64)
  }
  const sub = ac.createOscillator()
  const sg = ac.createGain()
  sub.type = 'sine'
  sub.frequency.setValueAtTime(150, t)
  sub.frequency.exponentialRampToValueAtTime(45, t + 0.4)
  sg.gain.setValueAtTime(0.0001, t)
  sg.gain.exponentialRampToValueAtTime(0.14, t + 0.01)
  sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.5)
  sub.connect(sg).connect(out(ac))
  sub.start(t)
  sub.stop(t + 0.52)
}

// --- Range voices. Tense but driving, so the hold feels like a high-stakes game, not an elevator. A
// dark minor loop with a real groove: four-on-the-floor kick, a pulsing octave bass, a resonant
// 16th-note saw arp for the hook, and offbeat hats. Around it sit the stings: the band lock, an
// in/out-of-zone crossing tone, the buzzer riser, and an epic win/loss resolve. Same synth master.

const RANGE_TEMPO = 122
const RANGE_STEP = 60 / RANGE_TEMPO / 4 // sixteenth-note length, seconds
const RANGE_STEPS = 64 // 4 bars

// Am - F - G - E (i - VI - VII - V): dark and moving, the E's G# leading-tone pulls back to Am.
const RANGE_BARS = [
  { bass: 110.0, arp: [220.0, 261.63, 329.63] }, // Am  (A C E)
  { bass: 87.31, arp: [220.0, 261.63, 349.23] }, // F   (A C F)
  { bass: 98.0, arp: [246.94, 293.66, 392.0] }, // G   (B D G)
  { bass: 82.41, arp: [246.94, 329.63, 415.3] }, // E   (B E G#)
]

function rangeKick(ac: AudioContext, dest: AudioNode, t: number): void {
  const o = ac.createOscillator()
  const g = ac.createGain()
  o.type = 'sine'
  o.frequency.setValueAtTime(150, t)
  o.frequency.exponentialRampToValueAtTime(50, t + 0.1)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.2, t + 0.006)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
  o.connect(g).connect(dest)
  o.start(t)
  o.stop(t + 0.18)
}

function rangeBass(ac: AudioContext, dest: AudioNode, freq: number, t: number): void {
  const o = ac.createOscillator()
  const g = ac.createGain()
  const f = ac.createBiquadFilter()
  o.type = 'sawtooth'
  o.frequency.setValueAtTime(freq, t)
  f.type = 'lowpass'
  f.frequency.value = 620
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.085, t + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15)
  o.connect(f).connect(g).connect(dest)
  o.start(t)
  o.stop(t + 0.17)
}

function rangeArp(ac: AudioContext, dest: AudioNode, freq: number, t: number): void {
  const o = ac.createOscillator()
  const g = ac.createGain()
  const f = ac.createBiquadFilter()
  o.type = 'sawtooth'
  o.frequency.setValueAtTime(freq, t)
  f.type = 'lowpass'
  f.frequency.value = 2000
  f.Q.value = 7 // resonant, a tense synth edge
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.04, t + 0.004)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12)
  o.connect(f).connect(g).connect(dest)
  o.start(t)
  o.stop(t + 0.13)
}

function rangeHat(ac: AudioContext, dest: AudioNode, t: number, accent: boolean): void {
  const src = ac.createBufferSource()
  const f = ac.createBiquadFilter()
  const g = ac.createGain()
  src.buffer = noise(ac)
  f.type = 'highpass'
  f.frequency.value = 7500
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(accent ? 0.035 : 0.02, t + 0.004)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045)
  src.connect(f).connect(g).connect(dest)
  src.start(t)
  src.stop(t + 0.05)
}

// One sixteenth of the driving loop: four-on-the-floor kick, a root/octave pulsing eighth bass, a
// rolling 16th saw arp (the hook), and offbeat hats.
function rangeStepAt(ac: AudioContext, dest: AudioNode, step: number, t: number): void {
  const chord = RANGE_BARS[Math.floor(step / 16) % RANGE_BARS.length]
  const s = step % 16
  if (s % 4 === 0) rangeKick(ac, dest, t)
  if (s % 2 === 0) rangeBass(ac, dest, s % 4 === 2 ? chord.bass * 2 : chord.bass, t)
  rangeArp(ac, dest, chord.arp[[0, 1, 2, 1][step & 3]], t)
  if (s === 2 || s === 6 || s === 10 || s === 14) rangeHat(ac, dest, t, s === 6 || s === 14)
}

let rangeTimer: ReturnType<typeof setInterval> | null = null
let rangeStepIdx = 0
let rangeNext = 0
let rangeBus: GainNode | null = null

// The driving bed. Plays while a position is open; a quick fade-in so the groove kicks in with the lock.
export function startRangeBgm(): void {
  if (!enabled || rangeTimer) return
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume()
  const bus = ac.createGain()
  bus.gain.setValueAtTime(0.0001, ac.currentTime)
  bus.gain.exponentialRampToValueAtTime(0.26, ac.currentTime + 0.4)
  bus.connect(out(ac))
  rangeBus = bus
  rangeStepIdx = 0
  rangeNext = ac.currentTime + 0.08
  rangeTimer = setInterval(() => {
    if (!ac || !rangeBus) return
    while (rangeNext < ac.currentTime + 0.1) {
      rangeStepAt(ac, rangeBus, rangeStepIdx, rangeNext)
      rangeNext += RANGE_STEP
      rangeStepIdx = (rangeStepIdx + 1) % RANGE_STEPS
    }
  }, 25)
}

export function stopRangeBgm(): void {
  if (rangeTimer) {
    clearInterval(rangeTimer)
    rangeTimer = null
  }
  const bus = rangeBus
  rangeBus = null
  if (bus && ctx) {
    const now = ctx.currentTime
    bus.gain.cancelScheduledValues(now)
    bus.gain.setValueAtTime(Math.max(0.0001, bus.gain.value), now)
    bus.gain.exponentialRampToValueAtTime(0.0001, now + 0.25) // quick fade, no abrupt cut
    setTimeout(() => bus.disconnect(), 400)
  }
}

// Band locks on PLAY: a deep committing thud plus a short rising D-minor triad. "You're in."
export function rangeLock(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume()
  const t = ac.currentTime
  const o = ac.createOscillator()
  const g = ac.createGain()
  o.type = 'sine'
  o.frequency.setValueAtTime(120, t)
  o.frequency.exponentialRampToValueAtTime(48, t + 0.18)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.22, t + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3)
  o.connect(g).connect(out(ac))
  o.start(t)
  o.stop(t + 0.32)
  const triad = [293.66, 349.23, 440.0] // D4 F4 A4
  triad.forEach((f, i) => blip(ac, f, t + 0.04 + i * 0.05, 0.18, 0.06))
}

// The live price crosses your band edge: a hopeful rising fifth going in, a tense falling step going
// out. Subtle on purpose so a price hovering at the edge never nags.
export function rangeCross(inside: boolean): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume()
  const t = ac.currentTime
  const o = ac.createOscillator()
  const g = ac.createGain()
  o.type = 'triangle'
  if (inside) {
    o.frequency.setValueAtTime(392.0, t) // G4
    o.frequency.exponentialRampToValueAtTime(587.33, t + 0.12) // up to D5
  } else {
    o.frequency.setValueAtTime(415.3, t) // Ab4
    o.frequency.exponentialRampToValueAtTime(311.13, t + 0.14) // down to Eb4 (tense)
  }
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.05, t + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
  o.connect(g).connect(out(ac))
  o.start(t)
  o.stop(t + 0.22)
}

// The buzzer: a short rising riser (a filtered noise sweep + a low swell) as the round goes to settle.
export function rangeBuzzer(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume()
  const t = ac.currentTime
  const src = ac.createBufferSource()
  src.buffer = noise(ac)
  src.loop = true
  const f = ac.createBiquadFilter()
  f.type = 'bandpass'
  f.Q.value = 1.2
  f.frequency.setValueAtTime(400, t)
  f.frequency.exponentialRampToValueAtTime(3000, t + 0.7)
  const g = ac.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.06, t + 0.5)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85)
  src.connect(f).connect(g).connect(out(ac))
  src.start(t)
  src.stop(t + 0.9)
  const o = ac.createOscillator()
  const og = ac.createGain()
  o.type = 'sawtooth'
  o.frequency.setValueAtTime(55, t)
  o.frequency.exponentialRampToValueAtTime(110, t + 0.7)
  og.gain.setValueAtTime(0.0001, t)
  og.gain.exponentialRampToValueAtTime(0.1, t + 0.6)
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.9)
  o.connect(og).connect(out(ac))
  o.start(t)
  o.stop(t + 0.92)
}

// Epic win resolve: a low boom under a bright rising D-major chord. Triumphant, not cheesy.
export function rangeWin(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume()
  const t = ac.currentTime
  const o = ac.createOscillator()
  const g = ac.createGain()
  o.type = 'sine'
  o.frequency.setValueAtTime(90, t)
  o.frequency.exponentialRampToValueAtTime(45, t + 0.5)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.24, t + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7)
  o.connect(g).connect(out(ac))
  o.start(t)
  o.stop(t + 0.72)
  const chord = [293.66, 369.99, 440.0, 587.33] // D4 F#4 A4 D5
  chord.forEach((f, i) => blip(ac, f, t + 0.05 + i * 0.06, 0.4, 0.07))
}

// Somber loss resolve: a deep hit and a slow descending minor sigh under a closing filter. Final,
// weighty, never harsh.
export function rangeLose(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume()
  const t = ac.currentTime
  const o = ac.createOscillator()
  const g = ac.createGain()
  o.type = 'sine'
  o.frequency.setValueAtTime(70, t)
  o.frequency.exponentialRampToValueAtTime(38, t + 0.5)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.2, t + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.75)
  o.connect(g).connect(out(ac))
  o.start(t)
  o.stop(t + 0.78)
  const f = ac.createBiquadFilter()
  f.type = 'lowpass'
  f.frequency.setValueAtTime(1400, t)
  f.frequency.exponentialRampToValueAtTime(300, t + 0.7)
  const sg = ac.createGain()
  sg.gain.setValueAtTime(0.0001, t)
  sg.gain.exponentialRampToValueAtTime(0.1, t + 0.05)
  sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.8)
  f.connect(sg).connect(out(ac))
  for (const [freq, det] of [[293.66, -7] as const, [293.66, 7] as const]) {
    const s = ac.createOscillator()
    s.type = 'sawtooth'
    s.detune.value = det
    s.frequency.setValueAtTime(freq, t)
    s.frequency.exponentialRampToValueAtTime(220.0, t + 0.7) // D4 -> A3
    s.connect(f)
    s.start(t)
    s.stop(t + 0.82)
  }
}
