// @vitest-environment jsdom
// The music fader is silent when it breaks: the slider moves, the number in the UI changes, and the
// output does not. The fake <audio> here reproduces WebKit's iPhone behaviour verbatim (a `volume`
// write reads back correctly, then reverts on the next task and never reaches the player), which is
// what made the old read-back probe conclude the element was a working fader and skip the gain node.
// So what these assert is that the level reaching the graph tracks the fader on a phone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CEILING = 0.4 // MUSIC_CEILING in audio.ts

const ramps: Array<number> = []
let gainNode: FakeGain | null = null
let sourcedFrom: FakeAudio | null = null

class FakeGain {
  gain = {
    value: 1,
    setTargetAtTime(v: number) {
      ramps.push(v)
    },
  }
  connect(target: unknown) {
    return target
  }
}

class FakeContext {
  state = 'running'
  currentTime = 0
  destination = { id: 'dest' }
  resume() {
    return Promise.resolve()
  }
  addEventListener() {}
  createGain() {
    gainNode = new FakeGain()
    return gainNode
  }
  createMediaElementSource(el: FakeAudio) {
    sourcedFrom = el
    return { connect: (t: unknown) => t }
  }
}

// An iPhone's HTMLMediaElement: the setter stores the value so a synchronous read looks right, then
// reverts it a task later, and the player never hears any of it.
class FakeAudio {
  static locked = true
  preload = ''
  loop = false
  src = ''
  currentTime = 0
  readyState = 1
  paused = true
  private v = 1
  get volume() {
    return this.v
  }
  set volume(next: number) {
    this.v = next
    if (!FakeAudio.locked) return
    const before = 1
    setTimeout(() => {
      this.v = before
    }, 0)
  }
  load() {}
  play() {
    this.paused = false
    return Promise.resolve()
  }
  pause() {
    this.paused = true
  }
  addEventListener() {}
}

async function loadAudioModule() {
  vi.resetModules()
  ramps.length = 0
  gainNode = null
  sourcedFrom = null
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline'))) // the boot warm() is not under test
  vi.doMock('./sound', () => ({
    sharedAudioContext: () => new FakeContext(),
    setSynthSfxVolume: () => {},
  }))
  vi.doMock('./uiSfx', () => ({ setUiSfxVolume: () => {} }))
  return import('./audio')
}

describe('music fader', () => {
  beforeEach(() => {
    window.localStorage.clear()
    FakeAudio.locked = true
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./sound')
    vi.doUnmock('./uiSfx')
  })

  it('routes the element through a gain node even though a volume read-back looks like it worked', async () => {
    const audio = await loadAudioModule()
    audio.togglePlay()
    expect(sourcedFrom).not.toBeNull()
    expect(gainNode?.gain.value).toBeCloseTo(audio.RECOMMENDED.music * CEILING, 5)
  })

  it('moves the gain node when the fader moves, and survives the iPhone volume revert', async () => {
    const audio = await loadAudioModule()
    audio.togglePlay()
    audio.setMusicVolume(0.25)
    expect(ramps.at(-1)).toBeCloseTo(0.25 * CEILING, 5)

    // Let WebKit's revert task run. It takes the element back to full scale, which is exactly why the
    // element cannot be the fader, and the gain node has to still be holding the level.
    await new Promise((r) => setTimeout(r, 0))
    audio.setMusicVolume(0.6)
    expect(ramps.at(-1)).toBeCloseTo(0.6 * CEILING, 5)
    expect(audio.getMusicVolume()).toBe(0.6)
  })

  it('falls back to the element when there is no WebAudio at all', async () => {
    vi.resetModules()
    ramps.length = 0
    gainNode = null
    FakeAudio.locked = false // a browser without WebAudio is not an iPhone
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    vi.doMock('./sound', () => ({ sharedAudioContext: () => null, setSynthSfxVolume: () => {} }))
    vi.doMock('./uiSfx', () => ({ setUiSfxVolume: () => {} }))
    const audio = await import('./audio')
    audio.togglePlay()
    audio.setMusicVolume(0.5)
    expect(gainNode).toBeNull()
    expect(ramps).toHaveLength(0)
  })
})
