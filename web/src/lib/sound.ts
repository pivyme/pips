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
  if (!value) {
    stopBgm()
    stopLuckyBgm()
  }
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

// A soft mallet/bell: a triangle through a gentle lowpass with a quick attack and a rounded tail,
// plus an octave shimmer for air. Warmer and fuller than `blip`, this is the Lucky voice (marimba,
// not chiptune). Reused across the reel locks, the commit, and the win/cash-out resolves so the
// whole game speaks one tone. Routes to `dest` when given (the bed bus), else the shared synth bus.
function bell(ac: AudioContext, freq: number, start: number, dur: number, gain = 0.06, dest?: AudioNode): void {
  const sink = dest ?? out(ac)
  const o = ac.createOscillator()
  const sh = ac.createOscillator()
  const g = ac.createGain()
  const shG = ac.createGain()
  const f = ac.createBiquadFilter()
  o.type = 'triangle'
  sh.type = 'sine'
  o.frequency.setValueAtTime(freq, start)
  sh.frequency.setValueAtTime(freq * 2.01, start) // a hair sharp keeps the shimmer alive, not dead-on
  f.type = 'lowpass'
  f.frequency.value = Math.min(freq * 5, 8500)
  g.gain.setValueAtTime(0.0001, start)
  g.gain.exponentialRampToValueAtTime(gain, start + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  shG.gain.setValueAtTime(0.0001, start)
  shG.gain.exponentialRampToValueAtTime(gain * 0.22, start + 0.006)
  shG.gain.exponentialRampToValueAtTime(0.0001, start + dur * 0.6)
  o.connect(f).connect(g).connect(sink)
  sh.connect(shG).connect(sink)
  o.start(start)
  o.stop(start + dur + 0.05)
  sh.start(start)
  sh.stop(start + dur + 0.05)
}

// The onboarding welcome moment: a short, warm, rising open-major sparkle (C major, mallet voice)
// over silence. Bright and celebratory, distinct from luckyWin's sub-heavy two-octave climb and from
// any game bed. Fire it on a real gesture (the welcome beat lands right after the Continue tap).
export function welcomeJingle(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume()
  const t = ac.currentTime
  // A rising spread, each note a touch behind the last, decaying long so they ring together.
  const climb: Array<[number, number, number]> = [
    [523.25, 0.0, 0.6], // C5
    [659.25, 0.09, 0.6], // E5
    [783.99, 0.18, 0.65], // G5
    [1046.5, 0.27, 0.8], // C6
    [1318.51, 0.42, 0.9], // E6, the arrival
  ]
  for (const [f, dt, dur] of climb) bell(ac, f, t + dt, dur, 0.07)
  // A warm low root underneath so it has body, not just sparkle.
  bell(ac, 261.63, t, 0.9, 0.05) // C4
  // A high shimmer tail after the arrival.
  bell(ac, 1567.98, t + 0.6, 0.7, 0.035) // G6
  blip(ac, 2093.0, t + 0.62, 0.25, 0.02) // C7 air
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

// --- Lucky slot voices. The reels are a little instrument: a soft launch whoosh, a warm ratchet
// while they spin, and a rounded mallet snap that climbs per reel. All built on the `bell` voice and
// filtered noise (no raw square blips), so the slot reads tactile and playful, never chiptune.

// Spin-up: a quick filtered-noise whoosh rising under a warm three-note bloom (C-E-G), as the reels
// are dealt and start tumbling. The whoosh gives motion, the bloom gives it a friendly major lift.
export function slotSpin(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume()
  const t = ac.currentTime
  const src = ac.createBufferSource()
  src.buffer = noise(ac)
  const f = ac.createBiquadFilter()
  f.type = 'bandpass'
  f.Q.value = 0.8
  f.frequency.setValueAtTime(320, t)
  f.frequency.exponentialRampToValueAtTime(2200, t + 0.22) // sweep up = the reels taking off
  const ng = ac.createGain()
  ng.gain.setValueAtTime(0.0001, t)
  ng.gain.exponentialRampToValueAtTime(0.03, t + 0.05)
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.26)
  src.connect(f).connect(ng).connect(out(ac))
  src.start(t)
  src.stop(t + 0.3)
  bell(ac, 523.25, t, 0.14, 0.035) // C5
  bell(ac, 659.25, t + 0.05, 0.14, 0.035) // E5
  bell(ac, 783.99, t + 0.1, 0.18, 0.04) // G5
}

// One ratchet tick: a tiny filtered-noise detent, ultra-short and quiet, a hair of bandpass jitter
// so a stream of them reads as a mechanical reel rolling rather than a chiptune click. Driven on an
// interval while the reels cycle.
export function slotTick(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume()
  const t = ac.currentTime
  const src = ac.createBufferSource()
  src.buffer = noise(ac)
  const f = ac.createBiquadFilter()
  f.type = 'bandpass'
  f.Q.value = 1.6
  f.frequency.value = 1700 + Math.random() * 900
  const g = ac.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.013, t + 0.002)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03)
  src.connect(f).connect(g).connect(out(ac))
  src.start(t)
  src.stop(t + 0.04)
}

