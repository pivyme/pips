// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { HapticOverlay } from './HapticOverlay'

// The overlay fires on a real click. Scroll-safety is inherent: browsers never dispatch a click at the
// end of a scroll gesture, so there is no scroll case left to guard in JS (that was the whole point of
// dropping the native-switch overlay). These lock the click -> onTap contract and the disabled guard.
afterEach(cleanup)

function setup(props?: { disabled?: boolean }) {
  const onTap = vi.fn()
  const { container } = render(<HapticOverlay onTap={onTap} silent {...props} />)
  const button = container.querySelector('button') as HTMLButtonElement
  return { onTap, button }
}

describe('HapticOverlay', () => {
  it('fires onTap on click', () => {
    const { onTap, button } = setup()
    fireEvent.click(button)
    expect(onTap).toHaveBeenCalledTimes(1)
  })

  it('does nothing when disabled', () => {
    const { onTap, button } = setup({ disabled: true })
    fireEvent.click(button)
    expect(onTap).not.toHaveBeenCalled()
  })
})
