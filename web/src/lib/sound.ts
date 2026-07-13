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
  // Backgrounding a standalone PWA can leave the context 'closed'. A stale closed context would
  // otherwise sit here forever producing silent no-ops, so drop it and build a fresh one.
  if (ctx && ctx.state === 'closed') {
    ctx = null
    synthBus = null
  }
  if (!ctx) ctx = new Ctx()
  return ctx
}

// iOS Safari has a non-standard 'interrupted' state (backgrounding a standalone PWA) that the
// spec's 'suspended'/'running'/'closed' enum doesn't cover. Code that only checked for
// 'suspended' never resumed an interrupted context, so it stayed silent until the whole app was
// killed and reopened. Treat anything other than 'running' as needing a resume.
function ensureRunning(ac: AudioContext): void {
  if (ac.state !== 'running') ac.resume().catch(() => {})
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
    stopRangeBgm()
    stopMoonshotBgm()
    stopRideBgm()
  }
}

// Unlock the synth AudioContext on the first real user gesture. Every voice resumes the context
// per-call, but those calls fire after an async settle, which is outside the gesture window on
// mobile Safari and silently fails to unlock. The bed/stings then stay dead on a phone even though
// they work on a lenient desktop. Call this from the shell's first pointerdown (next to the device
// SFX unlock) so the context is live before any sound is asked for.
export function unlockAudio(): void {
  const ac = audio()
  if (ac) ensureRunning(ac)
}

