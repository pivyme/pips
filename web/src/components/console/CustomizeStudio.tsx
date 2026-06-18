// The Customize studio. Launched from the menu, it drops the device into a black-and-white workshop
// where it floats as a hero shot, screen off, free to spin front-to-back. A rail of skeuomorphic
// preset cards reskins it live; the selected card tilts up like it's been pulled from the deck.
// X discards, Done saves the skin, Share is a teaser for now.
import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { Share2, X } from 'lucide-react'
import toast from 'react-hot-toast'
import ConsoleCanvas from './ConsoleCanvas'
import { THEMES, THEME_BY_ID } from './themes'
import type { ConsoleTheme } from './themes'
import { haptic } from '@/lib/haptics'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { cnm } from '@/utils/style'

export function CustomizeStudio({
  initialThemeId,
  onDone,
  onCancel,
}: {
  initialThemeId: string
  onDone: (themeId: string) => void
  onCancel: () => void
}) {
  const reduced = useReducedMotion()
  const [selectedId, setSelectedId] = useState(initialThemeId)
  // Once Done is tapped the device plays its snap-to-screen + power-on; the chrome bows out and
  // taps are locked until the canvas reports the outro is finished.
  const [exiting, setExiting] = useState(false)
  // Hold the (heavy) WebGL build for a beat so the menu drawer can slide clear first, then the
  // device drops into the empty workshop. Without this, the build janks the drawer's exit.
  const [ready, setReady] = useState(reduced)
  const theme = THEME_BY_ID[selectedId] ?? THEMES[0]

  useEffect(() => {
    if (reduced) return
    const t = setTimeout(() => setReady(true), 250)
    return () => clearTimeout(t)
  }, [reduced])

  // Esc cancels, same as the X.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !exiting) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, exiting])

  const select = (id: string) => {
    if (exiting || id === selectedId) return
    haptic('selection')
    setSelectedId(id)
  }

  const commit = () => {
    if (exiting) return
    haptic('success')
    setExiting(true)
  }

  return (
    <div className="absolute inset-0 overflow-hidden">
      <WorkshopBackdrop />

      {/* The floating device. Transparent canvas → the workshop shows around it. Mounted a beat late
          so the drawer slides off cleanly, then the device flies into the empty bench. */}
      {ready && (
        <ConsoleCanvas
          customize
          theme={theme}
          outro={exiting}
          onOutroComplete={() => onDone(selectedId)}
        />
      )}

      {/* Chrome on top. The device area stays click-through so drags spin it; only the controls grab. */}
      <div className="pointer-events-none absolute inset-0 z-30 flex flex-col">
        <div className="flex-1" />

        <motion.div
          initial={{ opacity: 0, y: 36 }}
          animate={exiting ? { opacity: 0, y: 26 } : { opacity: 1, y: 0 }}
          transition={
            exiting
              ? { duration: 0.26, ease: 'easeIn' }
              : { duration: 0.5, ease: [0.16, 1, 0.3, 1], delay: reduced ? 0 : 0.34 }
          }
          className={cnm(
            'px-4 pb-[max(30px,calc(env(safe-area-inset-bottom)+20px))]',
            exiting ? 'pointer-events-none' : 'pointer-events-auto',
          )}
        >
          <div className="mb-1 flex items-center gap-2 px-1">
            <DeckGlyph />
            <span className="text-[26px] font-black leading-none tracking-tight text-white">Body</span>
            <span className="ml-1 translate-y-[1px] text-[13px] font-semibold text-white/35">
              {THEMES.length} skins
            </span>
          </div>

          <ThemeRail selectedId={selectedId} onSelect={select} />

          <div className="mt-5 flex items-center justify-between gap-3">
            <CircleButton label="Cancel" onPress={onCancel}>
              <X className="h-6 w-6" strokeWidth={2.6} />
            </CircleButton>

            <button
              type="button"
              onClick={commit}
              className="h-[58px] flex-1 rounded-full bg-white text-[19px] font-extrabold text-black shadow-[0_10px_30px_-10px_rgba(0,0,0,0.9)] transition-transform active:scale-[0.97]"
            >
              Done
            </button>

            <CircleButton
              label="Share"
              onPress={() => {
                haptic('selection')
                toast('Sharing your rig is coming soon')
              }}
            >
              <Share2 className="h-[22px] w-[22px]" strokeWidth={2.4} />
            </CircleButton>
          </div>
        </motion.div>
      </div>
    </div>
  )
}

