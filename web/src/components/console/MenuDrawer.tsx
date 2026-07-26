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
   So: no browser snapshot. The outgoing page is a clone (~1ms) that rides the compositor next to the
   incoming one on transform/opacity. This is not a second <Outlet>, it is inert DOM, so the router
   never resolves it to the new route.
   Three things below are not decoration, each one fixed a visible artifact: the clone renders before
   it is shown (a cold layer paints with no images in it), the slide starts on the DOM swap and not on
   React's pathname (which arrives ~40ms late, after the new page has already painted at rest), and it
   holds at frame zero until frames are normal length (the clock runs through a long frame whether or
   not anything is on screen, and this easing turns 70ms of that into half the distance). */

const SLIDE_EASE = 'cubic-bezier(0.32,0.72,0,1)'
const EDGE_SHADOW = '-18px 0 42px rgba(0, 0, 0, 0.72)'
const SETTLED_FRAME_MS = 24 // a frame this short means the commit's work is behind us (120Hz: 8, 60Hz: 17)
const MAX_HOLD_MS = 180 // a page that never settles still has to slide

let armedDir: 'forward' | 'back' | null = null
let ghostEl: HTMLElement | null = null
let ghostTimer = 0
let commitWatch: MutationObserver | null = null
let slideAnims: Array<Animation> = []
let slideReduced = false

// Each menu route's scroll offset, so popping back lands where you left off and a page you have not
// opened yet starts at the top. Module scope because the swap has to restore it before the frame is
// painted, which is well before React tells the drawer anything. Cleared when the drawer mounts.
const scrollMemory = new Map<string, number>()

function dropGhost() {
  window.clearTimeout(ghostTimer)
  ghostTimer = 0
  commitWatch?.disconnect()
  commitWatch = null
  // These fill both ways, so leaving one behind would strand the page in its opening pose.
  slideAnims.forEach((a) => a.cancel())
  slideAnims = []
  ghostEl?.remove()
  ghostEl = null
  armedDir = null
  const live = liveLayer()
  if (!live) return
  live.style.position = ''
  live.style.zIndex = ''
  live.style.willChange = ''
  live.style.boxShadow = ''
  live.style.background = ''
}

// The scroll container React owns: the page being left before the commit, the page arriving after it.
function liveLayer(): HTMLElement | null {
  const host = document.querySelector<HTMLElement>('.menu-page-transition')
  return (host?.firstElementChild as HTMLElement | null) ?? null
}