// Re-arm the synth context when the app returns to the foreground. A backgrounded standalone PWA
// on iOS drops the AudioContext into 'interrupted' (or drains it to 'closed' under memory
// pressure); without this, sound/music stayed dead until the whole app was force-quit and
// reopened, because nothing ever prompted a resume until the next sound happened to fire.
if (typeof document !== 'undefined') {
  const onForeground = () => {
    if (document.visibilityState === 'visible') unlockAudio()
  }
  document.addEventListener('visibilitychange', onForeground)
  window.addEventListener('pageshow', onForeground)
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
  ensureRunning(ac)
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

// Achievement unlocked: an elegant little fanfare, fancy not silly. A deep bass swell anchors a lush
// Cmaj9 chord (the maj7 + 9th are the "fancy" color) that blooms like a slow harp roll on the warm
// bell voice, lifted by one soft high shimmer. Refined, weighted with bass, no arcade sweep. Fired
// when the unlock overlay appears (always over a real gesture, a play just settled).
export function achievementUnlock(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  ensureRunning(ac)
  const t = ac.currentTime

  // Bass foundation: a deep sub plus a filtered low octave for body. Swells in soft, holds, fades long,
  // the weight under the chord (felt more than heard), never a thud.
  const sub = ac.createOscillator()
  const subG = ac.createGain()
  sub.type = 'sine'
  sub.frequency.setValueAtTime(65.41, t) // C2
  subG.gain.setValueAtTime(0.0001, t)
  subG.gain.exponentialRampToValueAtTime(0.2, t + 0.13)
  subG.gain.exponentialRampToValueAtTime(0.0001, t + 1.6)
  sub.connect(subG).connect(out(ac))
  sub.start(t)
  sub.stop(t + 1.65)

  const low = ac.createOscillator()
  const lowG = ac.createGain()
  const lowF = ac.createBiquadFilter()
  low.type = 'triangle'
  low.frequency.setValueAtTime(130.81, t) // C3
  lowF.type = 'lowpass'
  lowF.frequency.value = 520
  lowG.gain.setValueAtTime(0.0001, t)
  lowG.gain.exponentialRampToValueAtTime(0.085, t + 0.15)
  lowG.gain.exponentialRampToValueAtTime(0.0001, t + 1.25)
  low.connect(lowF).connect(lowG).connect(out(ac))
  low.start(t)
  low.stop(t + 1.3)

  // The chord over the C bass: E G B D = Cmaj9, the lush "fancy" color. Bloomed a few ms apart like a
  // soft harp roll so it reads as one rich chord, not an arpeggio. Warm bell voice, long mellow tails.
  const chord: Array<[number, number]> = [
    [329.63, 0.0], // E4  (3rd)
    [392.0, 0.06], // G4  (5th)
    [493.88, 0.12], // B4  (maj7)
    [587.33, 0.19], // D5  (9th)
  ]
  for (const [freq, dt] of chord) bell(ac, freq, t + dt, 1.1, 0.05)

  // One gentle high shimmer a beat later for the lift, kept quiet so it lands refined, not twinkly.
  bell(ac, 987.77, t + 0.4, 0.9, 0.03) // B5
  bell(ac, 1318.51, t + 0.52, 0.7, 0.016) // E6, a whisper of air
}

export function sound(kind: Sound): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  ensureRunning(ac)
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
  ensureRunning(ac)
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
  ensureRunning(ac)
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
  ensureRunning(ac)
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
  ensureRunning(ac)
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
  ensureRunning(ac)
  const bus = ac.createGain()
  bus.gain.setValueAtTime(0.0001, ac.currentTime)
  bus.gain.exponentialRampToValueAtTime(0.24, ac.currentTime + 0.5) // a touch more present, room for the bass
  bus.connect(out(ac))
  luckyBus = bus
  luckyStepIdx = 0
  luckyNext = ac.currentTime + 0.08
  luckyTimer = setInterval(() => {
    if (!ac || !luckyBus || ac.state !== 'running') return
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
  ensureRunning(ac)
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
  ensureRunning(ac)
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
  ensureRunning(ac)
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
  ensureRunning(ac)
  const bus = ac.createGain()
  bus.gain.setValueAtTime(0.0001, ac.currentTime)
  bus.gain.exponentialRampToValueAtTime(0.3, ac.currentTime + 0.6) // ease the bed in (kept low: it's a bed)
  bus.connect(out(ac))
  bgmBus = bus
  bgmStepIdx = 0
  bgmNext = ac.currentTime + 0.08
  bgmTimer = setInterval(() => {
    if (!ac || !bgmBus || ac.state !== 'running') return
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
  ensureRunning(ac)
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
  ensureRunning(ac)
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
  ensureRunning(ac)
  const bus = ac.createGain()
  bus.gain.setValueAtTime(0.0001, ac.currentTime)
  bus.gain.exponentialRampToValueAtTime(0.26, ac.currentTime + 0.4)
  bus.connect(out(ac))
  rangeBus = bus
  rangeStepIdx = 0
  rangeNext = ac.currentTime + 0.08
  rangeTimer = setInterval(() => {
    if (!ac || !rangeBus || ac.state !== 'running') return
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
  ensureRunning(ac)
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
  ensureRunning(ac)
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
  ensureRunning(ac)
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
  ensureRunning(ac)
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
  ensureRunning(ac)
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

// --- Moonshot voices. A driving, euphoric synth engine, its own world clear of Lucky's funk and Range's
// dark tense techno. Four-on-the-floor drive, a pumping offbeat bass, big detuned supersaw chord pads for
// the wide euphoric body, and a continuous flowing supersaw ARP as the hook (smooth and rich, not the old
// sparse sproingy pluck). G minor at 150, intense and uplifting, but complete and satisfying on every loop.
// Around it: a launch "fire", a direction-flip tick, and the win/cash-out/miss resolves.

const MOON_TEMPO = 150
const MOON_STEP = 60 / MOON_TEMPO / 4 // sixteenth-note length, seconds
const MOON_STEPS = 64 // 4 bars
const MOON_BAR_LEN = MOON_STEP * 16 // one bar, seconds (how long the pad holds)
// Gm - Eb - Bb - F (i - VI - III - VII): a warm, uplifting circular loop that never touches the tense V,
// so it drives without straining. F (bVII) steps right back up to Gm at the loop point.
// pad = the supersaw chord voicing (root up to the octave); arp = the five hook tones, low to high.
const MOON_BARS = [
  { bass: 98.0, pad: [196.0, 233.08, 293.66, 392.0], arp: [293.66, 392.0, 466.16, 587.33, 783.99] }, // Gm
  { bass: 77.78, pad: [155.56, 196.0, 233.08, 311.13], arp: [311.13, 392.0, 466.16, 622.25, 783.99] }, // Eb
  { bass: 116.54, pad: [233.08, 293.66, 349.23, 466.16], arp: [233.08, 293.66, 349.23, 466.16, 587.33] }, // Bb
  { bass: 87.31, pad: [174.61, 220.0, 261.63, 349.23], arp: [349.23, 440.0, 523.25, 698.46, 880.0] }, // F
]
// Four-on-the-floor: the relentless drive under everything.
const MOON_KICKS = new Set([0, 4, 8, 12])
// The hook: a bouncing up-down arp figure over the five chord tones, one note per sixteenth. Same shape
// every bar, so the harmony does the moving and the figure stays something you lock onto, not a scale run.
const MOON_ARP = [0, 2, 4, 2, 1, 3, 4, 3, 0, 2, 4, 2, 1, 2, 3, 4]

function moonKick(ac: AudioContext, dest: AudioNode, t: number): void {
  const o = ac.createOscillator()
  const g = ac.createGain()
  o.type = 'sine'
  o.frequency.setValueAtTime(170, t)
  o.frequency.exponentialRampToValueAtTime(48, t + 0.11)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.22, t + 0.005)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.19)
  o.connect(g).connect(dest)
  o.start(t)
  o.stop(t + 0.21)
}

// The pumping offbeat bass: a punchy saw through a low lowpass plus a sine sub, short and tight. It lands
// on the "and" of every beat, filling the gaps between the kicks so the low end never stops moving.
function moonBass(ac: AudioContext, dest: AudioNode, freq: number, t: number): void {
  const o = ac.createOscillator()
  const g = ac.createGain()
  const f = ac.createBiquadFilter()
  o.type = 'sawtooth'
  o.frequency.setValueAtTime(freq, t)
  f.type = 'lowpass'
  f.frequency.value = 620
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.11, t + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
  o.connect(f).connect(g).connect(dest)
  o.start(t)
  o.stop(t + 0.18)
  const sub = ac.createOscillator()
  const sg = ac.createGain()
  sub.type = 'sine'
  sub.frequency.setValueAtTime(freq, t)
  sg.gain.setValueAtTime(0.0001, t)
  sg.gain.exponentialRampToValueAtTime(0.09, t + 0.01)
  sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.15)
  sub.connect(sg).connect(dest)
  sub.start(t)
  sub.stop(t + 0.17)
}

// Big detuned-saw PAD: two saws a few cents apart through a lowpass, slow swell, held across the bar, long
// release. The wide euphoric chord bed the arp rides on. Spawned as a chord at the top of each bar.
function moonPad(ac: AudioContext, dest: AudioNode, freq: number, t: number, dur: number): void {
  const o = ac.createOscillator()
  const d = ac.createOscillator()
  const g = ac.createGain()
  const f = ac.createBiquadFilter()
  o.type = 'sawtooth'
  d.type = 'sawtooth'
  o.frequency.setValueAtTime(freq, t)
  d.frequency.setValueAtTime(freq, t)
  o.detune.setValueAtTime(-10, t)
  d.detune.setValueAtTime(10, t) // a few cents apart = the wide supersaw shimmer
  f.type = 'lowpass'
  f.Q.value = 1
  f.frequency.setValueAtTime(900, t)
  f.frequency.linearRampToValueAtTime(1700, t + dur * 0.5) // a gentle breathing open
  f.frequency.linearRampToValueAtTime(1100, t + dur)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.028, t + 0.08) // slow swell in
  g.gain.setValueAtTime(0.028, t + dur * 0.6)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur) // long release out
  o.connect(f)
  d.connect(f)
  f.connect(g).connect(dest)
  o.start(t)
  o.stop(t + dur + 0.06)
  d.start(t)
  d.stop(t + dur + 0.06)
}

// The hook: a bright detuned-saw arp pluck. Two saws through a lowpass with a touch of resonance for the
// classic trance edge, fast attack and a short decay so each sixteenth is articulate but the line flows.
function moonArp(ac: AudioContext, dest: AudioNode, freq: number, t: number): void {
  const o = ac.createOscillator()
  const d = ac.createOscillator()
  const g = ac.createGain()
  const f = ac.createBiquadFilter()
  o.type = 'sawtooth'
  d.type = 'sawtooth'
  o.frequency.setValueAtTime(freq, t)
  d.frequency.setValueAtTime(freq, t)
  o.detune.setValueAtTime(-7, t)
  d.detune.setValueAtTime(7, t)
  f.type = 'lowpass'
  f.frequency.value = 3000
  f.Q.value = 2.5
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.04, t + 0.004)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14)
  o.connect(f)
  d.connect(f)
  f.connect(g).connect(dest)
  o.start(t)
  o.stop(t + 0.16)
  d.start(t)
  d.stop(t + 0.16)
}

