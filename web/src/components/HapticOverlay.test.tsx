// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { HapticOverlay } from './HapticOverlay'

// The scroll-tap guard: a genuine tap fires onTap, a scroll/drag past slop is swallowed. The native
// iOS switch-toggle can't be reproduced off-Safari, so we drive the pointer/touch/change path directly.
afterEach(cleanup)

function setup() {
  const onTap = vi.fn()
  const { container } = render(<HapticOverlay onTap={onTap} silent />)
  const input = container.querySelector('input') as HTMLInputElement
  return { onTap, input }
}

describe('HapticOverlay scroll guard', () => {
  it('fires onTap for a stationary tap', () => {
    const { onTap, input } = setup()
    fireEvent.pointerDown(input, { clientX: 10, clientY: 10 })
    fireEvent.click(input) // toggles the checkbox -> onChange
    expect(onTap).toHaveBeenCalledTimes(1)
  })

  it('still taps when the finger barely moves (under slop)', () => {
    const { onTap, input } = setup()
    fireEvent.pointerDown(input, { clientX: 10, clientY: 10 })
    fireEvent.pointerMove(input, { clientX: 13, clientY: 15 })
    fireEvent.click(input)
    expect(onTap).toHaveBeenCalledTimes(1)
  })

  it('swallows the tap when the finger scrolls past slop (pointer)', () => {
    const { onTap, input } = setup()
    fireEvent.pointerDown(input, { clientX: 10, clientY: 10 })
    fireEvent.pointerMove(input, { clientX: 10, clientY: 44 }) // 34px of vertical scroll
    fireEvent.click(input)
    expect(onTap).not.toHaveBeenCalled()
  })

  it('swallows the tap on a touch scroll past slop', () => {
    const { onTap, input } = setup()
    fireEvent.touchStart(input, { touches: [{ clientX: 10, clientY: 10 }] })
    fireEvent.touchMove(input, { touches: [{ clientX: 10, clientY: 44 }] })
    fireEvent.click(input)
    expect(onTap).not.toHaveBeenCalled()
  })

  it('recovers on the next genuine tap after a swallowed scroll', () => {
    const { onTap, input } = setup()
    fireEvent.pointerDown(input, { clientX: 10, clientY: 10 })
    fireEvent.pointerMove(input, { clientX: 10, clientY: 60 })
    fireEvent.click(input)
    expect(onTap).not.toHaveBeenCalled()

    fireEvent.pointerDown(input, { clientX: 10, clientY: 10 }) // resets the guard
    fireEvent.click(input)
    expect(onTap).toHaveBeenCalledTimes(1)
  })
})
