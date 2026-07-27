import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react'
import { uiSfx } from '@/lib/uiSfx'
import { cnm } from '@/utils/style'

// The in-screen button primitive (docs/DESIGN.md section 10), wraps the styles.css variants and states.
// Console chrome buttons stay in ConsoleShell; this is for buttons rendered inside a screen.
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANTS: Record<Variant, string> = {
  primary: 'btn-primary',
  secondary: 'card-neo text-text',
  ghost: 'text-text-2 active:text-text',
  danger: 'btn-danger',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  loading?: boolean
  children: ReactNode
}

export function Button({ variant = 'primary', loading, disabled, className, children, onClick, ...rest }: ButtonProps) {
  const off = disabled || loading
  return (
    <button
      type="button"
      // aria-disabled, not disabled: a disabled button never gets the click, so it could not answer the
      // tap with the reject sound. See Hardware3D.tsx, same reasoning.
      aria-disabled={off || undefined}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        if (off) {
          uiSfx('disabled')
          return
        }
        uiSfx('tap')
        onClick?.(e)
      }}
      className={cnm(
        'inline-flex h-12 items-center justify-center gap-2 rounded-md px-5 text-sm font-extrabold uppercase tracking-wide transition-transform',
        VARIANTS[variant],
        off ? 'opacity-60' : 'active:scale-[0.98]',
        className,
      )}
      {...rest}
    >
      {loading ? '···' : children}
    </button>
  )
}