// The riff pluck: a resonant saw blip, bright but short, the tense "countdown" voice.
function moonPluck(ac: AudioContext, dest: AudioNode, freq: number, t: number): void {
  const o = ac.createOscillator()
  const g = ac.createGain()
  const f = ac.createBiquadFilter()
  o.type = 'sawtooth'
  o.frequency.setValueAtTime(freq, t)
  f.type = 'lowpass'
  f.frequency.value = 2600
  f.Q.value = 8 // resonant edge, tense
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.045, t + 0.005)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
  o.connect(f).connect(g).connect(dest)
  o.start(t)
  o.stop(t + 0.18)
}

// Backbeat clap: a short wide noise burst through a bandpass, the snap on beats 2 and 4.
function moonClap(ac: AudioContext, dest: AudioNode, t: number): void {
  const src = ac.createBufferSource()
  const f = ac.createBiquadFilter()
  const g = ac.createGain()
  src.buffer = noise(ac)
  f.type = 'bandpass'
  f.Q.value = 0.7
  f.frequency.value = 1900
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.055, t + 0.005)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13)
  src.connect(f).connect(g).connect(dest)
  src.start(t)
  src.stop(t + 0.15)
}

function moonHat(ac: AudioContext, dest: AudioNode, t: number, accent: boolean): void {
  const src = ac.createBufferSource()
  const f = ac.createBiquadFilter()
  const g = ac.createGain()
  src.buffer = noise(ac)
  f.type = 'highpass'
  f.frequency.value = 8200
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(accent ? 0.03 : 0.018, t + 0.004)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04)
  src.connect(f).connect(g).connect(dest)
  src.start(t)
  src.stop(t + 0.05)
}

