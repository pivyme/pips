// @vitest-environment jsdom
// The four things that are silent when they break: the no-repeat pick, the onset trim that keeps a
// click instant despite codec priming, the anti-flam gap, and the mute. A fake AudioContext stands in
// for WebAudio, so what these assert is what actually reaches the graph.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Started {
  src: string
  offset: number
  rate: number
}

const started: Array<Started> = []
// The bytes fetched for a src are tagged by length, which is how a decoded buffer is traced back to it.
const srcByLength = new Map<number, string>()
// Leading silence to bake into a src's decoded buffer, in samples.
const lead = new Map<string, number>()
let busGain = -1

class FakeGain {
  gain = { value: 1 }
  connect(target: unknown) {
    // The one gain wired straight to the output is the bus; the rest are per-play trims.
    if ((target as { id?: string })?.id === 'dest') busGain = this.gain.value
    return target
  }
}

class FakeSource {
  buffer: { src: string } | null = null
  playbackRate = { value: 1 }
  connect(target: unknown) {
    return target
  }
  start(_when: number, offset: number) {
    started.push({ src: this.buffer?.src ?? '?', offset, rate: this.playbackRate.value })
  }
}

class FakeContext {
  state = 'running'
  destination = { id: 'dest' }
  resume() {
    return Promise.resolve()
  }
  createGain() {
    return new FakeGain()
  }
  createBufferSource() {
    return new FakeSource()
  }
  decodeAudioData(bytes: ArrayBuffer) {
    const src = srcByLength.get(bytes.byteLength) ?? '?'
    const silent = lead.get(src) ?? 0
    const data = new Float32Array(silent + 64)
    for (let i = silent; i < data.length; i++) data[i] = 0.5
    return Promise.resolve({ src, sampleRate: 44100, getChannelData: () => data })
  }
}

let nextLength = 1000

async function load() {
  vi.resetModules()
  started.length = 0
  srcByLength.clear()
  busGain = -1
  ;(globalThis as { AudioContext?: unknown }).AudioContext = FakeContext
  vi.stubGlobal('fetch', (url: string) =>
    Promise.resolve({
      ok: true,
      arrayBuffer: () => {
        const len = nextLength++
        srcByLength.set(len, url)
        return Promise.resolve(new ArrayBuffer(len))
      },
    }),
  )
  return import('./uiSfx')
}

// Every play after the first for a sample is synchronous, but the first has to fetch + decode. Let the
// microtasks drain so the assertions see the finished graph either way.
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  lead.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('uiSfx', () => {
  it('never plays the same sample twice in a row', async () => {
    const { uiSfx } = await load()
    for (let i = 0; i < 40; i++) {
      uiSfx('tap')
      await settle()
      vi.setSystemTime(Date.now() + 100) // clear the anti-flam window between presses
    }
    expect(started.length).toBe(40)
    const repeats = started.filter((s, i) => i > 0 && s.src === started[i - 1].src)
    expect(repeats).toEqual([])
    // and it does reach the whole set, rather than ping-ponging between two files
    expect(new Set(started.map((s) => s.src)).size).toBe(5)
    vi.useRealTimers()
  })

  it('starts past codec priming silence', async () => {
    const { uiSfx } = await load()
    lead.set('/sounds/ui-sfx/disabled.mp3', 1105) // a typical mp3 encoder delay
    uiSfx('disabled')
    await settle()
    expect(started).toHaveLength(1)
    // (1105 - 8 samples of headroom) / 44100
    expect(started[0].offset).toBeCloseTo(1097 / 44100, 6)
  })

  it('starts at zero when the sample has no leading silence', async () => {
    const { uiSfx } = await load()
    uiSfx('toggleOn')
    await settle()
    expect(started[0].offset).toBe(0)
  })

  it('drops a repeat fired inside the anti-flam window, and allows it after', async () => {
    const { uiSfx } = await load()
    uiSfx('swipe')
    await settle()
    uiSfx('swipe')
    await settle()
    expect(started).toHaveLength(1)
    vi.setSystemTime(Date.now() + 100)
    uiSfx('swipe')
    await settle()
    expect(started).toHaveLength(2)
    vi.useRealTimers()
  })

  it('detunes the varied families and leaves the signals dead-on', async () => {
    const { uiSfx } = await load()
    uiSfx('tap')
    await settle()
    uiSfx('toggleOff')
    await settle()
    expect(started[0].rate).not.toBe(1)
    expect(started[1].rate).toBe(1)
  })

  it('goes silent when sound is switched off, and comes back', async () => {
    const { uiSfx, setUiSfxEnabled } = await load()
    setUiSfxEnabled(false)
    uiSfx('tap')
    await settle()
    expect(started).toHaveLength(0)
    setUiSfxEnabled(true)
    uiSfx('tap')
    await settle()
    expect(started).toHaveLength(1)
  })

  it('scales the bus by the SFX fader', async () => {
    const { uiSfx, setUiSfxVolume } = await load()
    setUiSfxVolume(0.5)
    uiSfx('tap')
    await settle()
    expect(busGain).toBeCloseTo(0.2 * 0.5, 6) // UI_LEVEL * fader
  })

  it('stays silent rather than throwing when a sample 404s', async () => {
    const mod = await load()
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, arrayBuffer: () => Promise.reject(new Error('no')) }))
    expect(() => mod.uiSfx('tap')).not.toThrow()
    await settle()
    expect(started).toHaveLength(0)
  })
})
