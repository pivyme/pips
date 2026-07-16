// PIPS is a handheld: full-screen on phone, but on desktop it's framed as a tall device floating on a drifting PIPS-logo field (a product shot, not a wide trading terminal), scaled to ~88dvh aspect-locked so it reads as the hero, not a chip.
// Landing is exempt, it gets full width.
import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { cnm } from '@/utils/style'
import { useReducedMotion } from '@/hooks/useReducedMotion'

// `bg` tints the ambient (desktop surround + device frame) to the active skin, defaulting to black before a theme is known.
// `dimmed` is the landing door: fades the drifting logo field out and swaps in the deconstructed-device backdrop, so the handheld card reads as the hero; the card itself is untouched.
export function AppFrame({ children, bg, dimmed = false }: { children: ReactNode; bg?: string; dimmed?: boolean }) {
  const style = bg ? { background: bg } : undefined
  return (
    <div
      className="app-shell relative flex min-h-dvh w-full items-stretch justify-center overflow-hidden bg-black sm:items-center"
      style={style}
    >
      {/* Desktop surround: the device floats on a slow diagonal field of the PIPS logo, not flat black. */}
      <div
        className={cnm('pips-surround pointer-events-none absolute inset-0 hidden sm:block', dimmed && 'pips-surround-dim')}
        aria-hidden
      />
      {/* Landing door surround: the deconstructed-device flatlay replaces the dimmed logo field, drifting under the cursor so the card reads as the hero on a real surface.
          Desktop-only (mobile is full-bleed) and behind the z-10 card, so the card stays untouched. */}
      <LandingBackdrop active={dimmed} />
      <div
        className="relative z-10 flex h-dvh w-full flex-col overflow-hidden bg-black sm:h-auto sm:aspect-[23/44] sm:w-[min(88vw,46dvh)] sm:max-w-[720px] sm:rounded-[min(1.8vw,1.8dvh)] sm:border sm:border-white/10 sm:shadow-[0_40px_120px_-20px_rgba(0,0,0,0.9)]"
        style={style}
      >
        {children}
      </div>
    </div>
  )
}

// The landing surround image with a soft cursor parallax, desktop-only, behind the device card. Transform is driven straight on the DOM node via rAF (eased toward the pointer target), no React state churn.
// Oversized 7% on every side so the drift never exposes a bare edge.
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