// One sixteenth of the engine: the supersaw pad chord at the top of each bar, the four-on-the-floor kick,
// the backbeat clap on 2 and 4, the pumping offbeat bass, the flowing arp hook every step, and 8th hats
// with the offbeat accented (the trance "tss").
function moonStepAt(ac: AudioContext, dest: AudioNode, step: number, t: number): void {
  const bar = Math.floor(step / 16) % MOON_BARS.length
  const chord = MOON_BARS[bar]
  const s = step % 16
  if (s === 0) chord.pad.forEach((f, i) => moonPad(ac, dest, f, t + i * 0.008, MOON_BAR_LEN * 0.99))
  if (MOON_KICKS.has(s)) moonKick(ac, dest, t)
  if (s === 4 || s === 12) moonClap(ac, dest, t) // backbeat on beats 2 and 4
  const offbeat = s === 2 || s === 6 || s === 10 || s === 14
  if (offbeat) moonBass(ac, dest, chord.bass, t) // the pump, between the kicks
  moonArp(ac, dest, chord.arp[MOON_ARP[s]], t) // the hook, every sixteenth
  if (s % 2 === 0) moonHat(ac, dest, t, offbeat)
}

let moonTimer: ReturnType<typeof setInterval> | null = null
let moonStepIdx = 0
let moonNext = 0
let moonBus: GainNode | null = null

// Start the bed (fire -> open). Same lookahead scheduler as the other beds, kept low so it sits under
// the chart + readouts. No-op if sound is off or it is already running.
export function startMoonshotBgm(): void {
  if (!enabled || moonTimer) return
  const ac = audio()
  if (!ac) return
  ensureRunning(ac)
  const bus = ac.createGain()
  bus.gain.setValueAtTime(0.0001, ac.currentTime)
  bus.gain.exponentialRampToValueAtTime(0.26, ac.currentTime + 0.5) // driving, present, but still a bed
  bus.connect(out(ac))
  moonBus = bus
  moonStepIdx = 0
  moonNext = ac.currentTime + 0.08
  moonTimer = setInterval(() => {
    if (!ac || !moonBus || ac.state !== 'running') return
    while (moonNext < ac.currentTime + 0.1) {
      moonStepAt(ac, moonBus, moonStepIdx, moonNext)
      moonNext += MOON_STEP
      moonStepIdx = (moonStepIdx + 1) % MOON_STEPS
    }
  }, 25)
}

export function stopMoonshotBgm(): void {
  if (moonTimer) {
    clearInterval(moonTimer)
    moonTimer = null
  }
  const bus = moonBus
  moonBus = null
  if (bus && ctx) {
    const now = ctx.currentTime
    bus.gain.cancelScheduledValues(now)
    bus.gain.setValueAtTime(Math.max(0.0001, bus.gain.value), now)
    bus.gain.exponentialRampToValueAtTime(0.0001, now + 0.22)
    setTimeout(() => bus.disconnect(), 360)
  }
}

