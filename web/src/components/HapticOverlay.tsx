// An invisible click layer over a tap target. The visible button/link underneath is `pointer-events-none`
// and owns keyboard/screen-reader access; this sits on top as the pointer/touch target and fires on a real
// `click`. A click is only dispatched for a genuine tap, never at the end of a scroll, so scrolling a list
// can't mis-trigger a button (the old native-`switch` overlay toggled on drag and did exactly that).
//
// Haptics: Android buzzes via navigator.vibrate in haptic(). iOS Safari has no web vibration API and its
// only tick comes from physically toggling a real <input switch>, which is inherently drag-happy and fights
// scrolling, so we don't use it on these scrollable app-surface buttons. The physical console buttons
// (ConsoleCanvas) keep that switch tick since they never live in a scroll container.
import { cnm } from '@/utils/style'
import { haptic } from '@/lib/haptics'
import type { HapticPreset } from '@/lib/haptics'
import { uiSfx } from '@/lib/uiSfx'
import type { UiSfxName } from '@/lib/uiSfx'

export function HapticOverlay({
  preset = 'selection',
  onTap,
  disabled,
  // Set when onTap already calls haptic() itself (e.g. a shared close/submit handler) so we don't double
  // the Android vibrate call.
  silent,
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
  sfx?: UiSfxName | null
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <button
      type="button"
      aria-hidden="true"
      tabIndex={-1}
      // aria-disabled, not disabled: a disabled button swallows the click outright, and a dead control
      // that answers with nothing at all is exactly what the reject sound is here to fix.
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (disabled) {
          uiSfx('disabled')
          return
        }
        if (!silent) haptic(preset)
        if (sfx) uiSfx(sfx)
        onTap()
      }}
      className={cnm('block cursor-pointer appearance-none border-0 bg-transparent p-0 outline-none', className)}
      style={style}
    />
  )
}
