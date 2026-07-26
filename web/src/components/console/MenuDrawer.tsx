// The menu lives in a near-fullscreen bottom drawer that slides up over the device; the console sits behind it, dimmed and blurred. Route-driven (mounted whenever a /menu route matches), sub-screens render through the child Outlet.
// Closing slides it back down, then routes to `returnTo` (where the user came from).
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
import { PerfDebug } from '@/components/menu/PerfDebug'
import { perfSlideMs } from '@/lib/perfDebug'
import { useReducedMotion } from '@/hooks/useReducedMotion'

// Lets a menu item slide the drawer away before navigating (e.g. Customize's handoff), reusing the proven close animation instead of an unmount transition.
const MenuDrawerContext = createContext<{
  closeTo: (to: string) => void
} | null>(null)
export function useMenuDrawer() {
  return useContext(MenuDrawerContext)
}

// Safety net only. Normal close navigation is driven by the sheet's animationend event.
const CLOSE_FALLBACK_MS = 600

/* ---- menu page slide ---------------------------------------------------------------------------
   Native-style push/pop between /menu pages. This used to ride the View Transition API, which on iOS
   costs one blocking frame of 713-840ms per nav (measured on device: input 10ms, route commit 24ms,
   then a single 731ms frame, so the 420ms slide got 7-10fps). The same capture is 46ms on a desktop
   GPU, which is why it only ever showed up on iPhone. Nothing about it was tunable, blur, edge shadow,
   group clip, dim+scale and hiding the 3D console all measured identical.
   So: no browser snapshot. The outgoing page is a detached clone (~1ms) parked under the incoming one,
   and both ride the compositor on transform/opacity. This is not a second <Outlet>, it is inert DOM,
   so the router never resolves it to the new route. */

const SLIDE_EASE = 'cubic-bezier(0.32,0.72,0,1)'
const EDGE_SHADOW = '-18px 0 42px rgba(0, 0, 0, 0.72)'

let armedDir: 'forward' | 'back' | null = null
let ghostEl: HTMLElement | null = null
let ghostTimer = 0

function dropGhost() {
  window.clearTimeout(ghostTimer)
  ghostTimer = 0
  ghostEl?.remove()
  ghostEl = null
  armedDir = null
}

// Runs from the click handler, before navigate(), while the outgoing page is still the live one.
export function armMenuSlide(direction: 'forward' | 'back'): void {
  if (typeof document === 'undefined') return
  dropGhost()
  const host = document.querySelector<HTMLElement>('.menu-page-transition')
  const live = host?.firstElementChild as HTMLElement | null
  if (!host || !live) return
  const clone = live.cloneNode(true) as HTMLElement
  clone.setAttribute('inert', '')
  clone.style.cssText =
    'position:absolute;inset:0;overflow:hidden;pointer-events:none;background:#000;will-change:transform,opacity'
  clone.style.zIndex = direction === 'back' ? '2' : '1'
  host.appendChild(clone)
  // overflow:hidden still scrolls programmatically, so a sticky header lands exactly where it was.
  clone.scrollTop = live.scrollTop
  // The bottom fade belongs to the page being left; the deferred updateFade below restores it.
  const fade = host.lastElementChild as HTMLElement | null
  if (fade && fade !== clone) fade.style.opacity = '0'
  ghostEl = clone
  armedDir = direction
  ghostTimer = window.setTimeout(dropGhost, perfSlideMs() + 600) // nav blocked: never strand a copy
}

