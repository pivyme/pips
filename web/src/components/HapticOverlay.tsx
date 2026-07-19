// A real, invisible native switch over the tap target: iOS Safari's Taptic tick only fires for a genuine
// physical tap on a switch checkbox, never a script .click() (closed in 26.5), so it must stay in the render tree, uncontrolled. Wrap the button `relative pointer-events-none` and drop this as an absolute sibling; touch hits this (topmost), keyboard hits the real button (tabIndex={-1}).
import { useRef } from 'react'
import { cnm } from '@/utils/style'
import { haptic } from '@/lib/haptics'
import type { HapticPreset } from '@/lib/haptics'

// Past this much finger travel we treat the gesture as a scroll, not a tap. A native switch also toggles
// on drag, so without this any scroll starting on a button fires its onChange and mis-navigates.
const TAP_SLOP_PX = 10

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
  const start = useRef<{ x: number; y: number } | null>(null)
  const moved = useRef(false)

  const begin = (x: number, y: number) => {
    start.current = { x, y }
    moved.current = false
  }
  const track = (x: number, y: number) => {
    const s = start.current
    if (s && (Math.abs(x - s.x) > TAP_SLOP_PX || Math.abs(y - s.y) > TAP_SLOP_PX)) moved.current = true
  }

  return (
    <input
      type="checkbox"
      {...{ switch: '' }}
      aria-hidden="true"
      tabIndex={-1}
      disabled={disabled}
      onPointerDown={(e) => begin(e.clientX, e.clientY)}
      onPointerMove={(e) => track(e.clientX, e.clientY)}
      onTouchStart={(e) => {
        const t = e.touches[0]
        if (t) begin(t.clientX, t.clientY)
      }}
      onTouchMove={(e) => {
        const t = e.touches[0]
        if (t) track(t.clientX, t.clientY)
      }}
      onChange={() => {
        if (disabled) return
        // Scrolled/dragged past slop, not a tap: swallow it. The checkbox still toggled, but it's uncontrolled and unused.
        if (moved.current) {
          moved.current = false
          return
        }
        if (!silent) haptic(preset)
        onTap()
      }}
      className={cnm('appearance-none opacity-0', className)}
      style={style}
    />
  )
}
