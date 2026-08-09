// @vitest-environment jsdom
// The detent scheduler is the riskiest part of this file: a naive per-move `vibrate()` call aborts
// itself down to one pulse (the bug this scheduler exists to fix), and a naive priority model swallows
// button presses behind a burst or an outcome pattern. These tests exercise the scheduler's clock
// directly against a stubbed navigator.vibrate, mirroring uiSfx.test.ts's reset-modules + dynamic-import
// shape, since `WebHaptics.isSupported` is a static field resolved at import time, not at call time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Loads a fresh module graph (including 'web-haptics', so its static isSupported field is recomputed)
// with navigator.vibrate either present (supported) or absent (unsupported, the iOS/desktop shape).
async function load(supported = true) {
  vi.resetModules()
  const vibrateMock = vi.fn()
  if (supported) {
    Object.defineProperty(navigator, 'vibrate', { value: vibrateMock, configurable: true, writable: true })
  } else {
    Object.defineProperty(navigator, 'vibrate', { value: undefined, configurable: true, writable: true })
  }
  const mod = await import('./haptics')
  return { ...mod, vibrateMock }
}

// vibrate() patterns alternate on/off starting on, so every even index (0, 2, 4...) is a pulse.
function onCount(pattern: number[]): number {
  return Math.ceil(pattern.length / 2)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  // A test that queues a second outcome pattern (or otherwise leaves the actuator "busy") can end
  // without ever advancing past its own scheduled clockTimer. Clear it before switching timer
  // implementations, or the leftover fake timer's eventual callback reads whatever navigator.vibrate
  // mock the NEXT test's load() installed and contaminates its call count.
  vi.clearAllTimers()
  vi.useRealTimers()
  Object.defineProperty(navigator, 'vibrate', { value: undefined, configurable: true, writable: true })
})

describe('hapticDetent', () => {
  it('coalesces 3 detents crossed in one move into a single vibrate call', async () => {
    const { hapticDetent, vibrateMock } = await load()
    hapticDetent(3)
    expect(vibrateMock).toHaveBeenCalledTimes(1)
    expect(vibrateMock).toHaveBeenCalledWith([10, 25, 10, 25, 10])
  })

  it('does not interrupt a playing outcome pattern', async () => {
    const { hapticPattern, hapticDetent, vibrateMock } = await load()
    hapticPattern('win')
    expect(vibrateMock).toHaveBeenCalledTimes(1)

    hapticDetent(1)
    expect(vibrateMock).toHaveBeenCalledTimes(1) // banked, not fired

    vi.advanceTimersByTime(220) // win's total duration (20+50+30+50+70)
    expect(vibrateMock).toHaveBeenCalledTimes(2)
    expect(vibrateMock).toHaveBeenLastCalledWith([10])
  })

  it('flushes the first detent of an idle actuator synchronously', async () => {
    const { hapticDetent, vibrateMock } = await load()
    hapticDetent(1)
    expect(vibrateMock).toHaveBeenCalledTimes(1) // zero timer advancement
    expect(vibrateMock).toHaveBeenCalledWith([10])
  })

  it('caps a burst at MAX_BURST and drops the rest', async () => {
    const { hapticDetent, vibrateMock } = await load()
    hapticDetent(50)
    expect(vibrateMock).toHaveBeenCalledTimes(1)
    expect(onCount(vibrateMock.mock.calls[0][0] as number[])).toBe(3)

    vi.advanceTimersByTime(1000)
    expect(vibrateMock).toHaveBeenCalledTimes(1) // nothing further, ever
  })

  it('does not accumulate lag under a sustained high-rate drag', async () => {
    const { hapticDetent, vibrateMock } = await load()
    const start = Date.now()
    while (Date.now() - start < 350) {
      hapticDetent(1)
      vi.advanceTimersByTime(5) // ~200 detents/sec
    }

    const totalPulses = vibrateMock.mock.calls.reduce((sum: number, call: unknown[]) => sum + onCount(call[0] as number[]), 0)
    expect(totalPulses).toBeGreaterThanOrEqual(6)
    expect(totalPulses).toBeLessThanOrEqual(14) // ~10 pulses over 350ms, not 70 (one per call)
  })

  it('every emitted pattern is odd-length, within the W3C budget, and alternates the right values', async () => {
    const { hapticDetent, vibrateMock, DETENT_MS, DETENT_SMALL_MS, DETENT_GAP_MS } = await load()
    for (const ms of [DETENT_MS, DETENT_SMALL_MS]) {
      for (const n of [1, 2, 3, 5]) {
        vibrateMock.mockClear()
        hapticDetent(n, ms)
        const pattern = vibrateMock.mock.calls[0][0] as number[]
        expect(pattern.length).toBeLessThanOrEqual(9)
        expect(pattern.length % 2).toBe(1)
        pattern.forEach((v, i) => {
          if (i % 2 === 0) expect(v).toBe(ms)
          else expect(v).toBe(DETENT_GAP_MS)
        })
        vi.advanceTimersByTime(500) // drain back to idle before the next case
      }
    }
  })
})

