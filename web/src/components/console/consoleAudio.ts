export function createAudio() {
  let actx: AudioContext | null = null
  const sfx: Record<string, AudioBuffer> = {}

  async function loadSfx() {
    if (!actx) return
    const load = async (path: string) => {
      const ab = await fetch(path).then(r => r.arrayBuffer())
      return actx!.decodeAudioData(ab)
    }
    const [mp, mr, ap, ar, pp, pr, kn] = await Promise.all([
      load('/sounds/MAIN_PRESS.MP3'),
      load('/sounds/MAIN_RELEASE.MP3'),
      load('/sounds/ACTION_PRESS.MP3'),
      load('/sounds/ACTION_RELEASE.MP3'),
      load('/sounds/PILL_PRESS.MP3'),
      load('/sounds/PILL_RELEASE.MP3'),
      load('/sounds/KNOB_RUBBER.MP3'),
    ])
    sfx.mainPress = mp; sfx.mainRelease = mr
    sfx.actionPress = ap; sfx.actionRelease = ar
    sfx.pillPress = pp; sfx.pillRelease = pr
    sfx.knob = kn
  }

  function playSfx(key: string) {
    if (!actx || !sfx[key]) return
    const src = actx.createBufferSource()
    src.buffer = sfx[key]
    if (key === 'knob') {
      const lp = actx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 1200
      lp.Q.value = 0.8
      src.connect(lp).connect(actx.destination)
    } else {
      src.connect(actx.destination)
    }
    src.start()
  }

  function resumeAudio() {
    if (!actx) { actx = new AudioContext(); loadSfx() }
    if (actx.state === 'suspended') actx.resume()
  }

  function tone(freq: number, vol: number, type: OscillatorType = 'square') {
    if (!actx) return
    const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime
    o.type = type
    o.frequency.value = freq
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(vol, t + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07)
    o.connect(g).connect(actx.destination)
    o.start(t)
    o.stop(t + 0.09)
  }

  function chord(freqs: number[], vol: number) {
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
