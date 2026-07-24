// The money surfaces (Activity / Add funds / Send) as a centered pop-up modal over the menu, instead of
// drawer sub-pages. One app-level host renders the right body by view; the balance card + the chip-grant
// fallback drive it through the dependency-free bus. Closes on navigation (e.g. the deposit "Let's play"
// jump to /games) so it never lingers over another screen.

import { useEffect, useSyncExternalStore } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { AnimatePresence, motion } from 'motion/react'
import { X } from 'lucide-react'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { haptic } from '@/lib/haptics'
import {
  closeMoneyModal,
  getMoneyModalView,
  subscribeMoneyModal,
  type MoneyView,
} from '@/lib/moneyModalBus'
import { ActivityFeed } from '@/routes/_app/menu/transactions'
import { DepositContent } from '@/routes/_app/menu/deposit'
import { SendForm } from '@/routes/_app/menu/withdraw'

const TITLES: Record<MoneyView, string> = { activity: 'Activity', deposit: 'Add funds', send: 'Send' }

export function MoneyModalHost() {
  const view = useSyncExternalStore(subscribeMoneyModal, getMoneyModalView, () => null)
  const reduced = useReducedMotion()
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  // Close on navigation. Runs once on mount (view is null, a no-op) and on every route change after, so a
  // jump like the deposit "Let's play" -> /games tears the modal down instead of leaving it over the game.
  useEffect(() => {
    closeMoneyModal()
  }, [pathname])

  const close = () => {
    haptic('selection')
    closeMoneyModal()
  }

  return (
    <AnimatePresence>
      {view && (
        <motion.div
          key="money-modal"
          className="fixed inset-0 z-[120] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-xl" onClick={close} />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={TITLES[view]}
            className="relative flex max-h-[86vh] w-full max-w-[440px] flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#0c0c0c] shadow-[0_30px_90px_-20px_rgba(0,0,0,0.95)]"
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 14 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
            transition={reduced ? { duration: 0.18 } : { type: 'spring', stiffness: 360, damping: 30 }}
          >
            <div className="flex shrink-0 items-center justify-between gap-3 px-5 pb-3 pt-5">
              <h2 className="text-[22px] font-black leading-none text-white">{TITLES[view]}</h2>
              <button
                onClick={close}
                aria-label="Close"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.08] text-text-2 transition-transform active:scale-90"
              >
                <X className="h-5 w-5" strokeWidth={2.6} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-1">
              {view === 'activity' && <ActivityFeed />}
              {view === 'deposit' && <DepositContent />}
              {view === 'send' && <SendForm onClose={close} />}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
