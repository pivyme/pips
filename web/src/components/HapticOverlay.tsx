// An invisible tap layer over a tap target. The visible button/link underneath is `pointer-events-none`
// and owns keyboard/screen-reader access; this sits on top as the pointer/touch target. The action fires
// on a real `click`, latched once per press so a possible double click (see below) can't double-navigate.
// Scroll-safety for the action is inherent: browsers never dispatch a click at the end of a scroll
// gesture, so a scrolling list can't mis-trigger it either way.
//
// Haptics: Android buzzes via navigator.vibrate in haptic(). iOS Safari has no web vibration API; its only
// tick comes from physically toggling a real <input type="checkbox" switch>, which is unconditionally
// drag-happy IF the attribute is present during a scroll (WebKit fires the same synthesized click from
// touchend AND touchcancel, CheckboxInputType.cpp:213-226). So the element renders as an INERT plain
// checkbox at rest, and the `switch` attribute is added imperatively at `touchend`, and only once the
// gesture already qualified as a tap (see qualifies() below). During any scroll the element is never a
// switch at all, so there is nothing for WebKit to tick and nothing to synthesize a click from. Full
// writeup: .claude/agent-memory/menu-haptics-ios-2026-08.md.
//
// `scrim` exists because the action and the tick are gated by two DIFFERENT rules: the action rides a
// `click`, the tick rides our own qualifies(). Over a scrolling list those rules agree, because a gesture
// we reject is a scroll and a scroll produces no click either. Over a full-surface overlay on something
// that cannot scroll they diverge: iOS's tap recognizer still delivers the click, so the surface acts and
// stays silent. On such a surface there is nothing a touch could mean except a tap, so `scrim` drops the
// scroll-derived disqualifiers and the two rules line up again.
import { useRef } from 'react'
import { cnm } from '@/utils/style'
import { haptic, isHapticsEnabled } from '@/lib/haptics'
import type { HapticPreset } from '@/lib/haptics'
import { exceedsSlop, iosNoVibrate, withinTapWindow } from '@/lib/tapGesture'
import { uiSfx } from '@/lib/uiSfx'
import type { UiSfxName } from '@/lib/uiSfx'

// --- The arming strategy: how the `switch` attribute gets onto the element, ONE place to change it. ---
// 'jit' (shipped default): inert checkbox at rest, attribute added only at touchend of an already-
//   qualified tap. Nothing to tick and nothing to synthesize a click from during any scroll.
// 'always-remove-on-pan': the documented fallback if on-device testing ever shows the touchend add does
//   not land in time for WebKit's own default handler on the same event. This variant keeps the attribute
//   present from touchstart and rips it off the instant the gesture disqualifies, so it is present only
//   during the arming window of a gesture that is still a tap-candidate. Bigger blast radius, still safe.
// Nothing else in this file needs to change to flip this.
const ARM_STRATEGY: 'jit' | 'always-remove-on-pan' = 'jit'

// One tap-qualification tracker for the WHOLE app, not per overlay instance: only one finger can be
// touching the screen at a time, so a single shared gesture is enough, and it means a second overlay
// touched mid-gesture (impossible in practice, but cheap to guard) can't confuse the first one's state.
type Gesture = {
  active: boolean
  ok: boolean
  el: HTMLInputElement | null
  x: number
  y: number
  t: number
  scrollParent: Element | Window | null
  scrollTopAtStart: number
  scrim: boolean
}

function freshGesture(): Gesture {
  return { active: false, ok: false, el: null, x: 0, y: 0, t: 0, scrollParent: null, scrollTopAtStart: 0, scrim: false }
}

let gesture: Gesture = freshGesture()
let scrollGuardTarget: Element | Window | null = null

function scrollTopOf(target: Element | Window): number {
  return target instanceof Window ? target.scrollY : target.scrollTop
}

// Walks up from the touched element to the nearest ancestor that can scroll (per computed overflow, not
// per current content height, so a short list still counts). Falls back to the window.
function nearestScrollParent(el: Element): Element | Window {
  let node = el.parentElement
  while (node && node !== document.body) {
    const cs = getComputedStyle(node)
    if (cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowX === 'auto' || cs.overflowX === 'scroll') {
      return node
    }
    node = node.parentElement
  }
  return window
}

function onScrollGuard() {
  if (!gesture.active) return
  gesture.ok = false
  if (gesture.el) disarmIfAlwaysOn(gesture.el)
}

function attachScrollGuard(target: Element | Window) {
  detachScrollGuard()
  scrollGuardTarget = target
  scrollGuardTarget.addEventListener('scroll', onScrollGuard, { passive: true })
}

function detachScrollGuard() {
  scrollGuardTarget?.removeEventListener('scroll', onScrollGuard)
  scrollGuardTarget = null
}

// The three strategy hooks (see ARM_STRATEGY above). `jit` only ever touches the attribute from
// commitTap, at a qualified touchend; the other two are no-ops for it.
function armAtGestureStart(input: HTMLInputElement) {
  if (ARM_STRATEGY === 'always-remove-on-pan') {
    if (iosNoVibrate() && isHapticsEnabled()) input.setAttribute('switch', '')
  } else {
    input.removeAttribute('switch') // jit: clear any leftover from a prior gesture on this element
  }
}