// A reel lands: a soft body thunk + a noise detent click + a rounded mallet ding that climbs by reel
// (A5, C#6, E6). The final reel (`last`) rings longer and tops itself with a little sparkle, so the
// last stop feels like the payoff beat instead of just another click.
export function slotLock(step: number, last = false): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume()
  const t = ac.currentTime
  // warm body thunk
  const o = ac.createOscillator()
  const g = ac.createGain()
  o.type = 'sine'
  o.frequency.setValueAtTime(200, t)
  o.frequency.exponentialRampToValueAtTime(92, t + 0.1)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.055, t + 0.006)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13)
  o.connect(g).connect(out(ac))
  o.start(t)
  o.stop(t + 0.15)
  // a short detent click rides the snap
  const src = ac.createBufferSource()
  src.buffer = noise(ac)
  const nf = ac.createBiquadFilter()
  nf.type = 'highpass'
  nf.frequency.value = 3500
  const ng = ac.createGain()
  ng.gain.setValueAtTime(0.0001, t)
  ng.gain.exponentialRampToValueAtTime(0.02, t + 0.002)
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.04)
  src.connect(nf).connect(ng).connect(out(ac))
  src.start(t)
  src.stop(t + 0.05)
  const notes = [880, 1108.7, 1318.5] // A5 C#6 E6
  bell(ac, notes[Math.min(step, notes.length - 1)], t + 0.005, last ? 0.32 : 0.16, 0.05)
  if (last) bell(ac, 1760.0, t + 0.08, 0.24, 0.025) // A6 sparkle to top the final landing
}

// The chart locks in after the reels settle: a bright ascending mallet confirm (B5-E6-A6), the slot
// committing to its market right before the chart blooms open. Its own voice, clear of the reel chord.
export function slotPick(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume()
  const t = ac.currentTime
  bell(ac, 987.77, t, 0.16, 0.045) // B5
  bell(ac, 1318.51, t + 0.06, 0.18, 0.05) // E6
  bell(ac, 1760.0, t + 0.12, 0.26, 0.055) // A6, held a touch longer
}

// --- Lucky bed + resolves. A warm, groovy bed rides the whole round (deal -> open), and the round
// ends on one of three warm mallet stings: a jackpot climb on a win, a confident chime on a cash-out,
// a soft sigh on a miss. Cool and confident, distinct from Range's dark tension and Flappy's bright arp.

// D Dorian, i - IV - i - bVII (Dm - G - Dm - C): the "cool" minor (the natural 6th keeps it confident,
// not sad), a tight vamp. Each bar carries a low chord pad for weight. Warm-mallet, bassy, serious-but-fun,
// nothing like Flappy's bright C-major arp or Range's resonant-saw tension.
const LUCKY_BARS = [
  { bass: 73.42, pad: [146.83, 174.61, 220.0] }, // Dm  (D F A)
  { bass: 98.0, pad: [196.0, 246.94, 293.66] }, // G   (G B D)
  { bass: 73.42, pad: [146.83, 174.61, 220.0] }, // Dm  (D F A)
  { bass: 65.41, pad: [130.81, 164.81, 196.0] }, // C   (C E G)
]
// A syncopated bass groove (root on the beats, an octave pop on the pushes), keyed by sixteenth step.
// This funk, plus the sub layer in luckyBass, is the low-end weight the bed leans on.
const LUCKY_BASS_HITS: Record<number, number> = { 0: 1, 3: 1, 6: 2, 8: 1, 11: 2, 14: 1 }
// The hook: a spacey, mid-register mallet riff (D-minor pentatonic, lots of rest = cool, not busy), not a
// sweet high melody. Four bars of eighth notes, null = rest. It sits low and confident, never twinkly.
const LUCKY_MELODY: (number | null)[] = [
  293.66, null, 349.23, 440.0, null, 440.0, null, null, // Dm: D4 .  F4 A4 .  A4 .  .
  493.88, null, 440.0, 392.0, null, null, 392.0, null, // G : B4 .  A4 G4 .  .  G4 .
  293.66, null, 349.23, 440.0, null, 523.25, 587.33, null, // Dm: D4 .  F4 A4 .  C5 D5 .
  523.25, null, 493.88, 392.0, null, 440.0, null, null, // C : C5 .  B4 G4 .  A4 .  .
]
const LUCKY_TEMPO = 102
const LUCKY_STEP = 60 / LUCKY_TEMPO / 4 // sixteenth-note length, seconds
const LUCKY_STEPS = LUCKY_BARS.length * 16
const LUCKY_SWING = LUCKY_STEP * 0.2 // a light groove swing on the offbeats (fun, not bouncy)

