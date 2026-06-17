// Pips is a handheld. On a phone the device fills the screen. On desktop we
// don't sprawl wide like a trading terminal, we frame it as a phone-sized
// device floating on ambient black, like a product shot. (Landing is exempt,
// it gets the full width.)
import type { ReactNode } from 'react'

export function AppFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh w-full items-stretch justify-center bg-black sm:items-center">
      <div className="relative flex h-dvh w-full flex-col overflow-hidden bg-black sm:h-[min(880px,94dvh)] sm:w-[420px] sm:rounded-[44px] sm:border sm:border-white/10 sm:shadow-[0_40px_120px_-20px_rgba(0,0,0,0.9)]">
        {children}
      </div>
    </div>
  )
}