// Ignition on PLAY: a deep launch thump under a fast rising filtered-noise whoosh and a tense three-note
// saw climb. "We have liftoff", punchy and committal.
export function moonshotFire(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  ensureRunning(ac)
  const t = ac.currentTime
  // launch thump
  const o = ac.createOscillator()
  const g = ac.createGain()
  o.type = 'sine'
  o.frequency.setValueAtTime(150, t)
  o.frequency.exponentialRampToValueAtTime(44, t + 0.22)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.22, t + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34)
  o.connect(g).connect(out(ac))
  o.start(t)
  o.stop(t + 0.36)
  // rising whoosh
  const src = ac.createBufferSource()
  src.buffer = noise(ac)
  const f = ac.createBiquadFilter()
  f.type = 'bandpass'
  f.Q.value = 0.9
  f.frequency.setValueAtTime(300, t)
  f.frequency.exponentialRampToValueAtTime(3200, t + 0.34)
  const ng = ac.createGain()
  ng.gain.setValueAtTime(0.0001, t)
  ng.gain.exponentialRampToValueAtTime(0.05, t + 0.08)
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.4)
  src.connect(f).connect(ng).connect(out(ac))
  src.start(t)
  src.stop(t + 0.44)
  // tense saw climb (G minor pull-up: D4 -> F4 -> G4)
  const climb = [293.66, 349.23, 392.0]
  climb.forEach((freq, i) => moonPluck(ac, out(ac), freq, t + 0.04 + i * 0.06))
}

// Direction flip: a crisp mechanical tick (a noise detent + a short triangle), neutral so toggling
// either way reads the same.
export function moonshotFlip(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  ensureRunning(ac)
  const t = ac.currentTime
  const src = ac.createBufferSource()
  src.buffer = noise(ac)
  const f = ac.createBiquadFilter()
  f.type = 'highpass'
  f.frequency.value = 4200
  const ng = ac.createGain()
  ng.gain.setValueAtTime(0.0001, t)
  ng.gain.exponentialRampToValueAtTime(0.02, t + 0.002)
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.035)
  src.connect(f).connect(ng).connect(out(ac))
  src.start(t)
  src.stop(t + 0.05)
  blip(ac, 560, t + 0.004, 0.07, 0.035)
}

// Win: the tension resolves G minor -> G major. A low boom under a bright ascending G-major arpeggio
// (G B D G B), topped with a sparkle. Triumphant and distinct from Lucky's C climb / Range's D chord.
export function moonshotWin(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  ensureRunning(ac)
  const t = ac.currentTime
  const o = ac.createOscillator()
  const g = ac.createGain()
  o.type = 'sine'
  o.frequency.setValueAtTime(98, t)
  o.frequency.exponentialRampToValueAtTime(49, t + 0.5)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.22, t + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7)
  o.connect(g).connect(out(ac))
  o.start(t)
  o.stop(t + 0.72)
  const climb = [392.0, 493.88, 587.33, 783.99, 987.77] // G4 B4 D5 G5 B5 (G major)
  climb.forEach((f, i) => bell(ac, f, t + 0.04 + i * 0.075, 0.42, 0.055))
  const spark = [1567.98, 1975.53, 2349.32]
  spark.forEach((f, i) => bell(ac, f, t + 0.5 + i * 0.07, 0.18, 0.02))
}

// Cash-out: a confident rising fourth (D5 -> G5) topped with a sparkle, over a soft body. The "locked
// it in" chime, its own interval so it never sounds like the held win.
export function moonshotCashout(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  ensureRunning(ac)
  const t = ac.currentTime
  const o = ac.createOscillator()
  const g = ac.createGain()
  o.type = 'sine'
  o.frequency.setValueAtTime(116, t)
  o.frequency.exponentialRampToValueAtTime(73, t + 0.22)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.12, t + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28)
  o.connect(g).connect(out(ac))
  o.start(t)
  o.stop(t + 0.3)
  bell(ac, 587.33, t, 0.22, 0.06) // D5
  bell(ac, 783.99, t + 0.1, 0.32, 0.065) // G5
  bell(ac, 1174.66, t + 0.22, 0.2, 0.03) // D6 sparkle
}

// Miss: a soft low sigh under a gentle descending minor third (Bb4 -> G4). Acknowledges the miss,
// warm and brief.
export function moonshotLose(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  ensureRunning(ac)
  const t = ac.currentTime
  const o = ac.createOscillator()
  const g = ac.createGain()
  const f = ac.createBiquadFilter()
  o.type = 'sine'
  o.frequency.setValueAtTime(210, t)
  o.frequency.exponentialRampToValueAtTime(140, t + 0.45)
  f.type = 'lowpass'
  f.frequency.setValueAtTime(1200, t)
  f.frequency.exponentialRampToValueAtTime(480, t + 0.4)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.09, t + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55)
  o.connect(f).connect(g).connect(out(ac))
  o.start(t)
  o.stop(t + 0.58)
  bell(ac, 466.16, t + 0.02, 0.3, 0.04) // Bb4
  bell(ac, 392.0, t + 0.16, 0.42, 0.04) // G4
}

