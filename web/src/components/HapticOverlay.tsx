// A real, invisible native switch over the tap target: iOS Safari's Taptic tick only fires for a genuine
// physical tap on a switch checkbox, never a script .click() (closed in 26.5), so it must stay in the render tree, uncontrolled. Wrap the button `relative pointer-events-none` and drop this as an absolute sibling; touch hits this (topmost), keyboard hits the real button (tabIndex={-1}).
import { cnm } from '@/utils/style'
import { haptic } from '@/lib/haptics'
import type { HapticPreset } from '@/lib/haptics'

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
