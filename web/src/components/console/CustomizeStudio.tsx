// The Customize studio: launched from the menu, drops the device into a black-and-white workshop,
// floating as a hero shot, free to spin. A rail of preset cards reskins it live; X discards, Done saves, Share is a teaser.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Share2, X } from 'lucide-react'
import toast from 'react-hot-toast'
import ConsoleCanvas from './ConsoleCanvas'
import { THEMES, THEME_BY_ID } from './themes'
import type { ConsoleTheme } from './themes'
import { GLOW_PALETTE, PALETTE, hasOverrides, resolveTheme } from './customize'
import type { ConsoleCustom, PartId } from './customize'
import { haptic } from '@/lib/haptics'
import { requestDeviceTiltPermission } from '@/lib/deviceTilt'
import { HapticOverlay } from '@/components/HapticOverlay'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { cnm } from '@/utils/style'

type TabId = 'presets' | PartId
const TABS: { id: TabId; label: string }[] = [
  { id: 'presets', label: 'Presets' },
  { id: 'body', label: 'Body' },
  { id: 'play', label: 'Play' },
  { id: 'buttons', label: 'Buttons' },
  { id: 'knob', label: 'Knob' },
  { id: 'glow', label: 'Glow' },
]

// Presets <-> part-tabs cross a picker boundary (rail vs swatch grid), so that swap slides; part->part
// stays an in-place palette update. Direction follows the tab strip: forward into parts, back to presets.
const pickerVariants = {
  enter: (d: number) => ({ opacity: 0, x: 26 * d }),
  center: { opacity: 1, x: 0 },
  exit: (d: number) => ({ opacity: 0, x: -26 * d }),
}