// --- Line Rider voices. A dreamy synthwave glide, its own world: slow 90bpm, bright E major, a soft
// pad sky over a gliding pluck arp and a round synth bass, almost no drums. What makes it unique is
// that the bed is *adaptive*, it listens to the run. One tone filter wraps the whole bed and opens as
// the line speeds up (so the run audibly builds), brightens while you hug the line and goes underwater
// when you drift off (staying on the line literally sounds better), a low heartbeat throbs in as grip
// runs low, and the arp sparkles an octave up once your combo is hot. Nothing like Lucky's funk,
// Range's tension, or Flappy's cheer. Non-intrusive by design: soft and muffled at rest, never a wall.

const RIDE_TEMPO = 90
const RIDE_STEP = 60 / RIDE_TEMPO / 4 // sixteenth-note length, seconds
// vi - IV - I - V in E major (C#m9 - Amaj9 - Emaj9 - Bsus4): the nostalgic "gliding at dusk" loop, a
// gentle two-feel that never fatigues over a long run. Each bar: a low bass root, a soft three-note
// pad voicing, and four ascending arp tones.
const RIDE_BARS = [
  { bass: 69.3, pad: [164.81, 207.65, 246.94], arp: [277.18, 329.63, 415.3, 493.88] }, // C#m9
  { bass: 110.0, pad: [220.0, 277.18, 329.63], arp: [277.18, 329.63, 440.0, 493.88] }, // Amaj9
  { bass: 82.41, pad: [207.65, 246.94, 329.63], arp: [329.63, 415.3, 493.88, 622.25] }, // Emaj9
  { bass: 123.47, pad: [185.0, 246.94, 329.63], arp: [369.99, 493.88, 554.37, 659.25] }, // Bsus4
]
const RIDE_STEPS = RIDE_BARS.length * 16
// A rolling up-down glide with breaths (-1 = rest), so the arp reads as flowing motion, not a machine gun.
const RIDE_ARP = [0, -1, 2, 1, -1, 3, 2, -1, 0, 1, -1, 3, 2, -1, 1, -1]

// A soft, wide pad voice: a slightly detuned triangle+sine pair through a gentle lowpass, slow swell,
// long release. Spawned as a chord at each bar to hold the "sky" under the pluck.
function ridePad(ac: AudioContext, dest: AudioNode, freq: number, t: number, dur: number): void {
  const o = ac.createOscillator()
  const d = ac.createOscillator()
  const g = ac.createGain()
  const f = ac.createBiquadFilter()
  o.type = 'triangle'
  d.type = 'sine'
  o.frequency.setValueAtTime(freq, t)
  d.frequency.setValueAtTime(freq * 1.005, t) // a hair of detune for width
  f.type = 'lowpass'
  f.frequency.value = Math.min(freq * 4, 3000)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.022, t + 0.4) // slow swell in
  g.gain.setValueAtTime(0.022, t + dur * 0.5)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur) // long release out
  o.connect(f)
  d.connect(f)
  f.connect(g).connect(dest)
  o.start(t)
  o.stop(t + dur + 0.05)
  d.start(t)
  d.stop(t + dur + 0.05)
}

// A round synth bass: a saw body through a low lowpass plus a sine sub, soft and a touch longer than
// the other beds so it sustains like synthwave rather than plucks.
function rideBass(ac: AudioContext, dest: AudioNode, freq: number, t: number): void {
  const o = ac.createOscillator()
  const g = ac.createGain()
  const f = ac.createBiquadFilter()
  o.type = 'sawtooth'
  o.frequency.setValueAtTime(freq, t)
  f.type = 'lowpass'
  f.frequency.value = 420
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.09, t + 0.016)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34)
  o.connect(f).connect(g).connect(dest)
  o.start(t)
  o.stop(t + 0.36)
  const sub = ac.createOscillator()
  const sg = ac.createGain()
  sub.type = 'sine'
  sub.frequency.setValueAtTime(freq, t)
  sg.gain.setValueAtTime(0.0001, t)
  sg.gain.exponentialRampToValueAtTime(0.08, t + 0.014)
  sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.3)
  sub.connect(sg).connect(dest)
  sub.start(t)
  sub.stop(t + 0.32)
}

