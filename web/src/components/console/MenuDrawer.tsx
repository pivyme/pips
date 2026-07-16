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
import type { AnimationEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { haptic } from '@/lib/haptics'
import { HapticOverlay } from '@/components/HapticOverlay'
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
  // resolvedLocation (not location) on purpose: location flips the instant a nav starts, before the
  // Outlet has actually swapped to the new match. Keying/reset off that fires while this div still
  // shows the OUTGOING page, snapping IT to the top for a frame before the real transition even
  // plays. resolvedLocation only updates once the navigation has fully settled (TanStack Router's own
  // scroll-restoration module uses the same fallback pattern), so by the time this remounts, the
  // Outlet is already on the new page.
  const pathname = useRouterState({
    select: (state) => (state.resolvedLocation ?? state.location).pathname,
  })
  const reduced = useReducedMotion()
  const [closing, setClosing] = useState(false)
  const [launching, setLaunching] = useState(false)
  const closingRef = useRef(false)
  const closeTargetRef = useRef<string | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Drag-to-dismiss: the grabber pulls the whole sheet down, native bottom-sheet style. We drive the
  // transform straight on the node (no per-move re-render) and only flip React state on release.
  const sheetRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const restedRef = useRef(false) // true once the rise settles, so a drag never fights the open
  const draggedRef = useRef(false) // distinguishes a real drag from a plain tap on the grabber
  const dragRef = useRef({ active: false, startY: 0, dy: 0, maxDy: 0, lastY: 0, lastT: 0, vel: 0 })

  // Each route owns its scroll viewport (a fresh node per pathname, see key={pathname} below), so it
  // always mounts at scrollTop 0, forward or back. No saved-position map, nothing to go stale.
  useLayoutEffect(() => {
    const scrollElement = scrollRef.current
    if (scrollElement) scrollElement.scrollTop = 0
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

  // Reduced motion skips the rise keyframe, so there's no animationend to mark it settled: treat the
  // sheet as ready right away so the grabber drag still works.
  useEffect(() => {
    if (reduced) restedRef.current = true
  }, [reduced])

  // Fly the sheet the rest of the way down from wherever the finger left it, then route.
  const dragClose = useCallback(
    (h: number) => {
      if (closingRef.current) return
      closingRef.current = true
      haptic('selection')
      const el = sheetRef.current
      if (el) {
        el.style.transition = 'transform 260ms cubic-bezier(0.32,0.72,0,1)'
        el.style.transform = `translateY(${h + 48}px)`
      }
      const sc = scrimRef.current
      if (sc) {
        sc.style.transition = 'opacity 240ms ease'
        sc.style.opacity = '0'
      }
      closeTargetRef.current = returnTo
      closeTimerRef.current = window.setTimeout(finishClose, 270)
    },
    [finishClose, returnTo],
  )

  // Released short of the threshold: ease back to fully open.
  const snapBack = useCallback(() => {
    const el = sheetRef.current
    if (el) {
      el.style.transition = 'transform 300ms cubic-bezier(0.22,1,0.36,1)'
      el.style.transform = 'translateY(0)'
    }
    const sc = scrimRef.current
    if (sc) {
      sc.style.transition = 'opacity 280ms ease'
      sc.style.opacity = '1'
    }
  }, [])

  const onGrabberPointerDown = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!restedRef.current || closingRef.current) return
    const d = dragRef.current
    d.active = true
    d.startY = e.clientY
    d.dy = 0
    d.maxDy = 0
    d.lastY = e.clientY
    d.lastT = e.timeStamp
    d.vel = 0
    draggedRef.current = false
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // capture is best-effort
    }
    const el = sheetRef.current
    if (el) el.style.transition = 'none'
    const sc = scrimRef.current
    if (sc) {
      sc.style.animation = 'none'
      sc.style.transition = 'none'
    }
  }, [])

  const onGrabberPointerMove = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current
    if (!d.active) return
    let dy = e.clientY - d.startY
    if (dy < 0) dy = dy * 0.25 // rubber-band the upward overshoot, this sheet only closes downward
    d.dy = dy
    d.maxDy = Math.max(d.maxDy, Math.abs(dy))
    const dt = Math.max(1, e.timeStamp - d.lastT)
    d.vel = (e.clientY - d.lastY) / dt
    d.lastY = e.clientY
    d.lastT = e.timeStamp
    if (d.maxDy > 6) draggedRef.current = true
    const shown = Math.max(0, dy)
    const el = sheetRef.current
    if (el) el.style.transform = `translateY(${shown}px)`
    const sc = scrimRef.current
    const h = el?.offsetHeight || 1
    if (sc) sc.style.opacity = String(Math.max(0, 1 - shown / h))
  }, [])

  const onGrabberPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      const d = dragRef.current
      if (!d.active) return
      d.active = false
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        // already released
      }
      if (!draggedRef.current) return // a tap, let the grabber's onClick close it
      const h = sheetRef.current?.offsetHeight || 800
      // Past a quarter of the sheet, or a firm downward flick, dismiss. Otherwise spring back.
      if (d.dy > h * 0.25 || d.vel > 0.7) dragClose(h)
      else snapBack()
    },
    [dragClose, snapBack],
  )

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
    if (event.currentTarget !== event.target) return
    // Rise done: the keyframe no longer holds the transform (fill: backwards), so inline transform
    // from the grabber drag takes over from here. Just mark it ready.
    if (event.animationName === 'drawer-rise') {
      restedRef.current = true
      return
    }
    if (closingRef.current && event.animationName === 'drawer-fall') finishClose()
  }

  return (
    <div
      className="absolute inset-0 z-50"
      data-closing={closing || undefined}
      data-launching={launching || undefined}
    >
      {/* The console behind, dimmed and blurred. Fades in with the sheet and back out on close. Tap to close. */}
      <div
        ref={scrimRef}
        className="drawer-scrim absolute inset-0 bg-black/22 backdrop-blur-[9px]"
        aria-hidden
      />
      <HapticOverlay className="absolute inset-0" preset="selection" silent onTap={close} />

      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        onAnimationEnd={handleSheetAnimationEnd}
        className="drawer-sheet absolute inset-x-0 bottom-0 top-[10%] flex flex-col overflow-hidden rounded-t-[28px] border-x border-t border-white/10 bg-black shadow-[0_-24px_64px_-24px_rgba(0,0,0,0.95)]"
      >
        {/* Grabber: drag down to dismiss, or tap. touch-none so the drag never fights native scroll. */}
        <button
          type="button"
          onClick={() => {
            if (draggedRef.current) {
              draggedRef.current = false
              return
            }
            close()
          }}
          onPointerDown={onGrabberPointerDown}
          onPointerMove={onGrabberPointerMove}
          onPointerUp={onGrabberPointerUp}
          onPointerCancel={onGrabberPointerUp}
          aria-label="Close menu"
          className="flex h-9 w-full shrink-0 touch-none cursor-grab items-center justify-center active:cursor-grabbing"
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