function luckyKick(ac: AudioContext, dest: AudioNode, t: number): void {
  const o = ac.createOscillator()
  const g = ac.createGain()
  o.type = 'sine'
  o.frequency.setValueAtTime(130, t)
  o.frequency.exponentialRampToValueAtTime(45, t + 0.11)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.16, t + 0.006) // heavier than before: the bed wants weight now
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.19)
  o.connect(g).connect(dest)
  o.start(t)
  o.stop(t + 0.21)
}

// A fat, warm bass: a sawtooth body through a low lowpass for harmonics small speakers can hear, plus a
// unison sine sub for the felt low end. This is the "bassy" weight the bed leans on.
function luckyBass(ac: AudioContext, dest: AudioNode, freq: number, t: number): void {
  const o = ac.createOscillator()
  const g = ac.createGain()
  const f = ac.createBiquadFilter()
  o.type = 'sawtooth'
  o.frequency.setValueAtTime(freq, t)
  f.type = 'lowpass'
  f.frequency.value = 460
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.13, t + 0.014)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24)
  o.connect(f).connect(g).connect(dest)
  o.start(t)
  o.stop(t + 0.27)
  const sub = ac.createOscillator()
  const sg = ac.createGain()
  sub.type = 'sine'
  sub.frequency.setValueAtTime(freq, t)
  sg.gain.setValueAtTime(0.0001, t)
  sg.gain.exponentialRampToValueAtTime(0.12, t + 0.012)
  sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
  sub.connect(sg).connect(dest)
  sub.start(t)
  sub.stop(t + 0.23)
}

function luckyShaker(ac: AudioContext, dest: AudioNode, t: number, accent: boolean): void {
  const src = ac.createBufferSource()
  const f = ac.createBiquadFilter()
  const g = ac.createGain()
  src.buffer = noise(ac)
  f.type = 'bandpass'
  f.Q.value = 0.9
  f.frequency.value = 5200 // warmer than a bright hi-hat, so the bed stays soft
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(accent ? 0.026 : 0.016, t + 0.005)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05)
  src.connect(f).connect(g).connect(dest)
  src.start(t)
  src.stop(t + 0.06)
}

// One sixteenth of the bed. Kick on beats 1 and 3 for weight, a syncopated bass groove (the low-end
// drive), a soft low chord pad at the top of each bar for body, the spacey mid-register mallet riff on
// the eighths (swung), and an offbeat shaker. Cool and bassy, never the old oom-pah cheer.
function luckyStepAt(ac: AudioContext, dest: AudioNode, step: number, t: number): void {
  const bar = Math.floor(step / 16) % LUCKY_BARS.length
  const chord = LUCKY_BARS[bar]
  const s = step % 16
  const swing = s % 4 === 2 ? LUCKY_SWING : 0 // a light groove swing on the offbeats
  if (s === 0 || s === 8) luckyKick(ac, dest, t)
  if (s === 0) chord.pad.forEach((f, i) => bell(ac, f, t + i * 0.006, 0.7, 0.02, dest)) // low pad = body
  const hit = LUCKY_BASS_HITS[s]
  if (hit) luckyBass(ac, dest, chord.bass * hit, t) // the groove (root + octave pops)
  if (s % 2 === 0) {
    const note = LUCKY_MELODY[bar * 8 + (s >> 1)]
    if (note) bell(ac, note, t + swing, 0.26, 0.05, dest) // the riff
  }
  if (s === 2 || s === 6 || s === 10 || s === 14) luckyShaker(ac, dest, t + swing, s === 6 || s === 14)
}

let luckyTimer: ReturnType<typeof setInterval> | null = null
let luckyStepIdx = 0
let luckyNext = 0
let luckyBus: GainNode | null = null

