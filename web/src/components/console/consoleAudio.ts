type SfxKey =
  | 'mainPress'
  | 'mainRelease'
  | 'actionPress'
  | 'actionRelease'
  | 'pillPress'
  | 'pillRelease'
  | 'knob'
  | 'roller'

type ControlId =
  | 'main'
  | 'action1'
  | 'action2'
  | 'menu'
  | 'home'
  | 'knob'
  | 'thumbwheel'

interface Variation {
  cents: number
  gain: number
  cutoff: number
  pan: number
}

interface ControlProfile {
  cents: number
  centsRange: number
  minCentsChange: number
  gain: [number, number]
  cutoff: [number, number]
  pan: number
  filterQ: number
}

const CONTROL_PROFILES: Record<ControlId, ControlProfile> = {
  main: {
    cents: 0, centsRange: 5, minCentsChange: 2,
    gain: [0.97, 1.03], cutoff: [8200, 10500], pan: 0.07, filterQ: 0.35,
  },
  action1: {
    cents: -4, centsRange: 7, minCentsChange: 2.5,
    gain: [0.965, 1.035], cutoff: [7200, 9200], pan: -0.055, filterQ: 0.45,
  },
  action2: {
    cents: 4, centsRange: 7, minCentsChange: 2.5,
    gain: [0.965, 1.035], cutoff: [7200, 9200], pan: 0.025, filterQ: 0.45,
  },
  menu: {
    cents: -3, centsRange: 6, minCentsChange: 2.5,
    gain: [0.96, 1.04], cutoff: [6800, 8800], pan: -0.05, filterQ: 0.4,
  },
  home: {
    cents: 3, centsRange: 6, minCentsChange: 2.5,
    gain: [0.96, 1.04], cutoff: [6800, 8800], pan: 0.02, filterQ: 0.4,
  },
  knob: {
    cents: -5, centsRange: 9, minCentsChange: 3,
    gain: [0.95, 1.04], cutoff: [1050, 1350], pan: 0.07, filterQ: 0.8,
  },
  thumbwheel: {
    cents: 5, centsRange: 8, minCentsChange: 3,
    gain: [0.95, 1.04], cutoff: [1250, 1650], pan: -0.035, filterQ: 0.7,
  },
}

function between(min: number, max: number) {
  return min + Math.random() * (max - min)
}

// Master level for all device SFX. The button/knob/roller samples are decoded at full scale, which
// drowns out the synth game audio in sound.ts. Pull them down to a tactile, balanced level here.
const SFX_LEVEL = 0.25

export function createAudio() {
  let actx: AudioContext | null = null
  let master: GainNode | null = null
  const sfx: Partial<Record<SfxKey, AudioBuffer>> = {}
  const variations: Partial<Record<ControlId, Variation>> = {}

  async function loadSfx() {
    if (!actx) return
    // Paths are case-sensitive in production (Vercel/Linux); macOS local is not, which hid a
    // mismatch here. Match the files on disk exactly. Each sample loads independently so one bad
    // asset can't take the rest down (a shared Promise.all reject did exactly that), and any
    // failure is logged instead of swallowed. The r.ok check stops an HTML 404 fallback from
    // being fed into decodeAudioData as if it were audio.
    const load = async (key: SfxKey, path: string) => {
      try {
        const r = await fetch(path)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        sfx[key] = await actx!.decodeAudioData(await r.arrayBuffer())
      } catch (e) {
        console.warn(`[consoleAudio] failed to load ${path}`, e)
      }
    }
    await Promise.all([
      load('mainPress', '/sounds/MAIN_PRESS.MP3'),
      load('mainRelease', '/sounds/MAIN_RELEASE.MP3'),
      load('actionPress', '/sounds/ACTION_PRESS.MP3'),
      load('actionRelease', '/sounds/ACTION_RELEASE.MP3'),
      load('pillPress', '/sounds/PILL_PRESS.MP3'),
      load('pillRelease', '/sounds/PILL_RELEASE.MP3'),
      load('knob', '/sounds/KNOB_RUBBER.mp3'),
      load('roller', '/sounds/SMALL_ROLLER.MP3'),
    ])
  }

  function nextCents(profile: ControlProfile, previous?: Variation) {
    const min = profile.cents - profile.centsRange
    const max = profile.cents + profile.centsRange
    let cents = between(min, max)

    if (previous && Math.abs(cents - previous.cents) < profile.minCentsChange) {
      const canGoLower = previous.cents - profile.minCentsChange >= min
      const canGoHigher = previous.cents + profile.minCentsChange <= max
      const goHigher = canGoHigher && (!canGoLower || Math.random() >= 0.5)
      cents = goHigher
        ? between(previous.cents + profile.minCentsChange, max)
        : between(min, previous.cents - profile.minCentsChange)
    }
    return cents
  }

  function nextVariation(control: ControlId): Variation {
    const profile = CONTROL_PROFILES[control]
    const variation = {
      cents: nextCents(profile, variations[control]),
      gain: between(...profile.gain),
      cutoff: between(...profile.cutoff),
      pan: profile.pan,
    }
    variations[control] = variation
    return variation
  }

  function playVariedSfx(src: AudioBufferSourceNode, key: SfxKey, control: ControlId) {
    if (!actx) return
    const isRelease = key === 'mainRelease' || key === 'actionRelease' || key === 'pillRelease'
    const variation =
      isRelease
        ? (variations[control] ?? nextVariation(control))
        : nextVariation(control)
    const profile = CONTROL_PROFILES[control]
    const filter = actx.createBiquadFilter()
    const gain = actx.createGain()
    const pan = actx.createStereoPanner()

    src.playbackRate.value = 2 ** (variation.cents / 1200)
    filter.type = 'lowpass'
    filter.frequency.value = variation.cutoff
    filter.Q.value = profile.filterQ
    gain.gain.value = variation.gain
    pan.pan.value = variation.pan
    src.connect(filter).connect(gain).connect(pan).connect(master ?? actx.destination)
  }

  function playSfx(key: SfxKey, control: ControlId) {
    if (!actx || !sfx[key]) return
    const src = actx.createBufferSource()
    src.buffer = sfx[key]
    playVariedSfx(src, key, control)
    src.start()
  }

  function resumeAudio() {
    // Backgrounding a standalone PWA can drain the context to 'closed' under memory pressure;
    // a stale closed context would sit here forever producing silent no-ops.
    if (actx && actx.state === 'closed') {
      actx = null
      master = null
    }
    if (!actx) {
      actx = new AudioContext()
      master = actx.createGain()
      master.gain.value = SFX_LEVEL
      master.connect(actx.destination)
      loadSfx()
    }
    // iOS Safari has a non-standard 'interrupted' state on backgrounding that the spec's
    // 'suspended'/'running'/'closed' enum doesn't cover; only checking 'suspended' left it
    // silently stuck interrupted until the app was force-quit and reopened.
    if (actx.state !== 'running') actx.resume().catch(() => {})
  }

  function tone(freq: number, vol: number, type: OscillatorType = 'square') {
    if (!actx) return
    const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime
    o.type = type
    o.frequency.value = freq
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(vol, t + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07)
    o.connect(g).connect(master ?? actx.destination)
    o.start(t)
    o.stop(t + 0.09)
  }

  function chord(freqs: Array<number>, vol: number) {
    freqs.forEach((f, i) => setTimeout(() => tone(f, vol, 'triangle'), i * 55))
  }

  return {
    playSfx,
    resumeAudio,
    tone,
    chord,
    dispose() { actx?.close() },
  }
}

export type ConsoleAudio = ReturnType<typeof createAudio>