describe('haptic (press) priority', () => {
  it('preempts a detent burst and still fires', async () => {
    const { hapticDetent, haptic, vibrateMock } = await load()
    hapticDetent(3) // starts a ~105ms detent burst
    expect(vibrateMock).toHaveBeenCalledTimes(1)

    haptic('mid')
    expect(vibrateMock).toHaveBeenCalledTimes(2)
    expect(vibrateMock).toHaveBeenLastCalledWith([15])
  })

  it('defers one slot behind a playing outcome pattern rather than interrupting it', async () => {
    const { hapticPattern, haptic, vibrateMock } = await load()
    hapticPattern('lose')
    expect(vibrateMock).toHaveBeenCalledTimes(1)

    haptic('high')
    expect(vibrateMock).toHaveBeenCalledTimes(1) // deferred, not fired, not dropped

    vi.advanceTimersByTime(135) // lose's total duration (70+40+25)
    expect(vibrateMock).toHaveBeenCalledTimes(2)
    expect(vibrateMock).toHaveBeenLastCalledWith([20])
  })
})

describe('hapticPattern (outcome)', () => {
  it('collapses an identical pattern replayed within ~1s into a single buzz', async () => {
    const { hapticPattern, vibrateMock } = await load()
    hapticPattern('achievement')
    hapticPattern('achievement')
    hapticPattern('achievement')
    expect(vibrateMock).toHaveBeenCalledTimes(1)
  })

  it('queues a second distinct pattern one deep and plays it after the first finishes', async () => {
    const { hapticPattern, vibrateMock } = await load()
    hapticPattern('win')
    hapticPattern('achievement')
    expect(vibrateMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(220) // win's total duration
    expect(vibrateMock).toHaveBeenCalledTimes(2)
    expect(vibrateMock).toHaveBeenLastCalledWith([20, 40, 20, 40, 20, 60, 90])
  })
})

describe('module-level state', () => {
  it('ends a mid-burst toggle-off with vibrate(0) and nothing after', async () => {
    const { hapticDetent, setHapticsEnabled, vibrateMock } = await load()
    hapticDetent(3)
    setHapticsEnabled(false)
    expect(vibrateMock).toHaveBeenLastCalledWith(0)

    vi.advanceTimersByTime(1000)
    expect(vibrateMock).toHaveBeenCalledTimes(2) // the burst, then the stop, nothing else
  })

  it('is inert while disabled', async () => {
    const { haptic, hapticDetent, hapticPattern, setHapticsEnabled, vibrateMock } = await load()
    setHapticsEnabled(false) // fires its own vibrate(0) stop, asserted separately above
    vibrateMock.mockClear()
    haptic('high')
    hapticDetent(3)
    hapticPattern('win')
    expect(vibrateMock).not.toHaveBeenCalled()
  })

  it('never throws when navigator.vibrate is unsupported', async () => {
    const { haptic, hapticDetent, hapticPattern, cancelHaptics } = await load(false)
    expect(() => {
      haptic('high')
      hapticDetent(3)
      hapticPattern('win')
      cancelHaptics()
    }).not.toThrow()
  })

  it('never injects web-haptics DOM into jsdom across 40 calls', async () => {
    const { haptic } = await load()
    for (let i = 0; i < 40; i++) haptic('mid')
    expect(document.body.querySelector('label')).toBeNull()
  })

  // B14: ConsoleCanvas reads isHapticsEnabled/subscribeHapticsEnabled (not useAuth) so the switch
  // overlay's `switch` attribute, and therefore iOS's native Taptic tick, can be suppressed live while
  // the console stays mounted under the Settings drawer, and so it works with no AuthProvider at all
  // (the offscreen PnL-card shot mounts ConsoleCanvas off-tree).
  it('isHapticsEnabled reflects the current value and notifies subscribers on change', async () => {
    const { setHapticsEnabled, isHapticsEnabled, subscribeHapticsEnabled } = await load()
    expect(isHapticsEnabled()).toBe(true)

    const cb = vi.fn()
    const unsubscribe = subscribeHapticsEnabled(cb)

    setHapticsEnabled(false)
    expect(isHapticsEnabled()).toBe(false)
    expect(cb).toHaveBeenCalledTimes(1)

    setHapticsEnabled(true)
    expect(isHapticsEnabled()).toBe(true)
    expect(cb).toHaveBeenCalledTimes(2)

    unsubscribe()
    setHapticsEnabled(false)
    expect(cb).toHaveBeenCalledTimes(2) // no further calls after unsubscribing
  })
})

describe('preset patterns', () => {
  it('emits the exact array for every level and legacy alias', async () => {
    const { haptic, vibrateMock } = await load()
    const expected: Record<string, number[]> = {
      tick: [10],
      tickSmall: [7],
      low: [10],
      mid: [15],
      high: [20],
      selection: [10],
      medium: [15],
      rigid: [20],
      heavy: [20],
      success: [30, 60, 40],
      warning: [40, 100, 40],
      error: [40, 40, 40, 40, 40],
    }
    for (const [preset, pattern] of Object.entries(expected)) {
      vibrateMock.mockClear()
      haptic(preset as Parameters<typeof haptic>[0])
      expect(vibrateMock).toHaveBeenCalledWith(pattern)
      vi.advanceTimersByTime(200) // clear back to idle before the next preset
    }
  })

  it('emits the exact array for every outcome pattern', async () => {
    const { hapticPattern, vibrateMock } = await load()
    const expected: Record<string, number[]> = {
      win: [20, 50, 30, 50, 70],
      lose: [70, 40, 25],
      cashOut: [25, 45, 25],
      achievement: [20, 40, 20, 40, 20, 60, 90],
    }
    for (const [name, pattern] of Object.entries(expected)) {
      vibrateMock.mockClear()
      hapticPattern(name as Parameters<typeof hapticPattern>[0])
      expect(vibrateMock).toHaveBeenCalledWith(pattern)
      vi.advanceTimersByTime(400) // clear back to idle, and past the ~1s dedupe would be excessive; just drain the mode
    }
  })
})
