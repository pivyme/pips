// Vibration-based haptic feedback: Android via navigator.vibrate, silent elsewhere (desktop, iOS Safari). iOS has no
// Vibration API and only grants its native switch-toggle haptic to a genuine physical tap, never a scripted one; direct-tap elements get real iOS haptics via <HapticOverlay> instead.
export type HapticPreset = 'tick' | 'selection' | 'medium' | 'rigid' | 'heavy' | 'success' | 'warning' | 'error'

const HAPTIC_MS: Record<HapticPreset, number | number[]> = {
  tick: 4, // the faint detent pulse for scroll/knob steps, deliberately lighter than a button's selection tap
  selection: 8,
  medium: 25,
  rigid: 10,
  heavy: 35,
  success: [30, 60, 40],
  warning: [40, 100, 40],
  error: [40, 40, 40, 40, 40],
}

let enabled = true

// Driven by the user's Haptics setting (synced from the auth user); when off, every call is a no-op so screens don't have to check.
export function setHapticsEnabled(value: boolean): void {
  enabled = value
}

export function haptic(preset: HapticPreset = 'selection'): void {
  if (!enabled) return
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
  navigator.vibrate(HAPTIC_MS[preset])
}