export function CustomizeStudio({
  initialCustom,
  visible = true,
  active = true,
  onCommit,
  onOutroComplete,
  onCancel,
}: {
  initialCustom: ConsoleCustom
  visible?: boolean
  active?: boolean
  onCommit: (custom: ConsoleCustom) => void
  onOutroComplete: () => void
  onCancel: () => void
}) {
  const reduced = useReducedMotion()
  // Local draft: nothing touches the saved rig until Done. Cancel needs no snapshot.
  const [draft, setDraft] = useState<ConsoleCustom>(initialCustom)
  const [tab, setTab] = useState<TabId>('presets')
  // Once Done is tapped the device plays its snap-to-screen + power-on; chrome bows out and taps lock until the canvas reports the outro finished.
  const [exiting, setExiting] = useState(false)
  // Delay the heavy WebGL build one beat past mount, so the closing drawer's fall is already gliding
  // on the compositor before the synchronous Three.js build lands on the main thread.
  const [ready, setReady] = useState(reduced)
  const resolved = useMemo(() => resolveTheme(draft), [draft])
  // +1 sliding into a part tab, -1 sliding back home to presets.
  const pickerDir = tab === 'presets' ? -1 : 1

  useEffect(() => {
    if (reduced) return
    const t = setTimeout(() => setReady(true), 90)
    return () => clearTimeout(t)
  }, [reduced])

  // The studio stays mounted between opens (the canvas parks hidden at 0fps), so on the hide edge
  // rewind to a fresh state: draft back to the saved rig, tab home, outro disarmed. The canvas does
  // its own park (ConsoleCanvas applyActiveRef), so the next reveal replays the whole zoom-out.
  const initialRef = useRef(initialCustom)
  initialRef.current = initialCustom
  const wasVisible = useRef(visible)
  useEffect(() => {
    if (wasVisible.current && !visible) {
      setDraft(initialRef.current)
      setTab('presets')
      setExiting(false)
    }
    wasVisible.current = visible
  }, [visible])

  // Esc cancels, same as the X.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !exiting) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, exiting])

  const pickPreset = (id: string) => {
    if (exiting) return
    haptic('selection')
    setDraft({ preset: id }) // preset tap resets all overrides
    // iOS gates motion access behind a tap; this tap is as good as any, and it's what makes the
    // gold's reflection sweep react to the phone in hand instead of sitting static.
    if (THEME_BY_ID[id]?.metallic) void requestDeviceTiltPermission()
  }

  const pickSwatch = (part: PartId, i: number) => {
    if (exiting) return
    haptic('selection')
    setDraft((d) => ({ ...d, parts: { ...d.parts, [part]: i } }))
  }

  const commit = () => {
    if (exiting) return
    haptic('success')
    if (resolved.metallic) void requestDeviceTiltPermission() // covers Done without re-tapping the card
    setReady(true) // make sure the canvas is mounted so the outro can play + report completion
    setExiting(true)
    onCommit(draft)
  }

  return (
    <div
      className="absolute inset-0 z-20 overflow-hidden"
      style={{ pointerEvents: visible ? undefined : 'none' }}
      aria-hidden={!visible}
    >
      {/* Workshop fades in around the device as it zooms out (same recipe as onboarding's ThemePicker),
          so the hand-off from the live console reads as one device pulling back into the bench. On the
          way out it fades WITH the Done outro (not after): the outro is ~740ms and this is 600ms, so the
          backdrop is already gone by onOutroComplete, when the real console reappears underneath. Waiting
          for `visible` there would leave the (opaque) backdrop sitting above the just-revealed console for
          another 600ms, a flash of workshop background before the console shows through. */}
      <div
        className="absolute inset-0 transition-opacity duration-[600ms] ease-out"
        style={{ opacity: visible && !exiting ? 1 : 0 }}
      >
        <WorkshopBackdrop />
      </div>

      {/* The floating device on a transparent canvas. Built hidden while the drawer slides off, holding
          the exact live app pose (introFromApp), then revealed in place and eased out into the studio. */}
      {ready && (
        <div className="absolute inset-0" style={{ opacity: visible ? 1 : 0 }}>
          <ConsoleCanvas
            customize
            introFromApp
            active={active}
            theme={resolved}
            focusPart={tab === 'presets' ? null : tab}
            outro={exiting}
            onOutroComplete={onOutroComplete}
          />
        </div>
      )}

      {/* Chrome on top. The device area stays click-through so drags spin it; only the controls grab. */}
      <div className="pointer-events-none absolute inset-0 z-30 flex flex-col">
        <div className="flex-1" />

        <motion.div
          initial={{ opacity: 0, y: 36 }}
          animate={!visible ? { opacity: 0, y: 36 } : exiting ? { opacity: 0, y: 26 } : { opacity: 1, y: 0 }}
          transition={
            exiting
              ? { duration: 0.26, ease: 'easeIn' }
              : { duration: 0.5, ease: [0.16, 1, 0.3, 1], delay: reduced ? 0 : 0.34 }
          }
          className={cnm(
            'px-4 pb-[max(30px,calc(env(safe-area-inset-bottom)+20px))]',
            visible && !exiting ? 'pointer-events-auto' : 'pointer-events-none',
          )}
        >
          <TabStrip tab={tab} onSelect={setTab} />

          <div className="relative min-h-[160px]">
            <AnimatePresence mode="popLayout" initial={false} custom={pickerDir}>
              <motion.div
                key={tab === 'presets' ? 'presets' : 'swatches'}
                custom={pickerDir}
                variants={pickerVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={reduced ? { duration: 0 } : { duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
              >
                {tab === 'presets' ? (
                  // A custom mix (overrides on top of a preset) matches no card, so nothing lights up
                  // rather than inventing a synthetic "Custom" card in the rail.
                  <ThemeRail
                    selectedId={hasOverrides(draft) ? '__custom' : draft.preset}
                    onSelect={pickPreset}
                  />
                ) : (
                  <SwatchGrid part={tab} draft={draft} onPick={(i) => pickSwatch(tab, i)} />
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="mt-5 flex items-center justify-between gap-3">
            <CircleButton label="Cancel" onPress={onCancel}>
              <X className="h-6 w-6" strokeWidth={2.6} />
            </CircleButton>

            <div className="relative h-[58px] flex-1">
              <button
                type="button"
                onClick={commit}
                className="pointer-events-none h-[58px] w-full rounded-full bg-white text-[19px] font-extrabold text-black shadow-[0_10px_30px_-10px_rgba(0,0,0,0.9)] transition-transform active:scale-[0.97]"
              >
                Done
              </button>
              <HapticOverlay className="absolute inset-0 rounded-full" preset="success" silent onTap={commit} />
            </div>

            <CircleButton
              label="Share"
              onPress={() => {
                haptic('selection')
                toast('For now, show off your rig with your PnL card', { id: 'share-rig' })
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
  leading,
}: {
  selectedId: string
  onSelect: (id: string) => void
  leading?: ReactNode
}) {
  const railRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef({
    pointerId: -1,
    startX: 0,
    startScrollLeft: 0,
    moved: false,
  })

  // Keep the active card centered by scrolling the rail itself; scrollIntoView would bubble up when the
  // last cards can't center (no rail left of them) and drag the whole device off-center via the overflow-hidden studio root.
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
    // Touch uses the browser's native horizontal scrolling; capturing it here breaks taps on the theme buttons and is less reliable than native momentum on mobile Safari.
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
      // pt/pb leave room for the selected card to lift + tilt; overflow-x forces overflow-y, so without the padding the raised card clips.
      className="-mx-4 flex cursor-grab touch-pan-x select-none gap-3 overflow-x-auto px-5 pb-4 pt-7 active:cursor-grabbing [-ms-overflow-style:none] [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {leading}
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
        // The -5deg tilt + scale pivots off the bottom and throws the top-left corner toward the previous
        // card, so nudge the whole chip right when it lifts to keep clear of its neighbor.
        rotate: selected ? -5 : 0,
        x: selected ? 4 : 0,
        y: selected ? -10 : 0,
        scale: selected ? 1.05 : 1,
      }}
      transition={{ type: 'spring', stiffness: 460, damping: 30 }}
      className="relative h-[116px] w-[152px] shrink-0 origin-bottom overflow-hidden rounded-[22px] text-left"
      style={{
        background: theme.cardBg,
        // Just the cast shadow here, the molded-plastic emboss lives on the overlay below so it also reads over full-bleed art cards.
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

      {/* The emboss: a soft top-light sheen fading into a shaded base via a gradient + blurred inset
          shadows (no hard bevel lines, which alias once the chip tilts). Sits above art, below text. */}
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

// Horizontal tab strip (Presets | Body | Play | Buttons | Knob | Glow). Keeps the active tab
// centered the same way ThemeRail centers its selected card.
function TabStrip({ tab, onSelect }: { tab: TabId; onSelect: (t: TabId) => void }) {
  const railRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const rail = railRef.current
    const el = rail?.querySelector<HTMLElement>(`[data-id="${tab}"]`)
    if (!rail || !el) return
    const railRect = rail.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    const delta = elRect.left + elRect.width / 2 - (railRect.left + railRect.width / 2)
    rail.scrollTo({ left: rail.scrollLeft + delta, behavior: 'smooth' })
  }, [tab])

  return (
    <div
      ref={railRef}
      className="-mx-4 mb-2 flex gap-5 overflow-x-auto px-5 pb-1 pt-1 [-ms-overflow-style:none] [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          data-id={t.id}
          aria-pressed={t.id === tab}
          onClick={() => {
            if (t.id === tab) return
            haptic('selection')
            onSelect(t.id)
          }}
          className={cnm(
            'shrink-0 whitespace-nowrap text-[26px] font-extrabold leading-none tracking-tight transition-colors',
            t.id === tab ? 'text-white' : 'text-white/35',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

// One row of 12 fixed swatches for the active part tab. No override on the part = no ring lit (it's
// wearing the preset), first tap creates the override.
function SwatchGrid({
  part,
  draft,
  onPick,
}: {
  part: PartId
  draft: ConsoleCustom
  onPick: (i: number) => void
}) {
  const selected = draft.parts?.[part]
  // Glow gets its own luminous swatches: the screen is emissive with dark ink, dark picks can't work there.
  const colors = part === 'glow' ? GLOW_PALETTE : PALETTE
  return (
    <div className="grid grid-cols-6 justify-items-center gap-y-4 px-1 py-2">
      {colors.map((c, i) => (
        <motion.button
          key={c.name}
          type="button"
          aria-label={c.name}
          aria-pressed={selected === i}
          onClick={() => onPick(i)}
          animate={{ scale: selected === i ? 1.12 : 1 }}
          transition={{ type: 'spring', stiffness: 460, damping: 26 }}
          className="h-[46px] w-[46px] rounded-full"
          style={{
            // Sphere shading like the reference: a top-left highlight over the flat hex + a seating shadow.
            background: `radial-gradient(circle at 32% 28%, rgba(255,255,255,0.5), rgba(255,255,255,0) 42%), ${c.hex}`,
            boxShadow:
              selected === i
                ? `0 0 0 2.5px #0a0a0b, 0 0 0 5px #ffffff, 0 8px 18px -8px rgba(0,0,0,0.8)`
                : `inset 0 -6px 10px -6px rgba(0,0,0,0.45), 0 8px 18px -8px rgba(0,0,0,0.8)`,
          }}
        />
      ))}
    </div>
  )
}

// The workshop: a dark workbench-mat with soft out-of-focus parts and a heavy vignette, pure CSS. Drop
// /assets/customize/workshop.jpg in later to take over (graded black-and-white); this stays the fallback. Shared with onboarding's skin step.
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

      {/* the real workbench photo, graded a touch darker so the device reads as the hero; the CSS layers above are the fallback if it fails to load. */}
      <img
        src="/assets/images/customize-bg.webp"
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
