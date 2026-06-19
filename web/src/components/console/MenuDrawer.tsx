// The menu lives in a near-fullscreen bottom drawer that slides up over the device. While it is
// open the console sits behind it, dimmed and blurred, so the drawer is the whole interface. It is
// route-driven (mounted whenever a /menu route matches), so the menu sub-screens render through the
// child Outlet. Closing slides it back down, then routes to `returnTo` (where the user came from).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useRouter, useRouterState } from '@tanstack/react-router'
import type { AnimationEvent, ReactNode } from 'react'
import { haptic } from '@/lib/haptics'
import { useReducedMotion } from '@/hooks/useReducedMotion'

// Lets a menu item slide the drawer away before navigating (e.g. Customize handing off to its
// full-screen studio). Reuses the proven close animation instead of an unmount transition.
const MenuDrawerContext = createContext<{
  closeTo: (to: string) => void
} | null>(null)
export function useMenuDrawer() {
  return useContext(MenuDrawerContext)
}

// Safety net only. Normal close navigation is driven by the sheet's animationend event.
const CLOSE_FALLBACK_MS = 600

export function MenuDrawer({
  children,
  returnTo = '/games',
  onLaunchStart,
}: {
  children: ReactNode
  returnTo?: string
  onLaunchStart?: (to: string) => void
}) {
  const router = useRouter()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const reduced = useReducedMotion()
  const [closing, setClosing] = useState(false)
  const [launching, setLaunching] = useState(false)
  const closingRef = useRef(false)
  const closeTargetRef = useRef<string | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollPositionsRef = useRef(new Map<string, number>())

  // Each route owns its scroll viewport, so changing the destination cannot move the outgoing
  // page before the browser snapshots it. Popping back restores that route's previous position.
  useLayoutEffect(() => {
    const scrollElement = scrollRef.current
    if (!scrollElement) return

    const direction = document.documentElement.dataset.menuTransition
    scrollElement.scrollTop =
      direction === 'back' ? (scrollPositionsRef.current.get(pathname) ?? 0) : 0
  }, [pathname])

  const finishClose = useCallback(() => {
    const to = closeTargetRef.current
    if (!to) return

    closeTargetRef.current = null
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    void router.navigate({ to })
  }, [router])

  // Slide down, then route. `to` defaults to where the user came from (a normal close); Customize
  // passes its own route so the drawer clears before the studio takes over.
  const closeTo = useCallback(
    (to: string) => {
      if (closingRef.current) return
      closingRef.current = true
      haptic('selection')

      if (reduced) {
        void router.navigate({ to })
        return
      }

      closeTargetRef.current = to
      if (to === '/menu/customize') {
        setLaunching(true)
        onLaunchStart?.(to)
      }
      setClosing(true)
      closeTimerRef.current = window.setTimeout(finishClose, CLOSE_FALLBACK_MS)
    },
    [finishClose, onLaunchStart, reduced, router],
  )
  const close = useCallback(() => closeTo(returnTo), [closeTo, returnTo])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current)
      }
    },
    [],
  )

  const handleSheetAnimationEnd = (event: AnimationEvent<HTMLDivElement>) => {
    if (
      closingRef.current &&
      event.currentTarget === event.target &&
      event.animationName === 'drawer-fall'
    ) {
      finishClose()
    }
  }

  return (
    <div
      className="absolute inset-0 z-50"
      data-closing={closing || undefined}
      data-launching={launching || undefined}
    >
      {/* The console behind, dimmed and blurred. Fades in with the sheet and back out on close. Tap to close. */}
      <div
        className="drawer-scrim absolute inset-0 bg-black/22 backdrop-blur-[9px]"
        onClick={close}
        aria-hidden
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        onAnimationEnd={handleSheetAnimationEnd}
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
        <div className="menu-page-transition min-h-0 flex-1 overflow-hidden bg-black">
          <div
            key={pathname}
            ref={scrollRef}
            data-lenis-prevent
            onScroll={(event) => {
              scrollPositionsRef.current.set(
                pathname,
                event.currentTarget.scrollTop,
              )
            }}
            className="h-full overflow-y-auto overscroll-contain"
          >
            <MenuDrawerContext.Provider value={{ closeTo }}>
              {children}
            </MenuDrawerContext.Provider>
          </div>
        </div>
      </div>
    </div>
  )
}
