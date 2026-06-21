// A dead-simple soft gate for a private test deploy: tapping START on the door asks for an access
// code before letting anyone into the app. This is NOT real security (the code ships in the client
// bundle and the check is client-side), it just keeps the public out while we test. Toggled entirely
// by VITE_ACCESS_GUARD; the secret is VITE_ACCESS_CODE. A correct code is remembered per-device so
// the door never asks twice.
import { env } from '@/env'

const STORAGE_KEY = 'pips_access'

export function accessGuardEnabled(): boolean {
  return env.VITE_ACCESS_GUARD === 'true'
}

// True when the gate is off, or this device already entered the current code. We store the code
// itself, so rotating VITE_ACCESS_CODE automatically re-locks everyone.
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
