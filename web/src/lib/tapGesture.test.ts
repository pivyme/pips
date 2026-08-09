// @vitest-environment jsdom
// Pure helpers only: the shared thresholds/comparisons behind both HapticOverlay (menu rows) and
// RailTickSwitch (the Customize preset rail). See HapticOverlay.test.tsx and CustomizeStudio.test.tsx for
// the end-to-end gate each of those builds on top of these.
import { describe, expect, it } from 'vitest'
import { TAP_MAX_MS, TAP_SLOP_PX, exceedsSlop, iosNoVibrate, withinTapWindow } from './tapGesture'

describe('tapGesture', () => {
  it('iosNoVibrate is true in jsdom, same as real iOS (no navigator.vibrate)', () => {
    expect(iosNoVibrate()).toBe(true)
  })

  it('exceedsSlop is false within TAP_SLOP_PX on both axes', () => {
    expect(exceedsSlop(TAP_SLOP_PX, TAP_SLOP_PX)).toBe(false)
    expect(exceedsSlop(-TAP_SLOP_PX, 0)).toBe(false)
  })

  it('exceedsSlop is true past TAP_SLOP_PX on either axis', () => {
    expect(exceedsSlop(TAP_SLOP_PX + 1, 0)).toBe(true)
    expect(exceedsSlop(0, -(TAP_SLOP_PX + 1))).toBe(true)
  })

  it('withinTapWindow is true immediately and false once TAP_MAX_MS has elapsed', () => {
    expect(withinTapWindow(performance.now())).toBe(true)
    expect(withinTapWindow(performance.now() - TAP_MAX_MS - 1)).toBe(false)
  })
})
