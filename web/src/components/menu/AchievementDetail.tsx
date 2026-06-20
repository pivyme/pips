// Tap an achievement (the menu rail or the full grid) and its sticker flies to the center of the
// screen and blooms big behind a blurred backdrop, the same warm beat as earning one, just on
// demand. One app-level provider holds the selection and renders the overlay at the viewport root
// (so the flown sticker lines up with the card's real on-screen rect), cards call open() with their
// sticker element. Tap anywhere to send it back.
import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, Lock } from 'lucide-react'
import type { DisplayAchievement } from '@/lib/achievements'
import { achievementImage } from '@/lib/achievements'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { haptic } from '@/lib/haptics'
import { cnm } from '@/utils/style'

type Selected = { a: DisplayAchievement; rect: DOMRect }

const Ctx = createContext<{ open: (a: DisplayAchievement, sticker: HTMLElement) => void } | null>(null)

export function useAchievementDetail() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAchievementDetail must be used within AchievementDetailProvider')
  return ctx
}

export function AchievementDetailProvider({ children }: { children: ReactNode }) {
  const [sel, setSel] = useState<Selected | null>(null)
  const open = useCallback((a: DisplayAchievement, sticker: HTMLElement) => {
    haptic('selection')
    setSel({ a, rect: sticker.getBoundingClientRect() })
  }, [])
  const close = useCallback(() => setSel(null), [])

  return (
    <Ctx.Provider value={useMemo(() => ({ open }), [open])}>
      {children}
      <AnimatePresence>{sel && <Detail key={sel.a.slug} sel={sel} onClose={close} />}</AnimatePresence>
    </Ctx.Provider>
  )
}

const pctOf = (a: DisplayAchievement): number =>
  a.progress && a.progress.target > 0 ? Math.min(1, a.progress.current / a.progress.target) : 0

function Detail({ sel, onClose }: { sel: Selected; onClose: () => void }) {
  const reduced = useReducedMotion()
  const { a, rect } = sel

  // The sticker renders at its final centered box; we FLIP it with a transform so the morph is pure
  // GPU and stays dead-center. Snapshot the viewport once, the overlay is transient so chasing a
  // mid-view resize isn't worth it.
  const layout = useMemo(() => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    // Big and bold. Scales with the smaller screen axis, capped so desktop stays sane.
    const size = Math.round(Math.min(vw * 0.72, vh * 0.42, 340))
    const left = (vw - size) / 2
    // Center the whole sticker + copy stack in the viewport (the copy block runs ~150px tall).
    const gap = 30
    const copyH = 150
    const top = Math.max((vh - (size + gap + copyH)) / 2, vh * 0.06)
    const cx = left + size / 2
    const cy = top + size / 2
    return {
      size,
      left,
      top,
      bloom: size * 2.4,
      bloomLeft: cx - size * 1.2,
      bloomTop: cy - size * 1.2,
      copyTop: top + size + gap,
      // Map the centered box back onto the card's on-screen rect for the start of the flight.
      fromX: rect.left + rect.width / 2 - cx,
      fromY: rect.top + rect.height / 2 - cy,
      fromScale: rect.width / size,
    }
  }, [rect])

  const stickerFilter = a.unlocked
    ? 'drop-shadow(0 18px 30px rgba(0,0,0,0.5)) drop-shadow(0 0 26px rgba(255,192,22,0.3))'
    : 'brightness(0) contrast(2) drop-shadow(0 1px 0 rgba(255,255,255,0.04))'

  // One calm easing for the whole morph. A tween (not a spring) keeps it smooth, no bounce, and is
  // guaranteed to complete, so AnimatePresence always tears the overlay down (an infinite-repeat
  // child here would hang the exit and trap every click behind a transparent layer).
  const flight = { duration: reduced ? 0.2 : 0.5, ease: [0.22, 1, 0.36, 1] as const }

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={a.name}
      onClick={onClose}
      className="fixed inset-0 z-[110] bg-black/70 backdrop-blur-xl"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduced ? 0.18 : 0.4, ease: [0.22, 1, 0.36, 1] }}
    >
      {a.unlocked && (
        <motion.div
          aria-hidden
          className="pointer-events-none fixed rounded-full"
          style={{
            left: layout.bloomLeft,
            top: layout.bloomTop,
            width: layout.bloom,
            height: layout.bloom,
            background: 'radial-gradient(circle, rgba(255,192,22,0.2) 0%, rgba(255,192,22,0) 68%)',
          }}
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        />
      )}

      <motion.img
        src={achievementImage(a.slug)}
        alt=""
        draggable={false}
        className="pointer-events-none fixed object-contain"
        style={{ left: layout.left, top: layout.top, width: layout.size, height: layout.size, filter: stickerFilter }}
        initial={{ x: layout.fromX, y: layout.fromY, scale: layout.fromScale }}
        animate={{ x: 0, y: 0, scale: 1 }}
        exit={{ x: layout.fromX, y: layout.fromY, scale: layout.fromScale }}
        transition={flight}
      />

      <motion.div
        className="pointer-events-none fixed inset-x-0 flex flex-col items-center px-8 text-center"
        style={{ top: layout.copyTop }}
        initial={reduced ? false : { opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 10 }}
        transition={{ delay: reduced ? 0 : 0.12, duration: 0.32, ease: 'easeOut' }}
      >
        <h2 className="text-[30px] font-black leading-tight text-white">{a.name}</h2>
        <p className="mt-2 max-w-[320px] text-[15px] font-semibold leading-snug text-white/65">
          {a.description}
        </p>
        <Status a={a} reduced={reduced} />
      </motion.div>

      <span className="pointer-events-none fixed inset-x-0 bottom-10 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-white/35">
        Tap to close
      </span>
    </motion.div>
  )
}

