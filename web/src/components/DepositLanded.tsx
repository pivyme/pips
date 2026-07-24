// The "X DUSDC deposited" moment: an app-level overlay that blooms when funds land at the user's address
// (a same-chain receive, a recovered token, or a bridge landing), fired by the deposit watch through the
// deposit bus. Deliberately DISTINCT from ChipGrantCelebration (a starter gift, amber/coins) and
// AchievementCelebration (a badge, bright): this one reads as money arriving, a cooler green vault treatment
// with a distinct warm SFX. `active` keeps it to the app proper, off the door + onboarding. No auto-close:
// it holds until the player taps "Let's play" (which drops them into the games hub) or dismisses.

import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowDownToLine, ExternalLink, Play } from 'lucide-react'
import type { WalletTxDTO } from '@/lib/api'
import { subscribeDepositLanded } from '@/lib/depositBus'
import { depositLanded as depositLandedSound } from '@/lib/sound'
import { haptic } from '@/lib/haptics'
import { useReducedMotion } from '@/hooks/useReducedMotion'

const CHAIN_LABEL: Record<string, string> = {
  sui: 'Sui',
  base: 'Base',
  arbitrum: 'Arbitrum',
  ethereum: 'Ethereum',
  solana: 'Solana',
}

export function DepositLanded({ active = true }: { active?: boolean }) {
  const reduced = useReducedMotion()
  const navigate = useNavigate()
  const [row, setRow] = useState<WalletTxDTO | null>(null)
  const soundedFor = useRef<string | null>(null)

  // Stash any landed deposit; it becomes visible (with sound) once we're in the app.
  useEffect(() => subscribeDepositLanded((r) => setRow(r)), [])

  const visible = row != null && active

  // Sound + haptic fire once when the popup actually shows. No auto-dismiss: the player closes it.
  useEffect(() => {
    if (!visible || !row) return
    const key = row.digest || row.id
    if (soundedFor.current === key) return
    soundedFor.current = key
    try {
      depositLandedSound()
      haptic('success')
    } catch {
      // a sound/haptic hiccup must never break the celebration
    }
  }, [visible, row])

  useEffect(() => {
    if (row == null) soundedFor.current = null
  }, [row])

  const close = () => setRow(null)
  const play = () => {
    setRow(null)
    void navigate({ to: '/games' })
  }

  const symbol = row?.symbol ?? 'DUSDC'
  const bridged = row?.kind === 'bridge'
  const chain = row ? CHAIN_LABEL[row.chain] ?? row.chain : ''

  return (
    <AnimatePresence>
      {visible && row && (
        <motion.div
          key="deposit-landed"
          role="status"
          aria-live="polite"
          onClick={close}
          className="fixed inset-0 z-[130] flex items-center justify-center bg-black/70 px-6 backdrop-blur-2xl"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0.18 : 0.42, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* Cool green bloom behind the vault, breathing slowly. */}
          {!reduced && (
            <motion.div
              aria-hidden
              className="pointer-events-none absolute h-[64vmin] w-[64vmin] rounded-full"
              style={{ background: 'radial-gradient(circle, rgba(52,211,153,0.24) 0%, rgba(52,211,153,0) 70%)' }}
              animate={{ scale: [1, 1.12, 1], opacity: [0.5, 0.8, 0.5] }}
              transition={{ duration: 3.4, repeat: Infinity, ease: 'easeInOut' }}
            />
          )}

          <div
            className="relative flex w-full max-w-[440px] flex-col items-center gap-6 text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <motion.div
              className="flex h-[112px] w-[112px] items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300"
              style={{ filter: 'drop-shadow(0 12px 26px rgba(0,0,0,0.5)) drop-shadow(0 0 26px rgba(52,211,153,0.38))' }}
              initial={reduced ? false : { opacity: 0, scale: 0.3, y: -18 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={reduced ? { duration: 0.2 } : { type: 'spring', stiffness: 320, damping: 17, delay: 0.06 }}
            >
              <ArrowDownToLine size={54} strokeWidth={2.3} />
            </motion.div>

            <motion.h2
              className="text-[30px] font-extrabold leading-none tracking-tight text-white"
              initial={reduced ? false : { opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: reduced ? 0 : 0.14, duration: 0.4, ease: 'easeOut' }}
            >
              Funds landed
            </motion.h2>

            <motion.div
              className="flex items-baseline gap-2"
              initial={reduced ? false : { opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={reduced ? { duration: 0.2 } : { type: 'spring', stiffness: 300, damping: 18, delay: 0.2 }}
            >
              <span className="tnum text-[52px] font-black leading-none tracking-tight text-emerald-300">
                +{row.amount}
              </span>
              <span className="font-mono text-[16px] font-bold uppercase tracking-widest text-emerald-300/80">{symbol}</span>
            </motion.div>

            <motion.p
              className="max-w-[320px] text-[15px] font-medium leading-snug text-white/70"
              initial={reduced ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: reduced ? 0 : 0.32, duration: 0.4 }}
            >
              {bridged ? `Bridged from ${chain} and deposited to your account. Time to play.` : 'Deposited to your account. Time to play.'}
            </motion.p>

            <motion.div
              className="mt-1 flex w-full flex-col items-center gap-4"
              initial={reduced ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: reduced ? 0 : 0.42, duration: 0.4, ease: 'easeOut' }}
            >
              <button
                onClick={play}
                className="flex h-[54px] w-full max-w-[300px] items-center justify-center gap-2 rounded-2xl bg-emerald-400 text-[15px] font-extrabold uppercase tracking-wide text-black shadow-[0_10px_30px_rgba(52,211,153,0.35)] transition-transform active:scale-[0.98]"
              >
                <Play className="h-[18px] w-[18px] fill-black" strokeWidth={2.4} />
                Let's play
              </button>

              {row.explorerUrl && (
                <a
                  href={row.explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-white/45 transition hover:text-white/70"
                >
                  <ExternalLink className="h-3.5 w-3.5" strokeWidth={2.2} />
                  View on explorer
                </a>
              )}
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