function ThemeRail({
  selectedId,
  onSelect,
}: {
  selectedId: string
  onSelect: (id: string) => void
}) {
  const railRef = useRef<HTMLDivElement>(null)

  // Keep the active card in view when it changes (e.g. landing on a saved skin off-screen).
  useEffect(() => {
    const el = railRef.current?.querySelector<HTMLElement>(`[data-id="${selectedId}"]`)
    el?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }, [selectedId])

  return (
    <div
      ref={railRef}
      // pt/pb leave room for the selected card to lift + tilt; overflow-x forces overflow-y, so
      // without the padding the raised card clips.
      className="-mx-4 flex gap-3 overflow-x-auto px-5 pb-4 pt-7 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {THEMES.map((t) => (
        <ThemeCard
          key={t.id}
          theme={t}
          selected={t.id === selectedId}
          onPress={() => onSelect(t.id)}
        />
      ))}
    </div>
  )
}

function ThemeCard({
  theme,
  selected,
  onPress,
}: {
  theme: ConsoleTheme
  selected: boolean
  onPress: () => void
}) {
  return (
    <motion.button
      type="button"
      data-id={theme.id}
      onClick={onPress}
      aria-pressed={selected}
      animate={{
        rotate: selected ? -5 : 0,
        y: selected ? -10 : 0,
        scale: selected ? 1.05 : 1,
      }}
      transition={{ type: 'spring', stiffness: 460, damping: 30 }}
      className="relative h-[116px] w-[152px] shrink-0 origin-bottom overflow-hidden rounded-[22px] text-left"
      style={{
        background: theme.cardBg,
        // A real skeuo chip: top sheen, pressed-in base line, and a lifted drop shadow when selected.
        boxShadow: selected
          ? 'inset 0 1px 0 rgba(255,255,255,0.4), inset 0 -2px 8px rgba(0,0,0,0.22), 0 22px 40px -16px rgba(0,0,0,0.85)'
          : 'inset 0 1px 0 rgba(255,255,255,0.28), inset 0 -2px 6px rgba(0,0,0,0.2), 0 8px 20px -14px rgba(0,0,0,0.8)',
        outline: selected ? '2px solid rgba(255,255,255,0.85)' : '1px solid rgba(255,255,255,0.08)',
        outlineOffset: selected ? '-2px' : '-1px',
      }}
    >
      <div className="absolute inset-0 flex flex-col justify-end p-3.5">
        <div
          className="text-[30px] font-black leading-none tracking-tight tnum"
          style={{ color: theme.cardInk }}
        >
          {theme.code}
        </div>
        <div className="mt-1 text-[14px] font-bold leading-tight" style={{ color: theme.cardSub }}>
          {theme.name}
        </div>
      </div>

      {theme.badge && (
        <span
          className="absolute right-2.5 top-2.5 rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide"
          style={{ background: theme.cardInk, color: theme.cardBg }}
        >
          {theme.badge}
        </span>
      )}
    </motion.button>
  )
}

function CircleButton({
  children,
  label,
  onPress,
}: {
  children: React.ReactNode
  label: string
  onPress: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onPress}
      className="flex h-[58px] w-[58px] shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.07] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_10px_28px_-16px_rgba(0,0,0,1)] backdrop-blur-md transition-transform active:scale-95"
    >
      {children}
    </button>
  )
}

