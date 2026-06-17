// The menu lives in a near-fullscreen bottom drawer that slides up over the device. While it is
// open the console sits behind it, dimmed and blurred, so the drawer is the whole interface. It is
// route-driven (mounted whenever a /menu route matches), so the menu sub-screens render through the
// child Outlet. Closing slides it back down, then routes to `returnTo` (where the user came from).
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useRouter } from '@tanstack/react-router'
import { AnimatePresence, motion } from 'motion/react'
import type { ReactNode } from 'react'
import { haptic } from '@/lib/haptics'
import { useReducedMotion } from '@/hooks/useReducedMotion'

// Calm, weighty slide-up that just barely overshoots at the top, then settles. A ~0.87 damping
// ratio: enough to feel alive without the snappy bounce the stiffer spring had.
const OPEN_SPRING = {
  type: 'spring',
  stiffness: 240,
  damping: 27,
  mass: 1,
} as const
const CLOSE_TRANSITION = { duration: 0.24, ease: [0.32, 0, 0.67, 0] } as const
const PAGE_TRANSITION = {
  x: { duration: 0.42, ease: [0.32, 0.72, 0, 1] },
  scale: { duration: 0.42, ease: [0.32, 0.72, 0, 1] },
  opacity: { duration: 0.28, ease: [0.32, 0.72, 0, 1] },
  filter: { duration: 0.32, ease: [0.32, 0.72, 0, 1] },
} as const

type PageDirection = 1 | -1

const pageVariants = {
  enter: (direction: PageDirection) =>
    direction === 1
      ? { x: '100%', scale: 1, opacity: 1, filter: 'brightness(1)' }
      : { x: '-22%', scale: 0.985, opacity: 0.72, filter: 'brightness(0.72)' },
  center: { x: 0, scale: 1, opacity: 1, filter: 'brightness(1)' },
  exit: (direction: PageDirection) =>
    direction === 1
      ? { x: '-22%', scale: 0.985, opacity: 0.72, filter: 'brightness(0.72)' }
      : { x: '100%', scale: 1, opacity: 1, filter: 'brightness(1)' },
}

const menuDepth = (pathname: string): number =>
  pathname.replace(/\/+$/, '').split('/').filter(Boolean).length

export function MenuDrawer({
  children,
  returnTo = '/games',
}: {
  children: ReactNode
  returnTo?: string
}) {
  const router = useRouter()
  const pathname = useLocation({ select: (location) => location.pathname })
  const reduced = useReducedMotion()
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)
  const previousPath = usePrevious(pathname)
  const pageDirection: PageDirection =
    previousPath && menuDepth(pathname) < menuDepth(previousPath) ? -1 : 1

  const close = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    haptic('selection')
    setClosing(true)
    window.setTimeout(
      () => router.navigate({ to: returnTo }),
      reduced ? 0 : 240,
    )
  }, [router, reduced, returnTo])

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

      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        className="absolute inset-x-0 bottom-0 top-[10%] flex flex-col overflow-hidden rounded-t-[28px] border-x border-t border-white/10 bg-black shadow-[0_-24px_64px_-24px_rgba(0,0,0,0.95)]"
        initial={{ y: reduced ? 0 : '104%' }}
        animate={{ y: closing ? '104%' : 0 }}
        transition={
          reduced ? { duration: 0 } : closing ? CLOSE_TRANSITION : OPEN_SPRING
        }
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

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <AnimatePresence initial={false} custom={pageDirection} mode="sync">
            <motion.div
              key={pathname}
              custom={pageDirection}
              variants={reduced ? undefined : pageVariants}
              initial={reduced ? false : 'enter'}
              animate="center"
              exit={reduced ? undefined : 'exit'}
              transition={reduced ? { duration: 0 } : PAGE_TRANSITION}
              style={{ zIndex: pageDirection === 1 ? 2 : 1 }}
              data-lenis-prevent
              className="absolute inset-0 overflow-y-auto overscroll-contain bg-black shadow-[-18px_0_42px_rgba(0,0,0,0.72)] [backface-visibility:hidden] [transform-origin:center_left] [will-change:transform,opacity,filter]"
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  )
}

function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined)
  useEffect(() => {
    ref.current = value
  }, [value])
  return ref.current
}
