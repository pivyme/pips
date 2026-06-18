// The menu lives in a near-fullscreen bottom drawer that slides up over the device. While it is
// open the console sits behind it, dimmed and blurred, so the drawer is the whole interface. It is
// route-driven (mounted whenever a /menu route matches), so the menu sub-screens render through the
// child Outlet. Closing slides it back down, then routes to `returnTo` (where the user came from).
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { haptic } from '@/lib/haptics'
import { useReducedMotion } from '@/hooks/useReducedMotion'

// Lets a menu item slide the drawer away before navigating (e.g. Customize handing off to its
// full-screen studio). Reuses the proven close animation instead of an unmount transition.
const MenuDrawerContext = createContext<{ closeTo: (to: string) => void } | null>(null)
export function useMenuDrawer() {
  return useContext(MenuDrawerContext)
}

export function MenuDrawer({
  children,
  returnTo = '/games',
}: {
  children: ReactNode
  returnTo?: string
}) {
  const router = useRouter()
  const reduced = useReducedMotion()
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)

  // Slide down, then route. `to` defaults to where the user came from (a normal close); Customize
  // passes its own route so the drawer clears before the studio takes over.
  const closeTo = useCallback(
    (to: string) => {
      if (closingRef.current) return
      closingRef.current = true
      haptic('selection')
      setClosing(true)
      window.setTimeout(() => router.navigate({ to }), reduced ? 0 : 240)
    },
    [router, reduced],
  )
  const close = useCallback(() => closeTo(returnTo), [closeTo, returnTo])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  return (
    <div className="absolute inset-0 z-50">
      {/* The console behind, dimmed and blurred. Tap to close. */}
      <div
        className="absolute inset-0 bg-black/22 backdrop-blur-[9px]"
        onClick={close}
        aria-hidden
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        data-closing={closing || undefined}
        className="drawer-sheet absolute inset-x-0 bottom-0 top-[10%] flex flex-col overflow-hidden rounded-t-[28px] border-x border-t border-white/10 bg-black shadow-[0_-24px_64px_-24px_rgba(0,0,0,0.95)]"
      >
        {/* Grabber: tap to dismiss. */}
        <button
          type="button"
          onClick={close}
          aria-label="Close menu"
          className="flex h-5 w-full shrink-0 items-center justify-center"
        >
          <span className="h-1.5 w-10 rounded-full bg-text-3/60" />
        </button>

        {/* This named surface is snapshotted by the browser during menu route changes, preserving
            the actual outgoing page while the next page slides over it. */}
        <div
          data-lenis-prevent
          className="menu-page-transition min-h-0 flex-1 overflow-y-auto overscroll-contain bg-black"
        >
          <MenuDrawerContext.Provider value={{ closeTo }}>{children}</MenuDrawerContext.Provider>
        </div>
      </div>
    </div>
  )
}
