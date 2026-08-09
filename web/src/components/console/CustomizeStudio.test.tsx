// @vitest-environment jsdom
//
// The preset rail no longer runs its own drag-tick machinery (RailTickSwitch is gone, see HAPTICS.md B5's
// superseded note): each ThemeCard is now a plain visual button with a HapticOverlay on top, silent (the
// card's own onSelect fires the Android haptic, see CustomizeStudio.tsx), so these tests cover the same
// tap-vs-scroll GATE that HapticOverlay.test.tsx tests in isolation, exercised here through the real
// rendered rail: whether a gesture qualifies as a tap (touchend fires the select), whether a drag past
// slop (the July regression: a scroll that ends over a card must not select it) disqualifies it, and the
// once-per-gesture latch that keeps WebKit's synthesized click from double-selecting.
// `navigator.vibrate` is undefined in jsdom, same as real iOS, so the `switch`-arming branch runs for real.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ThemeRail } from './CustomizeStudio'

// jsdom has no layout engine and no scroll behavior: the rail's own auto-center effect calls scrollTo on
// mount (before a test gets a handle on the element), and jsdom doesn't implement it at all.
Element.prototype.scrollTo = vi.fn()

afterEach(cleanup)

function touch(x: number, y: number): Partial<Touch> {
  return { clientX: x, clientY: y, identifier: 0 } as Partial<Touch>
}

function setup() {
  const onSelect = vi.fn()
  const { container } = render(<ThemeRail selectedId="classic" onSelect={onSelect} />)
  // One HapticOverlay checkbox per card; the first one is enough to exercise the shared gate.
  const input = container.querySelector('input[type="checkbox"]') as HTMLInputElement
  return { onSelect, input }
}

describe('ThemeRail card selection (HapticOverlay)', () => {
  it('is an inert checkbox with no switch attribute at rest', () => {
    const { input } = setup()
    expect(input.type).toBe('checkbox')
    expect(input.hasAttribute('switch')).toBe(false)
  })

  it('selects on a qualifying tap (touchstart, no movement, touchend, then click)', () => {
    const { onSelect, input } = setup()
    fireEvent.touchStart(input, { touches: [touch(10, 10)] })
    fireEvent.touchEnd(input, { touches: [] })
    fireEvent.click(input)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('arms the switch attribute on a qualifying tap, the iOS tick', () => {
    const { input } = setup()
    fireEvent.touchStart(input, { touches: [touch(10, 10)] })
    fireEvent.touchEnd(input, { touches: [] })
    expect(input.hasAttribute('switch')).toBe(true)
  })

  it('never arms the switch when the touch moves past the tap slop (a drag/scroll, the July regression)', () => {
    // A real browser never dispatches `click` at the end of a scroll gesture, so `onTap` is inherently
    // safe (see the module header in HapticOverlay.tsx); what this component controls is the iOS tick,
    // which must not fire either.
    const { input } = setup()
    fireEvent.touchStart(input, { touches: [touch(10, 10)] })
    fireEvent.touchMove(input, { touches: [touch(10, 40)] }) // 30px > TAP_SLOP_PX
    fireEvent.touchEnd(input, { touches: [] })
    expect(input.hasAttribute('switch')).toBe(false)
  })

  it('never arms the switch after a touchcancel', () => {
    const { input } = setup()
    fireEvent.touchStart(input, { touches: [touch(10, 10)] })
    fireEvent.touchCancel(input, { touches: [] })
    fireEvent.touchEnd(input, { touches: [] }) // a stray late touchend for the same gesture
    expect(input.hasAttribute('switch')).toBe(false)
  })

  it('fires the select once even if WebKit synthesizes more than one click for the gesture', () => {
    const { onSelect, input } = setup()
    fireEvent.touchStart(input, { touches: [touch(10, 10)] })
    fireEvent.touchEnd(input, { touches: [] })
    fireEvent.click(input) // WebKit's own dispatchSimulatedClick, always fires on touchend/touchcancel
    fireEvent.click(input) // a possible second, from the platform's own tap recognizer (unverified either way)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('selects on a plain mouse click (no touch at all)', () => {
    const { onSelect, input } = setup()
    fireEvent.click(input)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('resets the latch on the next press, so a second unrelated tap still selects', () => {
    const { onSelect, input } = setup()
    fireEvent.pointerDown(input)
    fireEvent.click(input)
    fireEvent.pointerDown(input)
    fireEvent.click(input)
    expect(onSelect).toHaveBeenCalledTimes(2)
  })
})