// Start the bed (deal -> open). Same lookahead scheduler as the other beds; kept low so it sits under
// the reels and readouts. No-op if sound is off or it is already running.
export function startLuckyBgm(): void {
  if (!enabled || luckyTimer) return
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume()
  const bus = ac.createGain()
  bus.gain.setValueAtTime(0.0001, ac.currentTime)
  bus.gain.exponentialRampToValueAtTime(0.24, ac.currentTime + 0.5) // a touch more present, room for the bass
  bus.connect(out(ac))
  luckyBus = bus
  luckyStepIdx = 0
  luckyNext = ac.currentTime + 0.08
  luckyTimer = setInterval(() => {
    if (!ac || !luckyBus) return
    while (luckyNext < ac.currentTime + 0.1) {
      luckyStepAt(ac, luckyBus, luckyStepIdx, luckyNext)
      luckyNext += LUCKY_STEP
      luckyStepIdx = (luckyStepIdx + 1) % LUCKY_STEPS
    }
  }, 25)
}

// Stop the bed with a quick fade so it never clicks off and the resolve sting lands clean. Safe to
// call when nothing is playing.
export function stopLuckyBgm(): void {
  if (luckyTimer) {
    clearInterval(luckyTimer)
    luckyTimer = null
  }
  const bus = luckyBus
  luckyBus = null
  if (bus && ctx) {
    const now = ctx.currentTime
    bus.gain.cancelScheduledValues(now)
    bus.gain.setValueAtTime(Math.max(0.0001, bus.gain.value), now)
    bus.gain.exponentialRampToValueAtTime(0.0001, now + 0.2)
    setTimeout(() => bus.disconnect(), 300)
  }
}

// Jackpot win: a warm sub boom under a bright ascending major arpeggio (C up two octaves) with a
// twinkling sparkle tail. The payout climb. Triumphant and fun, never cheesy.
export function luckyWin(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume()
  const t = ac.currentTime
  const o = ac.createOscillator()
  const g = ac.createGain()
  o.type = 'sine'
  o.frequency.setValueAtTime(95, t)
  o.frequency.exponentialRampToValueAtTime(48, t + 0.5)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.22, t + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7)
  o.connect(g).connect(out(ac))
  o.start(t)
  o.stop(t + 0.72)
  const climb = [523.25, 659.25, 783.99, 1046.5, 1318.51, 1567.98] // C E G C E G
  climb.forEach((f, i) => bell(ac, f, t + 0.04 + i * 0.075, 0.42, 0.055))
  const spark = [2093.0, 2637.0, 1975.5, 2349.3]
  spark.forEach((f, i) => bell(ac, f, t + 0.52 + i * 0.07, 0.18, 0.02)) // high twinkle tail
}

// Cash-out: a confident two-note bell climb (G5 -> C6) topped with a sparkle, over a soft body. The
// "locked it in" chime, distinct from a held jackpot so cashing out feels like its own win.
export function luckyCashout(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume()
  const t = ac.currentTime
  const o = ac.createOscillator()
  const g = ac.createGain()
  o.type = 'sine'
  o.frequency.setValueAtTime(110, t)
  o.frequency.exponentialRampToValueAtTime(70, t + 0.22)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.12, t + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28)
  o.connect(g).connect(out(ac))
  o.start(t)
  o.stop(t + 0.3)
  bell(ac, 783.99, t, 0.22, 0.06) // G5
  bell(ac, 1046.5, t + 0.1, 0.32, 0.065) // C6
  bell(ac, 1567.98, t + 0.22, 0.2, 0.03) // G6 sparkle
}

// Miss: a soft low sigh under a gentle descending minor third on the mallet (E4 -> C4). Acknowledges
// the loss, warm and brief, never a harsh nag.
export function luckyLose(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  if (ac.state === 'suspended') void ac.resume()
  const t = ac.currentTime
  const o = ac.createOscillator()
  const g = ac.createGain()
  const f = ac.createBiquadFilter()
  o.type = 'sine'
  o.frequency.setValueAtTime(220, t)
  o.frequency.exponentialRampToValueAtTime(150, t + 0.45)
  f.type = 'lowpass'
  f.frequency.setValueAtTime(1200, t)
  f.frequency.exponentialRampToValueAtTime(500, t + 0.4)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.09, t + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55)
  o.connect(f).connect(g).connect(out(ac))
  o.start(t)
  o.stop(t + 0.58)
  bell(ac, 329.63, t + 0.02, 0.3, 0.04) // E4
  bell(ac, 261.63, t + 0.16, 0.42, 0.04) // C4
}

// --- Flappy Piper voices. A calm, loopable synth bed for the run plus two punchy one-shots: a
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
