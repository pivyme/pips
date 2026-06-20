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
  visible = true,
  active = true,
  onCommit,
  onOutroComplete,
  onCancel,
}: {
  initialThemeId: string
  visible?: boolean
  active?: boolean
  onCommit: (themeId: string) => void
  onOutroComplete: () => void
  onCancel: () => void
}) {
  const reduced = useReducedMotion()
  const [selectedId, setSelectedId] = useState(initialThemeId)
  // Once Done is tapped the device plays its snap-to-screen + power-on; the chrome bows out and
  // taps are locked until the canvas reports the outro is finished.
  const [exiting, setExiting] = useState(false)
  // Let the workshop paint one beat before the prepared WebGL view mounts.
  const [ready, setReady] = useState(reduced)
  const theme = THEME_BY_ID[selectedId] ?? THEMES[0]

  useEffect(() => {
    if (reduced) return
    const t = setTimeout(() => setReady(true), 90)
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
    setReady(true) // make sure the canvas is mounted so the outro can play + report completion
    setExiting(true)
    onCommit(selectedId)
  }

  return (
    <div
      className="absolute inset-0 z-20 overflow-hidden"
      style={{
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? undefined : 'none',
      }}
      aria-hidden={!visible}
    >
      <WorkshopBackdrop />

      {/* The floating device. Transparent canvas → the workshop shows around it. Mounted a beat late
          so the drawer slides off cleanly, then the device flies into the empty bench. */}
      {ready && (
        <ConsoleCanvas
          customize
          tuner={import.meta.env.DEV}
          active={active}
          theme={theme}
          outro={exiting}
          onOutroComplete={onOutroComplete}
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

export function ThemeRail({
  selectedId,
  onSelect,
}: {
  selectedId: string
  onSelect: (id: string) => void
}) {
  const railRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef({
    pointerId: -1,
    startX: 0,
    startScrollLeft: 0,
    moved: false,
  })

  // Keep the active card centered, scrolling the rail itself. scrollIntoView would bubble up when the
  // last cards can't be centered (no rail left to their right) and scroll the overflow-hidden studio
  // root too, dragging the whole device off-center. Touching only the rail keeps the device put.
  useEffect(() => {
    const rail = railRef.current
    const el = rail?.querySelector<HTMLElement>(`[data-id="${selectedId}"]`)
    if (!rail || !el) return
    const railRect = rail.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    const delta = elRect.left + elRect.width / 2 - (railRect.left + railRect.width / 2)
    rail.scrollTo({ left: rail.scrollLeft + delta, behavior: 'smooth' })
  }, [selectedId])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Touch uses the browser's native horizontal scrolling. Capturing it here breaks taps on the
    // theme buttons and is less reliable than native momentum scrolling on mobile Safari.
    if (e.pointerType === 'touch' || e.button !== 0) return
    const rail = e.currentTarget
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startScrollLeft: rail.scrollLeft,
      moved: false,
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag.pointerId !== e.pointerId) return
    const dx = e.clientX - drag.startX
    if (Math.abs(dx) > 4 && !drag.moved) {
      drag.moved = true
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    if (!drag.moved) return
    e.preventDefault()
    e.currentTarget.scrollLeft = drag.startScrollLeft - dx
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag.pointerId !== e.pointerId) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    drag.pointerId = -1
    // Keep the flag through the synthetic click that follows pointerup, then clear it.
    if (drag.moved) setTimeout(() => { drag.moved = false }, 0)
  }

  return (
    <div
      ref={railRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClickCapture={(e) => {
        if (!dragRef.current.moved) return
        e.preventDefault()
        e.stopPropagation()
      }}
      onDragStart={(e) => e.preventDefault()}
      // pt/pb leave room for the selected card to lift + tilt; overflow-x forces overflow-y, so
      // without the padding the raised card clips.
      className="-mx-4 flex cursor-grab touch-pan-x select-none gap-3 overflow-x-auto px-5 pb-4 pt-7 active:cursor-grabbing [-ms-overflow-style:none] [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
        // The -5deg tilt + scale pivots off the bottom and throws the top-left corner toward the
        // previous card, so nudge the whole chip right when it lifts to keep clear of its neighbor.
        rotate: selected ? -5 : 0,
        x: selected ? 4 : 0,
        y: selected ? -10 : 0,
        scale: selected ? 1.05 : 1,
      }}
      transition={{ type: 'spring', stiffness: 460, damping: 30 }}
      className="relative h-[116px] w-[152px] shrink-0 origin-bottom overflow-hidden rounded-[22px] text-left"
      style={{
        background: theme.cardBg,
        // Just the cast shadow here; the molded-plastic emboss lives on the overlay below so it
        // also reads over the full-bleed art cards.
        boxShadow: selected
          ? '0 26px 46px -16px rgba(0,0,0,0.9)'
          : '0 10px 22px -12px rgba(0,0,0,0.8)',
        outline: selected ? 'none' : '1px solid rgba(255,255,255,0.08)',
        outlineOffset: '-1px',
      }}
    >
      {theme.cardImage && (
        <img
          src={theme.cardImage}
          alt=""
          draggable={false}
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover object-center"
        />
      )}

      {/* The emboss: a soft top-light sheen fading into a shaded base, built from a gradient + gently
          blurred inset shadows (no hard bevel lines, which alias into gritty edges once the chip
          tilts). Sits above the art, below the text, so solid and photo chips both read molded. */}
      <div
        className="pointer-events-none absolute inset-0 rounded-[22px]"
        style={{
          background:
            'linear-gradient(to bottom, rgba(255,255,255,0.26), rgba(255,255,255,0.06) 18%, rgba(255,255,255,0) 42%, rgba(0,0,0,0) 64%, rgba(0,0,0,0.16))',
          boxShadow: selected
            ? 'inset 0 1px 2px rgba(255,255,255,0.45), inset 0 -12px 22px -12px rgba(0,0,0,0.3)'
            : 'inset 0 1px 2px rgba(255,255,255,0.38), inset 0 -10px 18px -12px rgba(0,0,0,0.24)',
        }}
      />

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
          className="absolute right-2.5 top-2.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-extrabold tracking-tight"
          // Over art the card ink goes light, so anchor the badge to a fixed dark chip instead.
          style={
            theme.cardImage
              ? { background: '#000f1d', color: '#ffffff' }
              : { background: theme.cardInk, color: theme.cardBg }
          }
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
// black-and-white), with this as the always-on fallback. Shared with onboarding's skin step.
export function WorkshopBackdrop() {
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