function Status({ a, reduced }: { a: DisplayAchievement; reduced: boolean }) {
  if (a.unlocked) {
    const date = a.unlockedAt
      ? new Date(a.unlockedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : null
    return (
      <div className="mt-6 inline-flex items-center gap-2 rounded-full bg-brand-500/15 px-4 py-2 text-[12px] font-extrabold uppercase tracking-[0.16em] text-brand-400">
        <Check className="h-3.5 w-3.5" strokeWidth={3} />
        Unlocked{date ? ` · ${date}` : ''}
      </div>
    )
  }

  const p = pctOf(a)
  if (a.progress && a.progress.target > 0) {
    return (
      <div className="mt-6 w-full max-w-[280px]">
        <div className="flex items-center justify-between text-[12px] font-bold uppercase tracking-[0.12em]">
          <span className="text-text-3">Locked</span>
          <span className="tnum text-text-2">
            {a.progress.current} / {a.progress.target}
          </span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/10">
          <motion.div
            className="h-full rounded-full bg-brand-500"
            initial={reduced ? false : { width: 0 }}
            animate={{ width: `${Math.round(p * 100)}%` }}
            transition={{ delay: reduced ? 0 : 0.28, duration: 0.5, ease: 'easeOut' }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="mt-6 inline-flex items-center gap-2 rounded-full bg-white/[0.06] px-4 py-2 text-[12px] font-extrabold uppercase tracking-[0.16em] text-text-3">
      <Lock className="h-3.5 w-3.5" strokeWidth={2.6} />
      Locked
    </div>
  )
}

// Shared by the rail + grid cards: pull the sticker img out of the clicked card and open the detail.
export function openFromCard(
  open: (a: DisplayAchievement, sticker: HTMLElement) => void,
  a: DisplayAchievement,
  e: { currentTarget: HTMLElement },
) {
  const img = e.currentTarget.querySelector('img')
  if (img) open(a, img)
}

export const cardPressClass = cnm('transition-transform active:scale-[0.97]')