// A soft, rounded kick, lighter than the other beds: this groove stays gentle.
function rideKick(ac: AudioContext, dest: AudioNode, t: number): void {
  const o = ac.createOscillator()
  const g = ac.createGain()
  o.type = 'sine'
  o.frequency.setValueAtTime(120, t)
  o.frequency.exponentialRampToValueAtTime(46, t + 0.1)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.12, t + 0.006)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
  o.connect(g).connect(dest)
  o.start(t)
  o.stop(t + 0.2)
}

// A brushed offbeat tick (filtered noise), kept very quiet so it's texture, not a hi-hat.
function rideTick(ac: AudioContext, dest: AudioNode, t: number, accent: boolean): void {
  const src = ac.createBufferSource()
  src.buffer = noise(ac)
  const f = ac.createBiquadFilter()
  f.type = 'highpass'
  f.frequency.value = 6500
  const g = ac.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(accent ? 0.016 : 0.009, t + 0.004)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04)
  src.connect(f).connect(g).connect(dest)
  src.start(t)
  src.stop(t + 0.05)
}

// A low heartbeat that pulses in only when grip runs low: felt more than heard, it makes danger audible
// alongside the red vignette.
function rideThrob(ac: AudioContext, dest: AudioNode, t: number): void {
  const o = ac.createOscillator()
  const g = ac.createGain()
  o.type = 'sine'
  o.frequency.setValueAtTime(58, t)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.07, t + 0.04)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4)
  o.connect(g).connect(dest)
  o.start(t)
  o.stop(t + 0.42)
}

// One sixteenth of the glide: a pad chord at each bar, a pulsing bass, the gliding pluck (sparkling an
// octave up once the combo is hot), and the drums + heartbeat the adaptive state gates in.
function rideStepAt(ac: AudioContext, dest: AudioNode, step: number, t: number): void {
  const bar = Math.floor(step / 16) % RIDE_BARS.length
  const chord = RIDE_BARS[bar]
  const s = step % 16
  if (s === 0) chord.pad.forEach((f, i) => ridePad(ac, dest, f, t + i * 0.01, 3.1)) // the sky
  if (s === 0 || s === 4 || s === 8 || s === 12) rideBass(ac, dest, chord.bass, t)
  if (s === 6 || s === 14) rideBass(ac, dest, chord.bass * 2, t) // octave pop for a synthwave bounce
  const ai = RIDE_ARP[s]
  if (ai >= 0) {
    bell(ac, chord.arp[ai], t, 0.2, 0.035, dest) // the gliding pluck
    if (rideMult > 3) bell(ac, chord.arp[ai] * 2, t, 0.14, 0.013, dest) // a hot combo sparkles up high
  }
  // Drums fade in as the run speeds up: the opening stays dreamy/ambient, then the groove arrives.
  if (rideIntensity > 0.12 && (s === 0 || s === 8)) rideKick(ac, dest, t)
  if (rideIntensity > 0.2 && (s === 2 || s === 6 || s === 10 || s === 14)) rideTick(ac, dest, t, s === 6 || s === 14)
  if (rideGripLow && (s === 0 || s === 8)) rideThrob(ac, dest, t) // tension under low grip
}

let rideTimer: ReturnType<typeof setInterval> | null = null
let rideStepIdx = 0
let rideNext = 0
let rideBedBus: GainNode | null = null
let rideTone: BiquadFilterNode | null = null
// Adaptive state, fed from the run by setRideState and read by the scheduler + the tone filter.
let rideIntensity = 0
let rideGripLow = false
let rideMult = 1

// Start the glide. The whole bed runs through one lowpass `rideTone` that the run drives (see
// setRideState): it opens as the line speeds up and brightens while you hug it. Same lookahead
// scheduler as the other beds. No-op if sound is off or it is already running.
export function startRideBgm(): void {
  if (!enabled || rideTimer) return
  const ac = audio()
  if (!ac) return
  ensureRunning(ac)
  const bus = ac.createGain()
  bus.gain.setValueAtTime(0.0001, ac.currentTime)
  bus.gain.exponentialRampToValueAtTime(0.2, ac.currentTime + 0.8) // ease in, dreamy (it's a bed)
  const tone = ac.createBiquadFilter()
  tone.type = 'lowpass'
  tone.frequency.value = 700 // starts soft/underwater; setRideState opens it with the run
  tone.Q.value = 0.7
  bus.connect(tone).connect(out(ac))
  rideBedBus = bus
  rideTone = tone
  rideIntensity = 0
  rideGripLow = false
  rideMult = 1
  rideStepIdx = 0
  rideNext = ac.currentTime + 0.1
  rideTimer = setInterval(() => {
    if (!ac || !rideBedBus || ac.state !== 'running') return
    while (rideNext < ac.currentTime + 0.1) {
      rideStepAt(ac, rideBedBus, rideStepIdx, rideNext)
      rideNext += RIDE_STEP
      rideStepIdx = (rideStepIdx + 1) % RIDE_STEPS
    }
  }, 25)
}

