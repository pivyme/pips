// A dead-simple soft gate for a private test deploy: tapping START asks for VITE_ACCESS_CODE, toggled by
// VITE_ACCESS_GUARD. NOT real security (client-side, code ships in the bundle), just keeps the public out.
import { env } from '@/env'

const STORAGE_KEY = 'pips_access'

export function accessGuardEnabled(): boolean {
  return env.VITE_ACCESS_GUARD === 'true'
}

// True when the gate is off, or this device already entered the current code; we store the code itself, so rotating VITE_ACCESS_CODE re-locks everyone.
export function isUnlocked(): boolean {
  if (!accessGuardEnabled()) return true
  if (!env.VITE_ACCESS_CODE) return false // guard on but misconfigured: stay locked
  try {
    return window.localStorage.getItem(STORAGE_KEY) === env.VITE_ACCESS_CODE
  } catch {
    return false
  }
}

// Check a typed code; on a match, remember it so we don't ask again on this device.
export function tryUnlock(code: string): boolean {
  const ok = !!env.VITE_ACCESS_CODE && code.trim() === env.VITE_ACCESS_CODE
  if (ok) {
    try {
      window.localStorage.setItem(STORAGE_KEY, env.VITE_ACCESS_CODE!)
    } catch {
      // private mode / storage blocked: they'll just be asked again next visit.
    }
  }
  return ok
}