// Runs `fn` once the slide is off the screen (immediately if none is in flight). A page that focuses an
// input on arrival needs this: focusing while the layer is still parked off-screen right makes the
// browser scroll to reveal it and, on iOS, raises the keyboard, which resizes the viewport mid-slide.
export function afterMenuSlide(fn: () => void): () => void {
  let cancelled = false
  const go = () => {
    if (!cancelled) fn()
  }
  if (slideAnims.length) slideAnims[0].finished.then(go, go) // cancelled rejects, still means it's over
  else if (armedDir) window.setTimeout(go, perfSlideMs() + 80) // armed, not yet playing
  else go()
  return () => {
    cancelled = true
  }
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
  // Sized to the live layer's CLIENT box, not `inset:0`: it scrolls, so on any platform with classic
  // scrollbars its content box is 6px narrower than its border box, and a clone that reclaims the gutter
  // relays out 6px wider and re-centres everything the instant it appears.
  clone.style.cssText =
    `position:absolute;left:0;top:0;width:${live.clientWidth}px;height:${live.clientHeight}px;` +
    'z-index:3;overflow:hidden;pointer-events:none;background:#000;opacity:0.01;will-change:transform,opacity'
  // Blanked, and sized from what they measure right now. A cloned <img> restarts its load from scratch
  // on iOS: measured on device, all 35 start at naturalWidth 0 and 29 are STILL loading 40ms later,
  // when the route commits and this becomes the visible layer. That is the image-less flash, and the
  // missing intrinsic sizes shorten the page by 81px on top of it. The commit below swaps in the real
  // outgoing DOM, whose images are already loaded, so these only ever hold the shape.
  const liveImgs = live.querySelectorAll('img') // deep clone, so the two lists line up by index
  clone.querySelectorAll('img').forEach((img, i) => {
    const from = liveImgs[i]
    img.style.width = `${from.offsetWidth}px`
    img.style.height = `${from.offsetHeight}px`
    img.removeAttribute('src')
    img.removeAttribute('srcset')
  })
  // Opaque, so the ghost stays hidden underneath and can't show through the incoming page while its
  // content is still resolving.
  live.style.background = '#000'
  host.appendChild(clone)
  // overflow:hidden still scrolls programmatically, so a sticky header lands exactly where it was.
  const savedScroll = live.scrollTop
  clone.scrollTop = savedScroll
  // Recorded here, not from the scroll handler, because this is the last moment the offset and the path
  // are known to belong together: the swap below clamps the shared container against the new page and
  // fires a scroll event that React still attributes to the page being left.
  scrollMemory.set(window.location.pathname, savedScroll)
  ghostEl = clone
  armedDir = direction
  // React hands us the new page late: the drawer's pathname effect fired 41ms after the DOM actually
  // swapped, and the incoming page painted at rest in that gap, so the slide looked like it ran twice.
  // This fires in the same task as the swap, before that frame reaches the screen. The path is already
  // updated by then, so it also tells a real nav from a tap that went nowhere.
  const from = window.location.pathname
  commitWatch = new MutationObserver((records) => {
    if (window.location.pathname === from) return
    if (!records.some((r) => r.addedNodes.length)) return
    // React just handed back the outgoing page, detached but intact: same elements, same loaded
    // images, nothing to fetch or decode. Adopting it is the whole reason the ghost stopped flashing.
    // Its fiber is gone by now, so React never touches it again.
    const real = records
      .flatMap((r) => [...r.removedNodes])
      .find((n): n is HTMLElement => n instanceof HTMLElement)
    if (real) {
      clone.replaceChildren(real)
      clone.scrollTop = savedScroll
    }
    // The container is shared across routes, so without this the new page opens at the old page's
    // offset (clamped to its own height). Done here, before the frame paints, so there is no jump.
    live.scrollTop = scrollMemory.get(window.location.pathname) ?? 0
    runMenuSlide(live)
  })
  commitWatch.observe(live, { childList: true })
  ghostTimer = window.setTimeout(dropGhost, perfSlideMs() + 600) // nav blocked: never strand a copy
}