// The stacked-cards glyph next to the category label (echoes the reference).
function DeckGlyph() {
  return (
    <svg width="34" height="30" viewBox="0 0 34 30" fill="none" aria-hidden>
      <rect x="9" y="2" width="18" height="13" rx="3.4" fill="white" fillOpacity="0.34" transform="rotate(-9 18 8.5)" />
      <rect x="6" y="7" width="20" height="14" rx="3.6" fill="white" fillOpacity="0.62" transform="rotate(-4 16 14)" />
      <rect x="4" y="13" width="22" height="15" rx="3.8" fill="white" />
    </svg>
  )
}

// The workshop: a dark workbench-mat with soft, out-of-focus parts and a heavy vignette. Pure CSS so
// it looks intentional now; drop /assets/customize/workshop.jpg in later and it takes over (graded
// black-and-white), with this as the always-on fallback.
function WorkshopBackdrop() {
  const [hasPhoto, setHasPhoto] = useState(false)

  return (
    <div className="absolute inset-0 z-0 overflow-hidden bg-[#0a0a0b]">
      {/* base wash + soft top key light */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(130% 90% at 50% 30%, #1d1e22 0%, #141519 42%, #08080a 78%)',
        }}
      />

      {/* workbench cutting-mat grid */}
      <div
        className="absolute inset-0 opacity-[0.6]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)',
          backgroundSize: '38px 38px',
          maskImage: 'radial-gradient(120% 90% at 50% 32%, #000 30%, transparent 80%)',
          WebkitMaskImage: 'radial-gradient(120% 90% at 50% 32%, #000 30%, transparent 80%)',
        }}
      />

      {/* out-of-focus parts strewn across the bench */}
      <div
        className="absolute inset-0 opacity-70 blur-[3px]"
        style={{
          backgroundImage: [
            'radial-gradient(closest-side, rgba(150,150,158,0.5), rgba(150,150,158,0) 72%)',
            'radial-gradient(closest-side, rgba(120,120,128,0.42), rgba(120,120,128,0) 70%)',
            'radial-gradient(closest-side, rgba(90,90,98,0.4), rgba(90,90,98,0) 72%)',
            'radial-gradient(closest-side, rgba(170,170,178,0.32), rgba(170,170,178,0) 70%)',
            'radial-gradient(closest-side, rgba(110,110,118,0.36), rgba(110,110,118,0) 72%)',
          ].join(','),
          backgroundRepeat: 'no-repeat',
          backgroundPosition: '14% 16%, 82% 12%, 70% 24%, 26% 30%, 92% 30%',
          backgroundSize: '150px 150px, 120px 120px, 90px 90px, 80px 80px, 130px 130px',
        }}
      />

      {/* the real workbench photo — graded a touch darker so the device reads as the hero. The CSS
          layers above are the fallback if it ever fails to load. */}
      <img
        src="/assets/images/customize-bg.png"
        alt=""
        onLoad={() => setHasPhoto(true)}
        onError={() => setHasPhoto(false)}
        className={cnm(
          'absolute inset-0 h-full w-full object-cover transition-opacity duration-500',
          hasPhoto ? 'opacity-100' : 'opacity-0',
        )}
        style={{ filter: 'grayscale(1) brightness(0.82) contrast(1.06)' }}
        draggable={false}
      />

      {/* gentle vignette to seat the device without hiding the workbench parts */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(110% 80% at 50% 42%, transparent 46%, rgba(0,0,0,0.4) 82%, rgba(0,0,0,0.78) 100%)',
        }}
      />
      <div
        className="absolute inset-0"
        style={{ boxShadow: 'inset 0 0 120px 30px rgba(0,0,0,0.6)' }}
      />

      {/* the little live LED, top center (a wink to the reference) */}
      <div className="absolute left-1/2 top-[18px] -translate-x-1/2">
        <span className="block h-2 w-2 rounded-full bg-[#34d399] shadow-[0_0_10px_2px_rgba(52,211,153,0.7)]" />
      </div>
    </div>
  )
}
