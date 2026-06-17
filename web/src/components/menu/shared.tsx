import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Illo } from '@/ui/Illo'
import { haptic } from '@/lib/haptics'

// Shared chrome for the menu sub-screens (Stats, Achievements, Settings, Customize). Each is a
// titled screen with a back chevron home to the menu hub, then a scrollable body. The empty and
// error states match the screen state matrix in 07-DESIGN-SYSTEM.md.

export function MenuScreen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 px-4 pb-1 pt-3">
        <Link
          to="/menu"
          onClick={() => haptic('selection')}
          aria-label="Back to menu"
          className="-ml-1 flex h-8 w-8 items-center justify-center rounded-full text-text-2 transition-colors active:text-text"
        >
          <span className="text-2xl leading-none">‹</span>
        </Link>
        <h1 className="text-xl font-extrabold tracking-tight">{title}</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5">{children}</div>
    </div>
  )
}

export function ScreenError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <span className="h-1.5 w-1.5 rounded-full bg-down" />
      <p className="text-sm text-text-2">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="card-neo rounded-full px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-text-2"
      >
        Retry
      </button>
    </div>
  )
}

export function ScreenEmpty({
  illo,
  title,
  sub,
  children,
}: {
  illo: string
  title: string
  sub: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-12 text-center">
      <Illo name={illo} size={88} />
      <div>
        <div className="text-lg font-extrabold">{title}</div>
        <div className="mt-1 text-sm text-text-2">{sub}</div>
      </div>
      {children}
    </div>
  )
}
