// Pips is a handheld. On a phone the device fills the screen. On desktop we
// don't sprawl wide like a trading terminal, we frame it as a tall device
// floating on a drifting Pips-logo field, like a product shot. It scales with
// viewport height (~88dvh, aspect-locked) so it reads as the hero, not a chip.
// (Landing is exempt, it gets the full width.)
import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { cnm } from '@/utils/style'
import { useReducedMotion } from '@/hooks/useReducedMotion'

// `bg` tints the ambient (the desktop surround + the frame the device sits in) to the active skin.
// Defaults to black for screens that mount before a theme is known. `dimmed` is the landing door: it
// fades the drifting logo field out and swaps in the deconstructed-device backdrop behind the device,
// so the handheld card reads as the hero on a real surface. The device card itself is untouched.
export function AppFrame({ children, bg, dimmed = false }: { children: ReactNode; bg?: string; dimmed?: boolean }) {
  const style = bg ? { background: bg } : undefined
  return (
    <div
      className="relative flex min-h-dvh w-full items-stretch justify-center overflow-hidden bg-black sm:items-center"
      style={style}
    >
      {/* Desktop surround: the device floats on a slow diagonal field of the Pips logo, not flat black. */}
      <div
        className={cnm('pips-surround pointer-events-none absolute inset-0 hidden sm:block', dimmed && 'pips-surround-dim')}
        aria-hidden
      />
      {/* Landing door surround: the deconstructed-device flatlay replaces the dimmed logo field, drifting
          under the cursor so the handheld card reads as the hero on a real surface. Desktop-only (mobile
          has no surround, the card is full-bleed) and behind the z-10 card, so the card stays untouched. */}
      <LandingBackdrop active={dimmed} />
      <div
        className="relative z-10 flex h-dvh w-full flex-col overflow-hidden bg-black sm:h-auto sm:aspect-[23/44] sm:w-[min(88vw,46dvh)] sm:max-w-[720px] sm:rounded-[min(2.8vw,2.8dvh)] sm:border sm:border-white/10 sm:shadow-[0_40px_120px_-20px_rgba(0,0,0,0.9)]"
        style={style}
      >
        {children}
      </div>
    </div>
  )
}

// The landing surround image with a soft cursor parallax. Desktop-only (it replaces the logo field),
// behind the device card. The transform is driven straight on the DOM node via rAF (eased toward the
// pointer target), no React state churn, so it stays a cheap composited translate. Oversized by 7% on
// every side so the drift never exposes a bare edge.
function LandingBackdrop({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()

  useEffect(() => {
    if (!active || reduced) return
    const el = ref.current
    if (!el) return
    let raf = 0
    let cx = 0
    let cy = 0
    let tx = 0
    let ty = 0
    const MAX = 16 // px of travel at the corners
    const tick = () => {
      cx += (tx - cx) * 0.08
      cy += (ty - cy) * 0.08
      el.style.transform = `translate3d(${(cx * MAX).toFixed(2)}px, ${(cy * MAX).toFixed(2)}px, 0)`
      raf = Math.abs(tx - cx) > 0.0005 || Math.abs(ty - cy) > 0.0005 ? requestAnimationFrame(tick) : 0
    }
    const onMove = (e: PointerEvent) => {
      // Move the field opposite the cursor so it reads as looking around the scene.
      tx = -(e.clientX / window.innerWidth - 0.5) * 2
      ty = -(e.clientY / window.innerHeight - 0.5) * 2
      if (!raf) raf = requestAnimationFrame(tick)
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [active, reduced])

  return (
    <div
      className={cnm(
        'pointer-events-none absolute inset-0 hidden overflow-hidden bg-black transition-opacity duration-700 sm:block',
        active ? 'opacity-100' : 'opacity-0',
      )}
      aria-hidden
    >
      <div
        ref={ref}
        className="absolute inset-[-7%] bg-cover bg-center will-change-transform"
        style={{ backgroundImage: "url('/assets/images/decon-bg.png')" }}
      />
      {/* Lift contrast so the white wordmark up top and the copy below stay legible over the flatlay. */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/45 via-black/15 to-black/55" />
    </div>
  )
}
