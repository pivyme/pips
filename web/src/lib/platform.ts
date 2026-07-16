// Mobile install-context detection + Android beforeinstallprompt capture, behind one hook, drives the Add-to-Home-Screen
// guide (components/InstallGate). SSR-safe (window-guarded, inert 'desktop' on server); a pre-paint layout effect commits the real context so the guide never flashes.
import { useCallback, useEffect, useLayoutEffect, useReducer, useState } from 'react'
import { haptic } from '@/lib/haptics'

export type InstallContext =
  | 'standalone' // already launched from the home screen, no guide
  | 'android-prompt' // Android engine that can fire the native install prompt
  | 'ios-safari' // iOS Safari, the only iOS browser that installs a real web app
  | 'ios-other' // iOS Chrome/Firefox/etc, must switch to Safari to install
  | 'in-app' // an in-app webview (Telegram/IG/FB/...), must open the real browser
  | 'desktop' // not mobile, no guide

export interface InstallGateState {
  active: boolean
  ctx: InstallContext
  canPrompt: boolean
  promptInstall: () => Promise<void>
  // Dismiss the guide. By default it returns next visit; only `dontShowAgain` persists the skip.
  skip: (dontShowAgain: boolean) => void
}

// Chrome's install event isn't in the DOM lib types.
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[]
  prompt: () => Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

const DISMISS_KEY = 'pips_install_dismissed'

// ---- module-level prompt capture (Chrome fires beforeinstallprompt once, often after first paint) ----
let deferredPrompt: BeforeInstallPromptEvent | null = null
let installed = false
const subscribers = new Set<() => void>()
const notify = () => subscribers.forEach((fn) => fn())

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault() // stop Chrome's own mini-infobar; we drive the install from our button
    deferredPrompt = e as BeforeInstallPromptEvent
    notify()
  })
  window.addEventListener('appinstalled', () => {
    installed = true
    deferredPrompt = null
    notify()
  })
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn)
  return () => {
    subscribers.delete(fn)
  }
}

// ---- detection ----
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true ||
    document.referrer.startsWith('android-app://')
  )
}

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/i.test(ua)) return true
  // iPadOS 13+ reports a desktop Mac UA; the touch points give it away.
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
}

function isInAppBrowser(): boolean {
  if (typeof navigator === 'undefined') return false
  return /FBAN|FBAV|Instagram|Telegram|Line\/|Twitter|TikTok|Snapchat|MicroMessenger|WhatsApp|GSA/i.test(
    navigator.userAgent,
  )
}

function isIOSSafari(): boolean {
  // Every iOS browser is WebKit, but the wrappers carry their own token.
  const otherIOS = /CriOS|FxiOS|EdgiOS|OPiOS|mercury/i.test(navigator.userAgent)
  return isIOS() && !otherIOS
}

export function isMobile(): boolean {
  if (typeof window === 'undefined') return false
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData
  if (uaData && typeof uaData.mobile === 'boolean') return uaData.mobile
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const small = window.innerWidth <= 820
  const uaMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  return (coarse && small) || uaMobile || isIOS()
}

export function getInstallContext(): InstallContext {
  if (typeof window === 'undefined') return 'desktop'
  if (isStandalone() || installed) return 'standalone'
  if (!isMobile()) return 'desktop'
  if (isInAppBrowser()) return 'in-app'
  if (isIOS()) return isIOSSafari() ? 'ios-safari' : 'ios-other'
  return 'android-prompt'
}

function isDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

// The one hook the app mounts. `active` commits in a pre-paint layout effect so the first painted mobile frame
// already shows the guide with no console flash. Always skippable: skip() persists a per-device flag so it never returns.
export function useInstallGate(): InstallGateState {
  const [client, setClient] = useState(false)
  const [ctx, setCtx] = useState<InstallContext>('desktop')
  const [dismissed, setDismissed] = useState(false)
  const [, bump] = useReducer((n: number) => n + 1, 0)

  useIsoLayoutEffect(() => {
    setClient(true)
    setCtx(getInstallContext())
    setDismissed(isDismissed())
  }, [])

  // Re-evaluate when Chrome's prompt finally arrives, or the app gets installed mid-session.
  useEffect(
    () =>
      subscribe(() => {
        setCtx(getInstallContext())
        bump()
      }),
    [],
  )

  const skip = useCallback((dontShowAgain: boolean) => {
    // Default hides for this visit only (the guide returns next time); only the explicit "Don't show again" checkbox persists across visits.
    if (dontShowAgain) {
      try {
        window.localStorage.setItem(DISMISS_KEY, '1')
      } catch {
        // private mode / storage blocked: they'll just see it again next visit, never a hard block.
      }
    }
    haptic('selection')
    setDismissed(true)
  }, [])

  const promptInstall = useCallback(async () => {
    if (!deferredPrompt) return
    haptic('rigid')
    const e = deferredPrompt
    deferredPrompt = null // a captured prompt can only be used once
    try {
      await e.prompt()
      await e.userChoice
    } catch {
      // dismissed or raced: appinstalled clears the gate on success; otherwise the manual steps stand.
    }
    bump()
  }, [])

  const active = client && ctx !== 'desktop' && ctx !== 'standalone' && !dismissed
  const canPrompt = ctx === 'android-prompt' && deferredPrompt !== null

  return { active, ctx, canPrompt, promptInstall, skip }
}
