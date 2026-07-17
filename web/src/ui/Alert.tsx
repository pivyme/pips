import type { ReactNode } from 'react'
import { cnm } from '@/utils/style'

// A flat inline notice: one tinted fill, no outline, no bevel. Deliberately the quietest surface on the
// screen. It sits next to the thing it is about, so it reads at a glance and then gets out of the way,
// which a bordered box does not.
//
// Two urgencies, split by the art: `warning` is the loud one (fund loss, hard stops), `alert` is the soft
// heads-up. Both are the branded 3D icons, not lucide glyphs, so they match the menu tiles.

export type AlertTone = 'warning' | 'alert'

const TONE: Record<AlertTone, { fill: string; icon: string }> = {
  warning: { fill: 'bg-brand-400/[0.16]', icon: '/assets/icons/icon-warning.webp' },
  alert: { fill: 'bg-brand-400/[0.09]', icon: '/assets/icons/icon-alert.webp' },
}

export function Alert({
  tone = 'warning',
  size = 26,
  className,
  children,
}: {
  tone?: AlertTone
  size?: number
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cnm(
        'flex items-start gap-3 rounded-card p-4 text-[13px] leading-snug text-text-2',
        TONE[tone].fill,
        className,
      )}
    >
      {/* The icon box is exactly one line tall (leading-snug = 1.375em), so the glyph centers on the FIRST
          line and holds there when the copy wraps, instead of drifting with the block's height. */}
      <span className="flex h-[1.375em] shrink-0 items-center">
        <img src={TONE[tone].icon} alt="" aria-hidden draggable={false} style={{ width: size, height: size }} />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
