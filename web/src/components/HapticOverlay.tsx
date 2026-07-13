// A real, invisible native switch laid directly over a tap target. iOS Safari fires its native
// Taptic tick only for a genuine physical tap landing on a switch-type checkbox, never for a
// script-triggered .click() (Apple closed that loophole in 26.5). So this element has to BE the
// literal thing the finger touches: never display:none (needs to stay in the render tree), never
// controlled (let the browser freely flip its own checked state so the native toggle, and the
// haptic tied to it, completes undisturbed).
//
// Usage: wrap the visible button in a `relative` container, add `pointer-events-none` to it (it
// keeps its own onClick for keyboard Enter/Space), and drop this as a sibling:
//   <div className="relative">
//     <button className="pointer-events-none" onClick={onTap}>Label</button>
//     <HapticOverlay className="absolute inset-0" preset="selection" onTap={onTap} />
//   </div>
// Pointer/touch always hits this overlay (topmost), keyboard always hits the real button
// (tabIndex={-1} here), so there's no double-fire.
import { cnm } from '@/utils/style'
import { haptic } from '@/lib/haptics'
import type { HapticPreset } from '@/lib/haptics'

export function HapticOverlay({
  preset = 'selection',
  onTap,
  disabled,
  // Set when onTap already calls haptic() itself (e.g. a shared close/submit handler), so this
  // overlay only forwards the tap and doesn't double up the Android vibrate call. The real iOS
  // tick still fires either way, it's an inherent side effect of the physical tap on the switch.
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
  return (
    <input
      type="checkbox"
      {...{ switch: '' }}
      aria-hidden="true"
      tabIndex={-1}
      disabled={disabled}
      onChange={() => {
        if (disabled) return
        if (!silent) haptic(preset)
        onTap()
      }}
      className={cnm('appearance-none opacity-0', className)}
      style={style}
    />
  )
}