// Runs the instant the new page lands in the DOM, with the drawer's layout effect as the backstop.
// Idempotent: whichever gets there first disarms the other.
function runMenuSlide(incoming: HTMLElement): void {
  const dir = armedDir
  const ghost = ghostEl
  armedDir = null
  commitWatch?.disconnect()
  commitWatch = null
  if (!dir) return
  if (slideReduced || !ghost || typeof incoming.animate !== 'function') {
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
  incoming.style.zIndex = '2'
  incoming.style.willChange = 'transform, opacity'
  // Warm by now, so this is a compositor reorder and an alpha change, not a first paint. The opacity
  // has to go back to the stylesheet's, or the keyframes that don't name one inherit the 1%.
  ghost.style.opacity = ''
  ghost.style.zIndex = dir === 'back' ? '3' : '1'
  // The shadow rides whichever layer owns the moving edge, so it paints into that layer once.
  if (dir === 'forward') incoming.style.boxShadow = EDGE_SHADOW
  else ghost.style.boxShadow = EDGE_SHADOW

  // Both fill backwards, so the opening pose applies the moment they're created. Without it the
  // incoming page gets one frame at rest, on top, before the slide takes over.
  const opening = { ...opts, fill: 'both' as const }
  const into = incoming.animate(dir === 'forward' ? [offRight, rest] : [recede, rest], opening)
  const out = ghost.animate(dir === 'forward' ? [rest, recede] : [rest, offRight], opening)
  slideAnims = [into, out]

  // Held at frame zero until the pipeline can actually keep up. An animation is driven by the clock, not
  // by frames, so one long frame does not slow it down, it skips it forward: committing the new page
  // costs 60-70ms on device, and this easing is front-loaded enough to turn that into half the distance
  // before anything reaches the screen. So wait for a normal-length frame, then start. Until then both
  // sit in their opening pose, which is just the old page, unmoved.
  into.pause()
  out.pause()
  let started = false
  let prev = 0
  const heldAt = performance.now()
  const start = () => {
    if (started || ghostEl !== ghost) return
    started = true
    window.clearTimeout(startTimer)
    into.play()
    out.play()
  }
  const probe = (t: number) => {
    if (started || ghostEl !== ghost) return
    if (prev && (t - prev <= SETTLED_FRAME_MS || t - heldAt >= MAX_HOLD_MS)) return start()
    prev = t
    requestAnimationFrame(probe)
  }
  requestAnimationFrame(probe)
  const startTimer = window.setTimeout(start, 400) // rAF is throttled while hidden; never hold forever

  const clear = () => {
    if (ghostEl !== ghost) return // a newer nav already owns the layers
    dropGhost() // cancels both: the end pose is the natural one, so this is not a visual change
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
  // The slide engine starts before React knows about the nav, so it reads this instead of the hook.
  useEffect(() => {
    slideReduced = reduced
  }, [reduced])

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

  // The scroll container is deliberately NOT keyed on the route: resolvedLocation only lands after the
  // nav settles, so a key there mounted every page twice (once when the Outlet swapped, again when the
  // key caught up). armMenuSlide owns the offsets (scrollMemory above), this just starts them clean.
  useEffect(() => {
    scrollMemory.clear()
  }, [])

  // Bottom fade: hints there's content clipped below the fold, gone once fully scrolled. Styled straight on the node, no per-scroll re-render.
  const fadeRef = useRef<HTMLDivElement>(null)
  const updateFade = useCallback(() => {
    const el = scrollRef.current
    const fade = fadeRef.current
    if (!el || !fade) return
    fade.style.opacity = el.scrollHeight - el.scrollTop - el.clientHeight > 24 ? '1' : '0'
  }, [])

  // Fires once per nav, on resolvedLocation, which lands well after the Outlet has swapped, so the slide
  // does NOT wait for this (armMenuSlide's observer beats it by ~40ms); this is its backstop. Everything
  // that forces layout (scrollHeight, a ResizeObserver) is deferred a frame: by then the slide is already
  // running and it costs nothing visible. The fade is a hint, a frame late is invisible.
  useLayoutEffect(() => {
    const scrollElement = scrollRef.current
    if (!scrollElement) return
    // Unconditional: the container is shared, so "no stored offset" means go to the top, not stay put.
    // The swap already did this; this is the backstop for a nav that never armed, like the browser's
    // own back button.
    scrollElement.scrollTop = scrollMemory.get(pathname) ?? 0
    runMenuSlide(scrollElement)
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
  }, [pathname, updateFade])

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

        {/* Hosts both layers of a menu page slide (see armMenuSlide). `isolate` keeps the parked ghost's negative z-index scoped here instead of dropping it behind the drawer. */}
        <div className="menu-page-transition relative isolate min-h-0 flex-1 overflow-hidden bg-black">
          <div
            ref={scrollRef}
            onScroll={(e) => {
              // Not while a slide owns the container: the swap clamps it against the new page and the
              // resulting scroll event still reads as the old path, which would wipe what you left.
              if (!armedDir && !ghostEl) scrollMemory.set(pathname, e.currentTarget.scrollTop)
              updateFade()
            }}
            className="h-full overflow-y-auto overscroll-contain"
          >
            <MenuDrawerContext.Provider value={{ closeTo }}>
              {children}
            </MenuDrawerContext.Provider>
          </div>
          {/* Belongs to the drawer, not to a page, so it rides over both layers of a slide (hence z-10,
              above the two the slide assigns) instead of being torn down and popped back in. */}
          <div
            ref={fadeRef}
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-16 bg-gradient-to-t from-black to-transparent opacity-0 transition-opacity duration-300"
          />
        </div>
      </div>

      {/* Outside the named surface on purpose, so it never gets snapshotted into a page transition. */}
      <PerfDebug />
    </div>
  )
}
