// App-surface UI sound: the tap under a menu button, the flip of a toggle, the swipe when the console
// preset changes, and the flat thud a dead control answers with. Sample based, so this is its own bus,
// separate from sound.ts's synth stings and consoleAudio.ts's hardware clicks. It rides the user's SFX
// fader and the master Sound setting.
//
// Every path is best effort: no context, bytes not in yet, an unsupported file, sound switched off, all
// of it goes silent instead of throwing. A tap is never worth breaking over a sound.
//
// Assets: web/sfx-src/ui-sfx holds the originals, public/sounds/ui-sfx ships them level-matched and
// compressed (mp3 96k mono, except the 10ms taps, where mp3 framing costs more bytes than the samples
// do). Re-encode with: ffmpeg -i in.wav -af volume=NdB -c:a libmp3lame -b:a 96k -ac 1 -ar 44100 out.mp3

import { audioContext, ensureRunning } from './audioContext'

export type UiSfxName = 'tap' | 'toggleOn' | 'toggleOff' | 'swipe' | 'disabled'

interface Family {
  srcs: readonly string[]
  // Trim on top of the level-matching baked into the files, so one number per sound decides how forward
  // it sits. Taps fire hundreds of times a session, so they are by far the quietest.
  gain: number
  // Cents of random detune, so a run of taps never reads as a loop. Toggles and the reject stay dead-on:
  // they are signals, and they should sound identical every time.
  drift: number
}

const FAMILIES: Record<UiSfxName, Family> = {
  tap: {
    srcs: [
      '/sounds/ui-sfx/tap/tap_01.wav',
      '/sounds/ui-sfx/tap/tap_02.wav',
      '/sounds/ui-sfx/tap/tap_03.wav',
      '/sounds/ui-sfx/tap/tap_04.wav',
      '/sounds/ui-sfx/tap/tap_05.wav',
    ],
    gain: 0.45,
    drift: 45,
  },
  // The quietest of the lot on purpose. A preset change is already loud visually (the whole device
  // reskins), so the whoosh only has to acknowledge it, not announce it.
  swipe: {
    srcs: [
      '/sounds/ui-sfx/swipes/swipe_01.mp3',
      '/sounds/ui-sfx/swipes/swipe_02.mp3',
      '/sounds/ui-sfx/swipes/swipe_05.mp3',
    ],
    gain: 0.4,
    drift: 30,
  },
  toggleOn: { srcs: ['/sounds/ui-sfx/toggles/toggle_on.mp3'], gain: 0.95, drift: 0 },
  toggleOff: { srcs: ['/sounds/ui-sfx/toggles/toggle_off.mp3'], gain: 0.95, drift: 0 },
  disabled: { srcs: ['/sounds/ui-sfx/disabled.mp3'], gain: 0.75, drift: 0 },
}

// Master for this bus, set against consoleAudio.ts's fixed SFX_LEVEL (0.25) so chrome sits well under the
// physical console clicks. The hardware is the hero; the menu is a whisper. This is the one knob for how
// loud the whole UI is, the per-family gains below only decide the balance between them.
const UI_LEVEL = 0.2

// Two fires of the same sound inside this window stack into a flam rather than reading as one press, so
// the second is dropped. Long enough to swallow a double-fire, short enough that real fast taps all land.
const MIN_GAP_MS = 40

// A sound that lands later than this reads as unexplained noise rather than as feedback for the tap
// that caused it, so a decode this slow is dropped instead of played. Only ever hit on a cold sample.
const LATE_MS = 350

// Codec priming can open a decoded buffer with silence, which would delay a click that has to feel
// instant. Anything under this is noise floor, not the sample. -54 dBFS.
const ONSET_FLOOR = 0.002

interface Clip {
  buffer: AudioBuffer
  offset: number
}

const clips = new Map<string, Clip>()
const pending = new Map<string, Promise<Clip | null>>()
const bytes = new Map<string, Promise<ArrayBuffer | null>>()
const lastIndex = new Map<UiSfxName, number>()
const lastAt = new Map<UiSfxName, number>()

let enabled = true
let scale = 1
let bus: GainNode | null = null
let busCtx: AudioContext | null = null