// Runs from the drawer's layout effect, once the new page has committed.
function runMenuSlide(incoming: HTMLElement, reduced: boolean): void {
  const dir = armedDir
  const ghost = ghostEl
  armedDir = null
  if (!dir) return
  if (reduced || !ghost || typeof incoming.animate !== 'function') {
    dropGhost()
    return
  }
  window.clearTimeout(ghostTimer)
  ghostTimer = 0

  const opts = { duration: perfSlideMs(), easing: SLIDE_EASE }
  const rest = { transform: 'translateX(0) scale(1)', opacity: '1' }
  const recede = { transform: 'translateX(-22%) scale(0.985)', opacity: '0.52' }
  const offRight = { transform: 'translateX(100%)' }

  incoming.style.position = 'relative'
  incoming.style.zIndex = dir === 'back' ? '1' : '2'
  incoming.style.willChange = 'transform, opacity'
  // The shadow rides whichever layer owns the moving edge, so it paints into that layer once.
  if (dir === 'forward') incoming.style.boxShadow = EDGE_SHADOW
  else ghost.style.boxShadow = EDGE_SHADOW

  incoming.animate(dir === 'forward' ? [offRight, rest] : [recede, rest], opts)
  const out = ghost.animate(dir === 'forward' ? [rest, recede] : [rest, offRight], {
    ...opts,
    fill: 'both',
  })
  const clear = () => {
    incoming.style.position = ''
    incoming.style.zIndex = ''
    incoming.style.willChange = ''
    incoming.style.boxShadow = ''
    dropGhost()
  }
  out.finished.then(clear, clear) // a cancelled animation rejects, and still has to clean up
}

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
  // resolvedLocation (not location) on purpose: location flips the instant a nav starts, before the Outlet swaps, so keying off it would snap the still-showing OUTGOING page to the top for a frame.
  // resolvedLocation updates only once the nav fully settles (same fallback TanStack's own scroll-restoration uses), so by remount the Outlet is already on the new page.
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
  // Drag-to-dismiss: the grabber pulls the sheet down, native bottom-sheet style; transform drives straight on the node (no per-move re-render), React state flips only on release.
  const sheetRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const restedRef = useRef(false) // true once the rise settles, so a drag never fights the open
  const draggedRef = useRef(false) // distinguishes a real drag from a plain tap on the grabber
  const dragRef = useRef({ active: false, startY: 0, dy: 0, maxDy: 0, lastY: 0, lastT: 0, vel: 0 })

  // Remember each menu route's scroll offset (recorded live below), so popping back from a sub-page lands where you left off. A fresh page has no entry, so it still opens at the top.
  // The scroll container is deliberately NOT keyed on the route: resolvedLocation only lands after the nav
  // settles, so a key there mounted every page twice (once when the Outlet swapped, again when the key
  // caught up). The layout effect below owns the reset instead, one mount per navigation.
  const scrollMemory = useRef<Record<string, number>>({})

  // Bottom fade: hints there's content clipped below the fold, gone once fully scrolled. Styled straight on the node, no per-scroll re-render.
  const fadeRef = useRef<HTMLDivElement>(null)
  const updateFade = useCallback(() => {
    const el = scrollRef.current
    const fade = fadeRef.current
    if (!el || !fade) return
    fade.style.opacity = el.scrollHeight - el.scrollTop - el.clientHeight > 24 ? '1' : '0'
  }, [])

  // Fires once per nav, with the new page committed and not yet painted, which is exactly when the slide
  // has to start. Everything that forces layout (scrollHeight, a ResizeObserver) is deferred a frame: by
  // then the slide is already running and it costs nothing visible. The fade is a hint, a frame late is
  // invisible.
  useLayoutEffect(() => {
    const scrollElement = scrollRef.current
    if (!scrollElement) return
    // A forward nav has no stored offset and a fresh element is already at 0, so skip the write entirely.
    const top = scrollMemory.current[pathname] ?? 0
    if (top) scrollElement.scrollTop = top
    runMenuSlide(scrollElement, reduced)
    const raf = requestAnimationFrame(() => {
      updateFade()
      // Page height lands async (queries, images), so watch the boxes too, not just scroll events.
      ro = new ResizeObserver(updateFade)
      ro.observe(scrollElement)
      if (scrollElement.firstElementChild) ro.observe(scrollElement.firstElementChild)
    })
    let ro: ResizeObserver | undefined
    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
    }
  }, [pathname, updateFade, reduced])

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

  // Slide down, then route. `to` defaults to where the user came from; Customize passes its own route so the drawer clears before the studio takes over.
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

  // Reduced motion skips the rise keyframe (no animationend to mark it settled), so treat the sheet as ready right away so the grabber drag still works.
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

  // Marks that the console is behind a drawer, so the perf bisect can hide it without a React re-render.
  useEffect(() => {
    document.documentElement.dataset.drawer = 'open'
    return () => {
      delete document.documentElement.dataset.drawer
    }
  }, [])

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
    // Rise done: the keyframe no longer holds the transform (fill: backwards), so inline transform from the grabber drag takes over; just mark it ready.
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

        {/* This named surface is snapshotted by the browser during menu route changes, preserving the outgoing page while the next slides over it. */}
        <div className="menu-page-transition relative min-h-0 flex-1 overflow-hidden bg-black">
          <div
            ref={scrollRef}
            onScroll={(e) => {
              scrollMemory.current[pathname] = e.currentTarget.scrollTop
              updateFade()
            }}
            className="h-full overflow-y-auto overscroll-contain"
          >
            <MenuDrawerContext.Provider value={{ closeTo }}>
              {children}
            </MenuDrawerContext.Provider>
          </div>
          {/* Inside the named surface on purpose, so it snapshots with the page during route transitions. */}
          <div
            ref={fadeRef}
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black to-transparent opacity-0 transition-opacity duration-300"
          />
        </div>
      </div>

      {/* Outside the named surface on purpose, so it never gets snapshotted into a page transition. */}
      <PerfDebug />
    </div>
  )
}
