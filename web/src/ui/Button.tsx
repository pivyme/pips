import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cnm } from '@/utils/style'

// The in-screen button primitive (docs/DESIGN.md section 10). Wraps the styles.css recipes so
// every screen button shares one set of variants and states. Console chrome buttons stay in
// ConsoleShell; this is for buttons rendered inside a screen (share, retry, confirm).
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANTS: Record<Variant, string> = {
  primary: 'btn-primary',
  secondary: 'card-neo text-text',
  ghost: 'text-text-2 active:text-text',
  danger: 'border border-down/40 bg-down/15 text-down',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  loading?: boolean
  children: ReactNode
}

export function Button({ variant = 'primary', loading, disabled, className, children, ...rest }: ButtonProps) {
  const off = disabled || loading
  return (
    <button
      type="button"
      disabled={off}
      className={cnm(
        'inline-flex h-12 items-center justify-center gap-2 rounded-2xl px-5 text-sm font-extrabold uppercase tracking-wide transition-transform',
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
