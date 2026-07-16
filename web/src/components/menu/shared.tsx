import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { Illo } from '@/ui/Illo'
import { Button } from '@/ui/Button'
import { haptic } from '@/lib/haptics'
import { HapticOverlay } from '@/components/HapticOverlay'
import { cnm } from '@/utils/style'

export function prepareMenuTransition(direction: 'forward' | 'back') {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.menuTransition = direction
}

// The DUSDC token mark: the coin logo, optionally with the ticker. Menu surfaces only (balance,
// deposit, withdraw). Never on the device screen, that stays the flat TE instrument language.
export function DusdcMark({
  size = 16,
  showTicker = true,
  className,
  children,
}: {
  size?: number
  showTicker?: boolean
  className?: string
  children?: ReactNode
}) {
  return (
    <span className={cnm('inline-flex items-center gap-1.5', className)}>
      <img
        src="/assets/icons/dusdc-logo.webp"
        alt="DUSDC"
        width={size}
        height={size}
        style={{ width: size, height: size }}
        draggable={false}
        className="shrink-0 rounded-full"
      />
      {showTicker && 'DUSDC'}
      {children}
    </span>
  )
}

// Shared chrome for the menu sub-screens (Stats, Achievements, Settings, Customize): a titled screen
// with a sticky fade header, then its body. Empty/error states match the matrix in 07-DESIGN-SYSTEM.md.

export function MenuScreen({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <div className="relative min-h-full bg-black px-4 pb-8">
      <MenuHeader title={title} />
      <div className="relative z-0 -mt-1 pt-5">{children}</div>
    </div>
  )
}

export function MenuHeader({
  title,
  showBack = true,
}: {
  title: string
  showBack?: boolean
}) {
  const navigate = useNavigate()
  const goBack = () => {
    prepareMenuTransition('back')
    void navigate({ to: '/menu', viewTransition: true })
  }
  return (
    <header className="sticky top-0 z-30 -mx-4 h-[76px] bg-[linear-gradient(180deg,#000_0%,#000_52%,rgba(0,0,0,0.72)_72%,rgba(0,0,0,0)_100%)]">
      {showBack && (
        <div className="absolute left-4 top-1 h-12 w-12">
          <Link
            to="/menu"
            viewTransition
            onClick={() => {
              prepareMenuTransition('back')
              haptic('selection')
            }}
            aria-label="Back to menu"
            className="pointer-events-none flex h-12 w-12 items-center justify-center rounded-full border border-white/[0.09] bg-white/[0.12] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_10px_28px_-14px_rgba(0,0,0,1)] backdrop-blur-sm transition-transform active:scale-95"
          >
            <ChevronLeft className="h-7 w-7" strokeWidth={3} />
          </Link>
          <HapticOverlay className="absolute inset-0 rounded-full" preset="selection" silent onTap={goBack} />
        </div>
      )}
      <h1
        className={
          showBack
            ? 'absolute left-20 right-4 top-[14px] truncate text-left text-[24px] font-black leading-none text-white'
            : 'absolute left-4 right-4 top-[14px] truncate text-left text-[28px] font-black leading-none text-white'
        }
      >
        {title}
      </h1>
    </header>
  )
}

export function ScreenError({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <span className="h-1.5 w-1.5 rounded-full bg-down" />
      <p className="text-sm text-text-2">{message}</p>
      <Button
        variant="secondary"
        onClick={onRetry}
        className="h-9 rounded-full px-4 text-xs text-text-2"
      >
        Retry
      </Button>
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
