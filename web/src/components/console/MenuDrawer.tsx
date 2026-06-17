// The menu lives in a near-fullscreen bottom drawer that slides up over the device. While it is
// open the console sits behind it, dimmed and blurred, so the drawer is the whole interface. It is
// route-driven (mounted whenever a /menu route matches), so the menu sub-screens render through the
// child Outlet. Closing slides it back down, then routes home to /games.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { motion } from 'motion/react'
import type { ReactNode } from 'react'
import { haptic } from '@/lib/haptics'
import { useReducedMotion } from '@/hooks/useReducedMotion'

const EXPO = [0.16, 1, 0.3, 1] as const

export function MenuDrawer({ children }: { children: ReactNode }) {
  const router = useRouter()
  const reduced = useReducedMotion()
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)

  const close = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    haptic('selection')
    setClosing(true)
    window.setTimeout(() => router.navigate({ to: '/games' }), reduced ? 0 : 280)
  }, [router, reduced])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  return (
    <motion.div
      className="absolute inset-0 z-50"
      initial={{ opacity: 0 }}
      animate={{ opacity: closing ? 0 : 1 }}
      transition={{ duration: reduced ? 0 : 0.26 }}
    >
      {/* The console behind, dimmed and blurred. Tap to close. */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-md"
        onClick={close}
        aria-hidden
      />

      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        className="absolute inset-x-0 bottom-0 top-[10%] flex flex-col overflow-hidden rounded-t-[28px] border-x border-t border-white/10 bg-black shadow-[0_-24px_64px_-24px_rgba(0,0,0,0.95)]"
        initial={{ y: reduced ? 0 : '100%' }}
        animate={{ y: closing ? '100%' : 0 }}
        transition={{ duration: reduced ? 0 : 0.42, ease: EXPO }}
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

        {/* data-lenis-prevent: opt this scroller out of the global Lenis smooth-wheel, which
            otherwise eats the wheel/touch events and leaves only the scrollbar draggable. */}
        <div data-lenis-prevent className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {children}
        </div>
      </motion.div>
    </motion.div>
  )
}