function disarmIfAlwaysOn(input: HTMLInputElement) {
  if (ARM_STRATEGY === 'always-remove-on-pan') input.removeAttribute('switch')
}

function commitTap(input: HTMLInputElement) {
  if (ARM_STRATEGY !== 'jit') return
  input.setAttribute('switch', '')
  input.getBoundingClientRect() // forces style + a full layout before WebKit's own touchend handler runs
}

function qualifies(): boolean {
  if (!gesture.ok) return false
  // A scrim keeps only the disqualifiers that also stop the click: a second finger and a touchcancel.
  // Drift, duration and the scroll parent all describe a scroll, and its surface has none.
  if (gesture.scrim) return true
  if (!withinTapWindow(gesture.t)) return false
  return !gesture.scrollParent || scrollTopOf(gesture.scrollParent) === gesture.scrollTopAtStart
}

export function HapticOverlay({
  preset = 'mid',
  onTap,
  disabled,
  // Set when onTap already calls haptic() itself (e.g. a shared close/submit handler) so we don't double
  // the Android vibrate call.
  silent,
  // Set ONLY on a full-surface overlay whose surface cannot scroll (a fixed modal backdrop, a tour
  // scrim). See the header: it is what keeps the tick from diverging from the action there. Never set it
  // on a row inside a scrolling list, that is exactly the scroll mis-fire the whole file exists to avoid.
  scrim,
  // The click sound. Defaults to the tap under every app-surface button; pass another name when the
  // target is really a toggle, or null where the handler plays its own (the console preset rail).
  sfx = 'tap',
  className,
  style,
}: {
  preset?: HapticPreset
  onTap: () => void
  disabled?: boolean
  silent?: boolean
  scrim?: boolean
  sfx?: UiSfxName | null
  className?: string
  style?: React.CSSProperties
}) {
  // Per-instance, NOT the module gesture: guards against a possible second click for one physical press
  // (WebKit's synthesized switch click landing alongside the platform's own tap-recognizer click is
  // unverified either way, see the memory doc §5). Reset on every new press so mouse users, who never
  // fire a touchstart, are never latched shut after their first click.
  const firedRef = useRef(false)

  function onTouchStart(e: React.TouchEvent<HTMLInputElement>) {
    const input = e.currentTarget
    armAtGestureStart(input)
    const t = e.touches[0]
    if (!t) return
    const scrollParent = scrim ? null : nearestScrollParent(input)
    gesture = {
      active: true,
      ok: e.touches.length === 1,
      el: input,
      x: t.clientX,
      y: t.clientY,
      t: performance.now(),
      scrollParent,
      scrollTopAtStart: scrollParent ? scrollTopOf(scrollParent) : 0,
      scrim: !!scrim,
    }
    if (scrollParent) attachScrollGuard(scrollParent)
    else detachScrollGuard()
  }

  function onTouchMove(e: React.TouchEvent<HTMLInputElement>) {
    const input = e.currentTarget
    if (!gesture.active || gesture.el !== input) return
    if (e.touches.length !== 1) {
      gesture.ok = false
      disarmIfAlwaysOn(input)
      return
    }
    const t = e.touches[0]
    if (!t) return
    if (!gesture.scrim && exceedsSlop(t.clientX - gesture.x, t.clientY - gesture.y)) {
      gesture.ok = false
      disarmIfAlwaysOn(input)
    }
  }

  function onTouchEnd(e: React.TouchEvent<HTMLInputElement>) {
    const input = e.currentTarget
    if (!gesture.active || gesture.el !== input) return
    gesture.active = false
    detachScrollGuard()
    // Read live, not captured at render: a Settings > Haptics flip must take effect on the very next tap.
    if (qualifies() && iosNoVibrate() && isHapticsEnabled()) commitTap(input)
  }

  function onTouchCancel(e: React.TouchEvent<HTMLInputElement>) {
    const input = e.currentTarget
    if (gesture.el !== input) return
    gesture.active = false
    gesture.ok = false
    disarmIfAlwaysOn(input)
    detachScrollGuard()
  }

  return (
    <input
      type="checkbox"
      // No `switch` here: it is added imperatively (see the module above), never rendered, or it would
      // be present for the whole component lifetime instead of just an already-qualified tap.
      aria-hidden="true"
      tabIndex={-1}
      // aria-disabled, not disabled: a disabled control swallows the click outright, and a dead control
      // that answers with nothing at all is exactly what the reject sound is here to fix.
      aria-disabled={disabled || undefined}
      onPointerDown={() => {
        firedRef.current = false
      }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
      onClick={(e) => {
        // Keeps the checkbox's own state pristine and stops any stray `change` (didDispatchClick skips it
        // when the click was default-prevented, CheckboxInputType.cpp:257-268); the haptic tick, if any,
        // already fired inside WebKit before this handler runs.
        e.preventDefault()
        if (disabled) {
          uiSfx('disabled')
          return
        }
        if (firedRef.current) return
        firedRef.current = true
        if (!silent) haptic(preset)
        if (sfx) uiSfx(sfx)
        onTap()
      }}
      className={cnm(
        'block w-full h-full cursor-pointer touch-manipulation appearance-none border-0 bg-transparent p-0 m-0 outline-none',
        className,
      )}
      style={style}
    />
  )
}
