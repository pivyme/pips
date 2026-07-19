// The first-run console tour: a passive, TE-etched spotlight that walks a new player through the four
// things that matter (the display, PLAY, the play-amount dial, the Menu), then opens up for a "time to
// play" send-off. It dims the whole device and punches a bright hole over each real 3D control, reading
// the live rects ConsoleCanvas projects onto invisible DOM anchors (data-tour-anchor). The light travels
// control to control; each beat is one mono label, one bold amber line, one quiet line. Tap anywhere or
// NEXT to advance, SKIP to bail. Auto-runs once right after onboarding, and is replayable from the Menu.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { haptic } from '@/lib/haptics'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { cnm } from '@/utils/style'

type AnchorName = 'screen' | 'play' | 'amount' | 'knob' | 'menu'

interface Step {
  anchor: AnchorName | null // null = the finale (no spotlight, the device opens up)
  tag: string // mono micro-label
  title: string // the bold amber line
  body: string // one quiet line
  pad: number // spotlight inset around the anchor rect
  radius: number // spotlight corner radius (big = pill for round buttons)
  growBottom?: number // extra bottom inset, as a fraction of the anchor height (to cover a label under it)
}

const STEPS: Step[] = [
  {
    anchor: 'screen',
    tag: 'The screen',
    title: 'Everything happens here',
    body: 'Live price, your play, your result. All on this screen.',
    pad: 6,
    radius: 24,
  },
  {
    anchor: 'play',
    tag: 'Main button',
    title: 'This fires your play',
    body: 'The big one. Tap it to play.',
    pad: 14,
    radius: 26,
  },
  {
    anchor: 'amount',
    tag: 'Play amount',
    title: 'Set your stake',
    body: 'Roll this to size how much each play costs.',
    pad: 12,
    radius: 18,
  },
  {
    anchor: 'knob',
    tag: 'The dial',
    title: 'Your game control',
    body: 'Leverage, target, zone. It changes per game.',
    pad: 12,
    radius: 20,
  },
  {
    anchor: 'menu',
    tag: 'The menu',
    title: 'Everything else is here',
    body: 'Stats, history, cash out, customize.',
    pad: 14,
    radius: 20,
    growBottom: 1.6, // reach down over the MENU label under the button
  },
  {
    anchor: null,
    tag: "You're set",
    title: 'Time to play',
    body: 'Pick a game, hit play, see what you get.',
    pad: 0,
    radius: 0,
  },
]

const SEEN_KEY = 'pips.tour.seen.v1'
const EASE = [0.16, 1, 0.3, 1] as const

function seen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return false
  }
}
function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {
    // storage blocked: the tour just isn't remembered, no worse than a replay.
  }
}

interface TourCtx {
  start: (opts?: { force?: boolean; delayMs?: number }) => void
}
const Ctx = createContext<TourCtx | null>(null)

export function useTour(): TourCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useTour used outside TourProvider')
  return ctx
}

export function TourProvider({
  firstRunReady = false,
  children,
}: {
  firstRunReady?: boolean
  children: ReactNode
}) {
  const [active, setActive] = useState(false)
  const timer = useRef<number | null>(null)

  const start = useCallback((opts?: { force?: boolean; delayMs?: number }) => {
    if (!opts?.force && seen()) return
    if (timer.current) window.clearTimeout(timer.current)
    if (opts?.delayMs) timer.current = window.setTimeout(() => setActive(true), opts.delayMs)
    else setActive(true)
  }, [])

  const close = useCallback(() => {
    markSeen()
    setActive(false)
  }, [])

  // Auto first-run: once the home screen is live after onboarding, open the tour a beat later so it
  // reads as "welcome, now here is your device", not a hard cut. The seen flag keeps it to once.
  useEffect(() => {
    if (!firstRunReady || seen()) return
    start({ delayMs: 750 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstRunReady])

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
    },
    [],
  )

  const value = useMemo(() => ({ start }), [start])
  return (
    <Ctx.Provider value={value}>
      {children}
      <AnimatePresence>{active && <TourOverlay onClose={close} />}</AnimatePresence>
    </Ctx.Provider>
  )
}

