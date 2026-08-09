// @vitest-environment jsdom
//
// jsdom cannot reproduce WebKit's native Taptic tick (it has no touch-input-driven rendering pipeline and
// no Vibration/switch engine), so these tests cover the GATE around it: whether a gesture qualifies as a
// tap (and therefore whether the `switch` attribute gets armed), never the tick itself. `navigator.vibrate`
// is undefined in jsdom, same as real iOS, so the arming branch runs for real in every test below without
// any mocking. The tap/scroll thresholds live in `lib/tapGesture.ts`, shared with the Customize preset
// rail's RailTickSwitch (see `console/CustomizeStudio.test.tsx`), so a change to the rule here and there
// can never quietly drift apart.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { HapticOverlay } from './HapticOverlay'

afterEach(cleanup)

function setup(props?: { disabled?: boolean }) {
  const onTap = vi.fn()
  const { container } = render(<HapticOverlay onTap={onTap} silent {...props} />)
  const input = container.querySelector('input') as HTMLInputElement
  return { onTap, input }
}

function touch(x: number, y: number): Partial<Touch> {
  return { clientX: x, clientY: y, identifier: 0 } as Partial<Touch>
}

describe('HapticOverlay', () => {
  it('is an inert checkbox with no switch attribute at rest', () => {
    const { input } = setup()
    expect(input.type).toBe('checkbox')
    expect(input.hasAttribute('switch')).toBe(false)
  })

  it('fires onTap once on a plain click', () => {
    const { onTap, input } = setup()
    fireEvent.click(input)
    expect(onTap).toHaveBeenCalledTimes(1)
  })

  it('does nothing when disabled', () => {
    const { onTap, input } = setup({ disabled: true })
    fireEvent.click(input)
    expect(onTap).not.toHaveBeenCalled()
  })

  it('arms the switch attribute on a qualifying tap (touchstart, no movement, touchend)', () => {
    const { input } = setup()
    fireEvent.touchStart(input, { touches: [touch(10, 10)] })
    fireEvent.touchEnd(input, { touches: [] })
    expect(input.hasAttribute('switch')).toBe(true)
  })

  it('never arms the switch when the touch moves past the tap slop (a scroll)', () => {
    const { input } = setup()
    fireEvent.touchStart(input, { touches: [touch(10, 10)] })
    fireEvent.touchMove(input, { touches: [touch(10, 40)] }) // 30px > TAP_SLOP_PX
    fireEvent.touchEnd(input, { touches: [] })
    expect(input.hasAttribute('switch')).toBe(false)
  })

  it('never arms the switch after a touchcancel', () => {
    const { input } = setup()
    fireEvent.touchStart(input, { touches: [touch(10, 10)] })
    fireEvent.touchCancel(input)
    fireEvent.touchEnd(input, { touches: [] }) // a stray late touchend for the same gesture
    expect(input.hasAttribute('switch')).toBe(false)
  })

  it('disqualifies a gesture when its scroll container scrolls', () => {
    const onTap = vi.fn()
    const { container } = render(
      <div data-testid="scroller" style={{ overflowY: 'auto' }}>
        <HapticOverlay onTap={onTap} silent />
      </div>,
    )
    const input = container.querySelector('input') as HTMLInputElement
    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLDivElement

    fireEvent.touchStart(input, { touches: [touch(10, 10)] })
    Object.defineProperty(scroller, 'scrollTop', { value: 40, configurable: true })
    fireEvent.scroll(scroller)
    fireEvent.touchEnd(input, { touches: [] })

    expect(input.hasAttribute('switch')).toBe(false)
  })

  it('latches so a second click in the same press does not fire onTap twice', () => {
    const { onTap, input } = setup()
    fireEvent.touchStart(input, { touches: [touch(10, 10)] })
    fireEvent.touchEnd(input, { touches: [] })
    fireEvent.click(input)
    fireEvent.click(input) // WebKit's synthesized click alongside a possible tap-recognizer click
    expect(onTap).toHaveBeenCalledTimes(1)
  })

  it('resets the latch on the next press, so a second unrelated tap still fires', () => {
    const { onTap, input } = setup()
    fireEvent.pointerDown(input)
    fireEvent.click(input)
    fireEvent.pointerDown(input)
    fireEvent.click(input)
    expect(onTap).toHaveBeenCalledTimes(2)
  })
})
