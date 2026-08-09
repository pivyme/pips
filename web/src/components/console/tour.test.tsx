// @vitest-environment jsdom
//
// The tour's three tap targets, and specifically the one thing that made "tap anywhere" feel dead on
// iPhone: the action rides a `click` while the Taptic tick rides HapticOverlay's own tap gate, so on the
// full-screen backdrop the two could disagree and the tour advanced in silence. jsdom cannot reproduce
// the native tick (see HapticOverlay.test.tsx), so these assert the `switch` attribute, which is the one
// thing WebKit reads to decide whether to fire it. `useReducedMotion` is mocked because it reads the auth
// user and there is no AuthProvider here; nothing under test depends on its value.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'

vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => false }))

const { TourProvider, useTour } = await import('./tour')

afterEach(() => {
  cleanup()
  localStorage.clear()
})

function Starter() {
  const { start } = useTour()
  return (
    <button type="button" data-testid="go" onClick={() => start({ force: true })}>
      go
    </button>
  )
}

function touch(x: number, y: number) {
  return { clientX: x, clientY: y, identifier: 0 } as unknown as Touch
}

function openTour() {
  const view = render(
    <TourProvider>
      <Starter />
    </TourProvider>,
  )
  act(() => {
    fireEvent.click(view.getByTestId('go'))
  })
  // [backdrop, skip, next], in DOM order.
  const overlays = () => Array.from(view.container.querySelectorAll('input'))
  const step = () => view.container.textContent?.match(/(\d\d) \/ \d\d/)?.[1]
  return { ...view, overlays, step }
}

// One physical press: the arming touch sequence, then the click WebKit synthesizes from it.
function press(el: HTMLInputElement, path: Array<[number, number]>) {
  fireEvent.pointerDown(el)
  fireEvent.touchStart(el, { touches: [touch(...path[0]!)] })
  for (const p of path.slice(1)) fireEvent.touchMove(el, { touches: [touch(...p)] })
  fireEvent.touchEnd(el, { touches: [] })
  const armed = el.hasAttribute('switch')
  act(() => {
    fireEvent.click(el)
  })
  return armed
}

describe('console tour', () => {
  it('arms the switch and advances one step on a clean backdrop tap', () => {
    const { overlays, step } = openTour()
    expect(step()).toBe('01')
    expect(press(overlays()[0]!, [[100, 400]])).toBe(true)
    expect(step()).toBe('02')
  })

  it('still arms on a loose backdrop tap, because that tap advances the tour anyway', () => {
    // The whole point of `scrim`. iOS's tap recognizer fires the click for a gesture that drifts or
    // dwells, so the strict gate would advance the tour with no tick. Both must agree here.
    const { overlays, step } = openTour()
    expect(
      press(overlays()[0]!, [
        [100, 400],
        [108, 424],
        [112, 430],
      ]),
    ).toBe(true)
    expect(step()).toBe('02')
  })

  it('advances exactly one step per backdrop tap, never two', () => {
    const { overlays, step } = openTour()
    press(overlays()[0]!, [[100, 400]])
    press(overlays()[0]!, [[100, 400]])
    expect(step()).toBe('03')
  })

  it('arms and advances exactly one step from Next', () => {
    const { overlays, step } = openTour()
    expect(press(overlays()[2]!, [[300, 700]])).toBe(true)
    expect(step()).toBe('02')
  })

  it('keeps Next on the strict gate, so a drag off it neither arms nor advances', () => {
    const { overlays, step } = openTour()
    expect(
      press(overlays()[2]!, [
        [300, 700],
        [300, 760],
      ]),
    ).toBe(false)
    expect(step()).toBe('02') // the click still lands in jsdom; on iOS the drag produces none
  })

  it('arms on Skip and marks the tour seen', () => {
    const { overlays } = openTour()
    expect(press(overlays()[1]!, [[60, 700]])).toBe(true)
    expect(localStorage.getItem('pips.tour.seen.v1')).toBe('1')
  })

  it('hides Skip on the finale so only the send-off can be tapped', () => {
    const { overlays, container, step } = openTour()
    for (let n = 0; n < 5; n++) press(overlays()[0]!, [[100, 400]])
    expect(step()).toBeUndefined() // the counter is hidden on the finale
    expect(container.querySelector('.invisible')?.contains(overlays()[1]!)).toBe(true)
  })

  it('advances on the keyboard and closes on Escape', () => {
    const { step } = openTour()
    act(() => {
      fireEvent.keyDown(window, { key: 'ArrowRight' })
    })
    expect(step()).toBe('02')
    act(() => {
      fireEvent.keyDown(window, { key: 'ArrowLeft' })
    })
    expect(step()).toBe('01')
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(localStorage.getItem('pips.tour.seen.v1')).toBe('1')
  })
})