// Live-reads the anchor rect and keeps re-reading for a short window after each step so a still-settling
// device lands the spotlight right. Never nulled between steps, so the light springs from old to new.
function useLiveRect(name: AnchorName | null, dep: number): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null)
  useEffect(() => {
    if (!name) return
    let raf = 0
    let startT = 0
    const measure = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour-anchor="${name}"]`)
      if (el) {
        const r = el.getBoundingClientRect()
        if (r.width > 1 && r.height > 1) setRect(r)
      }
    }
    const loop = (t: number) => {
      if (!startT) startT = t
      measure()
      if (t - startT < 700) raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    const on = () => measure()
    window.addEventListener('resize', on)
    window.addEventListener('scroll', on, true)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', on)
      window.removeEventListener('scroll', on, true)
    }
  }, [name, dep])
  return rect
}

function TourOverlay({ onClose }: { onClose: () => void }) {
  const reduced = useReducedMotion()
  const [i, setI] = useState(0)
  const step = STEPS[i]
  const last = i === STEPS.length - 1
  const finale = step.anchor === null

  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])

  const rect = useLiveRect(step.anchor, i)

  const skip = useCallback(() => {
    haptic('selection')
    markSeen()
    onClose()
  }, [onClose])

  const next = useCallback(() => {
    if (last) {
      haptic('success')
      onClose()
      return
    }
    haptic('selection')
    setI((n) => Math.min(n + 1, STEPS.length - 1))
  }, [last, onClose])

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') skip()
      else if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        next()
      } else if (e.key === 'ArrowLeft') setI((n) => Math.max(n - 1, 0))
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [next, skip])

  // Spotlight box. Finale opens the hole to the whole device (dim lifts). Otherwise it hugs the anchor,
  // falling back to a small centered box until the first measure lands.
  const spot = finale
    ? { x: -40, y: -40, w: vp.w + 80, h: vp.h + 80 }
    : rect
      ? {
          x: rect.left - step.pad,
          y: rect.top - step.pad,
          w: rect.width + step.pad * 2,
          h: rect.height + step.pad * 2 + (step.growBottom ?? 0) * rect.height,
        }
      : { x: vp.w / 2 - 60, y: vp.h / 2 - 60, w: 120, h: 120 }
  const rx = Math.min(step.radius, spot.w / 2, spot.h / 2)

  const travel = reduced ? { duration: 0 } : { duration: 0.55, ease: EASE }
  // Caption hugs the spotlight on whichever side has more clearance, so it stays close to the highlighted
  // control instead of leaping to a far fixed band. Screen sits high so it lands below; controls sit low
  // so it lands just above them.
  const placeBelow = vp.h - (spot.y + spot.h) >= spot.y

  return (
    <motion.div
      className="fixed inset-0 z-[130]"
      style={{ cursor: 'pointer' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduced ? 0.14 : 0.28, ease: EASE }}
      onPointerDown={next}
    >
      <svg width={vp.w} height={vp.h} className="pointer-events-none absolute inset-0">
        <defs>
          <mask id="pips-tour-spot">
            <rect x={0} y={0} width={vp.w} height={vp.h} fill="white" />
            <motion.rect
              fill="black"
              rx={rx}
              ry={rx}
              initial={false}
              animate={{ x: spot.x, y: spot.y, width: spot.w, height: spot.h }}
              transition={travel}
            />
          </mask>
        </defs>
        <rect x={0} y={0} width={vp.w} height={vp.h} fill="rgba(0,0,0,0.78)" mask="url(#pips-tour-spot)" />
        {/* Amber ring hugging the hole, breathing so the eye lands on the live control. Hidden on the finale. */}
        <motion.rect
          fill="none"
          stroke="#FFC016"
          strokeWidth={1.5}
          rx={rx}
          ry={rx}
          initial={false}
          animate={{
            x: spot.x,
            y: spot.y,
            width: spot.w,
            height: spot.h,
            opacity: finale || !rect ? 0 : 1,
            strokeOpacity: reduced ? 1 : [1, 0.35, 1],
          }}
          transition={{
            default: travel,
            strokeOpacity: reduced
              ? { duration: 0 }
              : { duration: 1.7, repeat: Infinity, ease: 'easeInOut' },
          }}
        />
      </svg>

      <Caption
        step={step}
        index={i}
        total={STEPS.length}
        placeBelow={placeBelow}
        spot={spot}
        finale={finale}
        vp={vp}
        reduced={reduced}
        last={last}
        onNext={next}
        onSkip={skip}
      />
    </motion.div>
  )
}

function Caption({
  step,
  index,
  total,
  placeBelow,
  spot,
  finale,
  vp,
  reduced,
  last,
  onNext,
  onSkip,
}: {
  step: Step
  index: number
  total: number
  placeBelow: boolean
  spot: { x: number; y: number; w: number; h: number }
  finale: boolean
  vp: { w: number; h: number }
  reduced: boolean
  last: boolean
  onNext: () => void
  onSkip: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [h, setH] = useState(0)
  useLayoutEffect(() => {
    if (ref.current) setH(ref.current.offsetHeight)
  }, [index, vp.w, vp.h])

  const W = Math.min(360, vp.w - 24)
  const left = (vp.w - W) / 2
  const band = Math.max(20, vp.h * 0.06)
  const gap = 18
  // Finale sits centered-low over the fully-revealed device. Otherwise the card sits just off the
  // spotlight (below it when it's high, above it when it's low), clamped to stay on screen.
  const top = finale
    ? Math.min(vp.h * 0.6, vp.h - h - band)
    : Math.max(
        band,
        Math.min(placeBelow ? spot.y + spot.h + gap : spot.y - h - gap, vp.h - h - band),
      )

  const slot = (n: number) => String(n).padStart(2, '0')

  return (
    <motion.div
      ref={ref}
      className="pointer-events-auto absolute"
      style={{ left, top, width: W }}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: placeBelow || finale ? 10 : -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduced ? 0.15 : 0.36, ease: EASE, delay: reduced ? 0 : 0.06 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* TE panel: flat true-black, hairline rules, one amber accent. No card, no blur. */}
      <div className="relative bg-black shadow-[0_16px_50px_rgba(0,0,0,0.55)] ring-1 ring-white/[0.14]">
        <div className="h-px w-full bg-white/[0.16]" />
        <div className={cnm('flex items-center px-4 pt-3', finale ? 'justify-center' : 'justify-between')}>
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-text-3">
            {step.tag}
          </span>
          {!finale && (
            <span className="tnum font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-text-3">
              {slot(index + 1)} / {slot(total)}
            </span>
          )}
        </div>

        <div
          className={cnm(
            'flex items-stretch gap-3 px-4 pb-1 pt-2.5',
            finale && 'flex-col items-center gap-0 text-center',
          )}
        >
          {!finale && <span className="w-[3px] shrink-0 self-stretch bg-brand-500" />}
          <AnimatePresence mode="wait">
            <motion.div
              key={index}
              className="min-w-0"
              initial={reduced ? { opacity: 0 } : { opacity: 0, filter: 'blur(4px)' }}
              animate={{ opacity: 1, filter: 'blur(0px)' }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, filter: 'blur(4px)' }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <div className="font-sans text-[19px] font-extrabold uppercase leading-[1.1] tracking-tight text-brand-500">
                {step.title}
              </div>
              <div className="mt-1 text-[13px] font-medium leading-snug text-text-2">{step.body}</div>
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="mt-2.5 h-px w-full bg-white/[0.16]" />
        <div className="flex items-center justify-between px-4 py-2.5">
          <button
            type="button"
            onPointerDown={(e) => {
              e.stopPropagation()
              onSkip()
            }}
            className={cnm(
              'font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-text-3 transition active:scale-95',
              finale && 'invisible', // no skip on the send-off, just Let's go
            )}
          >
            Skip
          </button>
          <div className="flex items-center gap-3">
            {!finale && (
              <div className="flex items-center gap-1.5">
                {Array.from({ length: total }).map((_, k) => (
                  <span key={k} className={cnm('h-1 w-1', k === index ? 'bg-brand-500' : 'bg-white/25')} />
                ))}
              </div>
            )}
            <button
              type="button"
              onPointerDown={(e) => {
                e.stopPropagation()
                onNext()
              }}
              className="flex items-center gap-1 font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-brand-500 transition active:scale-95"
            >
              {last ? "Let's go" : 'Next'}
              <span aria-hidden>▸</span>
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
