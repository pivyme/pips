// One app-level overlay for the "here's N DUSDC to play with" moment, plus the watcher that hands a broke
// player chips without them hunting for a faucet. Any grant path (fresh login, a restored session that lands
// on zero, or running dry mid-session) emits through lib/chipGrant; this blooms the popup + coin sound.
// `active` keeps it to the app proper, so it never fires over the landing door or the onboarding welcome; a
// grant emitted mid-onboarding is held and celebrated once the player lands on the home screen.

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Coins } from 'lucide-react'
import { useAuth } from '@/lib/auth'
import { betLadder } from '@/lib/sui/config'
import { subscribeChipGrant, useTopUp } from '@/lib/chipGrant'
import { chipsGranted as chipsGrantedSound } from '@/lib/sound'
import { haptic } from '@/lib/haptics'
import { useReducedMotion } from '@/hooks/useReducedMotion'

const AUTO_CLOSE_MS = 4600

// Whole-number grants read cleaner as "100"; keep a decimal only if the amount actually has one.
const fmtAmount = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2))

export function ChipGrantCelebration({ active = true }: { active?: boolean }) {
  const { status, user } = useAuth()
  const reduced = useReducedMotion()
  const topUp = useTopUp()
  const [amount, setAmount] = useState<number | null>(null)
  const soundedFor = useRef<number | null>(null)

  // Stash any granted amount; it becomes visible (with sound) once we're in the app.
  useEffect(() => subscribeChipGrant((amt) => setAmount(amt)), [])

  const visible = amount != null && active

  // Auto top-up: an authed player in the app sitting below the cheapest playable stake gets the starter grant
  // handed to them once per dry spell, so a fresh or migrated account lands on chips + the popup with nothing
  // to hunt for. Held off outside the app so it never fires over the door or onboarding.
  const armed = useRef(false)
  useEffect(() => {
    if (!active || status !== 'authed' || !user) {
      armed.current = false
      return
    }
    const balance = parseFloat(user.balance) || 0
    if (balance >= betLadder()[0]) {
      armed.current = false // has chips: re-arm for the next time they run dry
      return
    }
    if (armed.current) return
    armed.current = true
    void topUp({ fallbackToDeposit: false }) // silent on load: grant + celebrate, never yank to the deposit drawer
  }, [active, status, user, topUp])

  // Reset the sound guard once the popup closes, so the next grant (even the same amount) rings out again.
  useEffect(() => {
    if (amount == null) soundedFor.current = null
  }, [amount])

  // Sound + haptic + auto-dismiss fire when the popup actually shows (not at emit time, so a grant stashed
  // during onboarding rings out cleanly on the home screen, never over the welcome jingle). Once per showing,
  // guarded so a re-render or `active` toggle doesn't replay it.
  useEffect(() => {
    if (!visible || amount == null) return
    if (soundedFor.current !== amount) {
      soundedFor.current = amount
      try {
        chipsGrantedSound()
        haptic('success')
      } catch {
        // a sound/haptic hiccup on some exotic browser must never break the celebration
      }
    }
    const id = window.setTimeout(() => setAmount(null), AUTO_CLOSE_MS)
    return () => window.clearTimeout(id)
  }, [visible, amount])

  return (
    <AnimatePresence>
      {visible && amount != null && (
        <motion.div
          key="chip-grant"
          role="status"
          aria-live="polite"
          onClick={() => setAmount(null)}
          className="fixed inset-0 z-[130] flex items-center justify-center bg-black/70 px-6 backdrop-blur-2xl"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0.18 : 0.42, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* Warm amber bloom behind the coin, breathing slowly. */}
          {!reduced && (
            <motion.div
              aria-hidden
              className="pointer-events-none absolute h-[64vmin] w-[64vmin] rounded-full"
              style={{ background: 'radial-gradient(circle, rgba(255,179,0,0.26) 0%, rgba(255,179,0,0) 70%)' }}
              animate={{ scale: [1, 1.12, 1], opacity: [0.5, 0.8, 0.5] }}
              transition={{ duration: 3.4, repeat: Infinity, ease: 'easeInOut' }}
            />
          )}

          <div className="relative flex w-full max-w-[440px] flex-col items-center gap-6 text-center">
            <motion.div
              className="flex h-[112px] w-[112px] items-center justify-center rounded-full bg-amber-400/15 text-amber-300"
              style={{ filter: 'drop-shadow(0 12px 26px rgba(0,0,0,0.5)) drop-shadow(0 0 26px rgba(255,179,0,0.4))' }}
              initial={reduced ? false : { opacity: 0, scale: 0.3, y: 16, rotate: -10 }}
              animate={{ opacity: 1, scale: 1, y: 0, rotate: 0 }}
              transition={reduced ? { duration: 0.2 } : { type: 'spring', stiffness: 340, damping: 16, delay: 0.06 }}
            >
              <Coins size={58} strokeWidth={2.2} />
            </motion.div>

            <motion.h2
              className="text-[30px] font-extrabold leading-none tracking-tight text-white"
              initial={reduced ? false : { opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: reduced ? 0 : 0.14, duration: 0.4, ease: 'easeOut' }}
            >
              You&apos;re topped up!
            </motion.h2>

            <motion.div
              className="flex items-baseline gap-2"
              initial={reduced ? false : { opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={reduced ? { duration: 0.2 } : { type: 'spring', stiffness: 300, damping: 18, delay: 0.2 }}
            >
              <span className="text-[52px] font-black leading-none tracking-tight text-amber-300">
                +{fmtAmount(amount)}
              </span>
              <span className="font-mono text-[16px] font-bold uppercase tracking-widest text-amber-300/80">DUSDC</span>
            </motion.div>

            <motion.p
              className="max-w-[320px] text-[15px] font-medium leading-snug text-white/70"
              initial={reduced ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: reduced ? 0 : 0.32, duration: 0.4 }}
            >
              We sent you {fmtAmount(amount)} DUSDC to play with. Have fun, it&apos;s on us.
            </motion.p>

            <motion.span
              className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/40"
              initial={reduced ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: reduced ? 0 : 0.46, duration: 0.4 }}
            >
              Tap to dismiss
            </motion.span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