// Driven by the user's Sound setting, same as sound.ts. Off means every call below no-ops.
export function setUiSfxEnabled(value: boolean): void {
  enabled = value
}

// The user's SFX fader (0..1), applied on top of UI_LEVEL. Driven from the sounds drawer via audio.ts.
export function setUiSfxVolume(v: number): void {
  scale = Math.max(0, Math.min(1, v))
  if (bus) bus.gain.value = UI_LEVEL * scale
}

// Pull the samples down while the app is idle, so the first tap is not the one paying for the round trip.
// Bytes only: decoding needs an AudioContext, and building one before the first gesture would leave it
// sitting suspended holding memory for nothing.
export function warmUiSfx(): void {
  for (const f of Object.values(FAMILIES)) {
    for (const src of f.srcs) if (!clips.has(src)) void fetchBytes(src)
  }
}

export function uiSfx(name: UiSfxName): void {
  if (!enabled) return
  try {
    const family = FAMILIES[name]
    const now = Date.now()
    if (now - (lastAt.get(name) ?? -Infinity) < MIN_GAP_MS) return
    lastAt.set(name, now)

    const ac = audioContext()
    if (!ac) return
    ensureRunning(ac)

    const src = pick(name, family)
    const ready = clips.get(src)
    if (ready) {
      start(ac, ready, family)
      return
    }
    // Cold. Kick the whole set, not just this one file: samples never repeat back to back, so warming
    // one leaves the next four taps just as cold, which is how the first run of taps came out silent.
    warmUiSfx()
    // The bytes are normally already in from the boot warm, so the decode lands inside a frame or two.
    void decode(ac, src).then((clip) => {
      if (clip && Date.now() - now < LATE_MS) start(ac, clip, family)
    })
  } catch {
    // never worth breaking a tap over
  }
}

function output(ac: AudioContext): AudioNode {
  if (!bus || busCtx !== ac) {
    bus = ac.createGain()
    bus.gain.value = UI_LEVEL * scale
    bus.connect(ac.destination)
    busCtx = ac
  }
  return bus
}

function start(ac: AudioContext, clip: Clip, family: Family): void {
  const node = ac.createBufferSource()
  node.buffer = clip.buffer
  // playbackRate, not detune: same result on a sample this short and it works everywhere.
  if (family.drift) node.playbackRate.value = 2 ** (((Math.random() * 2 - 1) * family.drift) / 1200)
  const gain = ac.createGain()
  gain.gain.value = family.gain
  node.connect(gain).connect(output(ac))
  node.start(0, clip.offset)
}

// Never the same sample twice in a row: the first pick is uniform over the set, every later one is
// uniform over everything except what just played.
function pick(name: UiSfxName, family: Family): string {
  const n = family.srcs.length
  if (n === 1) return family.srcs[0]
  const prev = lastIndex.get(name)
  let i = Math.floor(Math.random() * (prev === undefined ? n : n - 1))
  if (prev !== undefined && i >= prev) i++
  lastIndex.set(name, i)
  return family.srcs[i]
}

function fetchBytes(src: string): Promise<ArrayBuffer | null> {
  let p = bytes.get(src)
  if (!p) {
    p = fetch(src)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null)
    bytes.set(src, p)
  }
  return p
}

function decode(ac: AudioContext, src: string): Promise<Clip | null> {
  let p = pending.get(src)
  if (!p) {
    p = fetchBytes(src)
      .then((buf) => (buf ? ac.decodeAudioData(buf) : null))
      .then((buffer) => {
        if (!buffer) return null
        const clip = { buffer, offset: onsetOf(buffer) }
        clips.set(src, clip)
        return clip
      })
      .catch(() => null)
      .finally(() => {
        // decodeAudioData detaches the ArrayBuffer, so the cached bytes are spent either way. Dropping
        // both entries lets a failed load retry from the http cache on the next tap.
        bytes.delete(src)
        pending.delete(src)
      })
    pending.set(src, p)
  }
  return p
}

// Where the sample actually starts, so codec priming silence never delays the click. Backs off a few
// samples so the leading edge itself survives.
function onsetOf(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0)
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) > ONSET_FLOOR) return Math.max(0, (i - 8) / buffer.sampleRate)
  }
  return 0
}