export function stopRideBgm(): void {
  if (rideTimer) {
    clearInterval(rideTimer)
    rideTimer = null
  }
  const bus = rideBedBus
  const tone = rideTone
  rideBedBus = null
  rideTone = null
  if (bus && ctx) {
    const now = ctx.currentTime
    bus.gain.cancelScheduledValues(now)
    bus.gain.setValueAtTime(Math.max(0.0001, bus.gain.value), now)
    bus.gain.exponentialRampToValueAtTime(0.0001, now + 0.3)
    setTimeout(() => {
      bus.disconnect()
      tone?.disconnect()
    }, 420)
  }
}

// The run feeds the bed its live state every HUD tick (~20Hz). intensity (0..1, the difficulty ramp)
// and onLine drive the tone filter: brighter as the line speeds up, brighter still while hugging it,
// underwater when you drift off. gripLow + mult are read by the scheduler for the heartbeat + sparkle.
export function setRideState(s: { intensity: number; onLine: boolean; gripLow: boolean; mult: number }): void {
  rideIntensity = s.intensity
  rideGripLow = s.gripLow
  rideMult = s.mult
  if (!rideTone || !ctx) return
  const now = ctx.currentTime
  const base = 600 + Math.max(0, Math.min(1, s.intensity)) * 3600 // 600 -> 4200 Hz across the ramp
  const target = Math.max(400, Math.min(6000, base * (s.onLine ? 1 : 0.5))) // off-line = underwater
  rideTone.frequency.cancelScheduledValues(now)
  rideTone.frequency.setValueAtTime(rideTone.frequency.value, now)
  rideTone.frequency.linearRampToValueAtTime(target, now + 0.12)
}

// Takeoff: a rising airy whoosh under a soft Emaj bloom as the line flows in and the run begins.
export function rideStart(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  ensureRunning(ac)
  const t = ac.currentTime
  const src = ac.createBufferSource()
  src.buffer = noise(ac)
  const f = ac.createBiquadFilter()
  f.type = 'bandpass'
  f.Q.value = 0.7
  f.frequency.setValueAtTime(300, t)
  f.frequency.exponentialRampToValueAtTime(2600, t + 0.45) // sweep up = the line taking off
  const ng = ac.createGain()
  ng.gain.setValueAtTime(0.0001, t)
  ng.gain.exponentialRampToValueAtTime(0.05, t + 0.18)
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.6)
  src.connect(f).connect(ng).connect(out(ac))
  src.start(t)
  src.stop(t + 0.65)
  const bloom = [329.63, 415.3, 493.88, 659.25] // E G# B E, a rising open-major lift
  bloom.forEach((fr, i) => bell(ac, fr, t + 0.05 + i * 0.06, 0.5, 0.04))
}

// Wipeout: the floor drops out (a low sub fall) under a dreamy descending E-pentatonic tumble and an
// airy noise fall through a closing filter. Melancholy, not harsh, the dream collapsing as you fall off.
export function rideCrash(): void {
  if (!enabled) return
  const ac = audio()
  if (!ac) return
  ensureRunning(ac)
  const t = ac.currentTime
  const o = ac.createOscillator()
  const g = ac.createGain()
  o.type = 'sine'
  o.frequency.setValueAtTime(180, t)
  o.frequency.exponentialRampToValueAtTime(40, t + 0.5)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.16, t + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6)
  o.connect(g).connect(out(ac))
  o.start(t)
  o.stop(t + 0.62)
  const tumble = [659.25, 554.37, 493.88, 415.3, 329.63] // E5 C#5 B4 G#4 E4, falling away
  tumble.forEach((fr, i) => bell(ac, fr, t + 0.04 + i * 0.07, 0.3, 0.045))
  const src = ac.createBufferSource()
  src.buffer = noise(ac)
  const f = ac.createBiquadFilter()
  f.type = 'lowpass'
  f.frequency.setValueAtTime(2600, t)
  f.frequency.exponentialRampToValueAtTime(300, t + 0.5)
  const ng = ac.createGain()
  ng.gain.setValueAtTime(0.0001, t)
  ng.gain.exponentialRampToValueAtTime(0.04, t + 0.05)
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.55)
  src.connect(f).connect(ng).connect(out(ac))
  src.start(t)
  src.stop(t + 0.58)
}
