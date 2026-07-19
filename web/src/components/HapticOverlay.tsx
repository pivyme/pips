// A real, invisible native switch over the tap target: iOS Safari's Taptic tick only fires for a genuine
// physical tap on a switch checkbox, never a script .click() (closed in 26.5), so it must stay in the render tree, uncontrolled. Wrap the button `relative pointer-events-none` and drop this as an absolute sibling; touch hits this (topmost), keyboard hits the real button (tabIndex={-1}).
import { cnm } from '@/utils/style'
import { haptic } from '@/lib/haptics'
import type { HapticPreset } from '@/lib/haptics'

// Past this much finger travel we treat the gesture as a scroll/pan, not a tap.
const TAP_SLOP_PX = 10

// One window-level gesture tracker shared by every overlay. A native iOS switch toggles at the tail of a
// swipe too, and its own gesture handling can eat the element's own move events before React sees them,
// so we watch the whole gesture in the capture phase (passive, unstoppable) and just ask "did it pan?".
// panning is reset by the next press and stays set through the toggle that ends the same gesture.
let panning = false
let startX = 0
let startY = 0
let listening = false

function gestureStart(x: number, y: number) {
  startX = x
  startY = y
  panning = false
}
function gestureMove(x: number, y: number) {
  if (Math.abs(x - startX) > TAP_SLOP_PX || Math.abs(y - startY) > TAP_SLOP_PX) panning = true
}

function ensureListening() {
  if (listening || typeof window === 'undefined') return
  listening = true
  const opts = { capture: true, passive: true }
  window.addEventListener('touchstart', (e) => { const t = (e as TouchEvent).touches[0]; if (t) gestureStart(t.clientX, t.clientY) }, opts)
  window.addEventListener('touchmove', (e) => { const t = (e as TouchEvent).touches[0]; if (t) gestureMove(t.clientX, t.clientY) }, opts)
  window.addEventListener('pointerdown', (e) => gestureStart((e as PointerEvent).clientX, (e as PointerEvent).clientY), opts)
  window.addEventListener('pointermove', (e) => { const p = e as PointerEvent; if (p.buttons > 0) gestureMove(p.clientX, p.clientY) }, opts)
}

export function HapticOverlay({
  preset = 'selection',
  onTap,
  disabled,
  // Set when onTap already calls haptic() itself (e.g. a shared close/submit handler), so this overlay
  // only forwards the tap and doesn't double the Android vibrate call. The real iOS tick still fires either way, an inherent side effect of the physical tap.
  silent,
  className,
  style,
}: {
  preset?: HapticPreset
  onTap: () => void
  disabled?: boolean
  silent?: boolean
  className?: string
  style?: React.CSSProperties
}) {
  ensureListening()

  return (
    <input
      type="checkbox"
      {...{ switch: '' }}
      aria-hidden="true"
      tabIndex={-1}
      disabled={disabled}
      onChange={() => {
        if (disabled) return
        // The toggle fired at the tail of a scroll/pan, not a real tap: swallow it. The checkbox still
        // toggled, but it's uncontrolled and unused.
        if (panning) return
        if (!silent) haptic(preset)
        onTap()
      }}
      className={cnm('appearance-none opacity-0', className)}
      style={style}
    />
  )
}
