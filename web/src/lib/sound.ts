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

// Driven by the user's Sound setting (synced from the auth user). When off, every call no-ops.
export function setSoundEnabled(value: boolean): void {
  enabled = value
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
  osc.connect(g).connect(ac.destination)
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
  osc.connect(g).connect(ac.destination)
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
  osc.connect(g).connect(ac.destination)
  osc.start(t)
  osc.stop(t + 0.14)
  const notes = [880, 1108.7, 1318.5]
  const last = step >= notes.length - 1
  blip(ac, notes[Math.min(step, notes.length - 1)], t + 0.005, last ? 0.22 : 0.13, 0.05)
}
