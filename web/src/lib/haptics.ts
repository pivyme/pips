// One haptics instance for the whole app. Silent where unsupported (desktop,
// iOS Safari without the gesture, etc.) so callers never have to guard.
// Presets come from web-haptics: selection (knob detents), medium/rigid
// (button press), success/buzz (a win), error/warning (a loss).
import { WebHaptics } from 'web-haptics'
import type { HapticInput } from 'web-haptics'

let instance: WebHaptics | null = null
let enabled = true

function get(): WebHaptics | null {
  if (typeof window === 'undefined') return null
  if (!instance) instance = new WebHaptics({ showSwitch: false })
  return instance
}

// Driven by the user's Haptics setting (synced from the auth user). When off, every call is a
// no-op so screens don't have to check.
export function setHapticsEnabled(value: boolean): void {
  enabled = value
}

export function haptic(input: HapticInput = 'selection') {
  if (!enabled) return
  void get()?.trigger(input)
}
