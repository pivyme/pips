// Pips is a handheld. On a phone the device fills the screen. On desktop we
// don't sprawl wide like a trading terminal, we frame it as a tall device
// floating on a drifting Pips-logo field, like a product shot. It scales with
// viewport height (~88dvh, aspect-locked) so it reads as the hero, not a chip.
// (Landing is exempt, it gets the full width.)
import type { ReactNode } from 'react'
import { cnm } from '@/utils/style'

// `bg` tints the ambient (the desktop surround + the frame the device sits in) to the active skin.
// Defaults to black for screens that mount before a theme is known. `dimmed` fades the drifting logo
// field out (the landing door wants the device alone; it eases back in once you sign in).
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
      <div
        className="relative z-10 flex h-dvh w-full flex-col overflow-hidden bg-black sm:h-auto sm:aspect-[23/44] sm:w-[min(88vw,46dvh)] sm:max-w-[720px] sm:rounded-[min(2.8vw,2.8dvh)] sm:border sm:border-white/10 sm:shadow-[0_40px_120px_-20px_rgba(0,0,0,0.9)]"
        style={style}
      >
        {children}
      </div>
    </div>
  )
}
