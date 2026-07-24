import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { HapticPreset } from '@/lib/haptics'
import { haptic } from '@/lib/haptics'
import { cnm } from '@/utils/style'

// The 3D hardware UI kit: the tactile bezel language from the audio cluster,
// generalized into common parts. Metallic domed keys on a machined panel, a
// socketed round key, and a proud slide toggle. Material recipes live in
// styles.css (.hw3d-*); these are the thin, accessible React wrappers.

type KeyVariant = 'neutral' | 'primary' | 'danger'

const KEY_VARIANT: Record<KeyVariant, string> = {
  neutral: '',
  primary: 'hw3d-key-primary',
  danger: 'hw3d-key-danger',
}

// A machined bezel plate. Mount keys, toggles and readouts onto it.
export function Hw3DPanel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cnm('hw3d-panel', className)}>{children}</div>
}

interface Hw3DButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  variant?: KeyVariant
  size?: 'md' | 'sm'
  wide?: boolean
  icon?: LucideIcon
  loading?: boolean
  haptic?: HapticPreset
  onPress?: () => void
  children?: ReactNode
}

// The metallic domed key. `wide` makes it fill its row; `icon` sits before the label; `size="sm"` shrinks
// it for tight rows (a compact pill still needs the same tactile press, not a flat text button).
export function Hw3DButton({
  variant = 'neutral',
  size = 'md',
  wide,
  icon: Icon,
  loading,
  disabled,
  haptic: hapticPreset = 'selection',
  onPress,
  className,
  children,
  ...rest
}: Hw3DButtonProps) {
  const off = disabled || loading
  return (
    <button
      type="button"
      disabled={off}
      onClick={() => {
        if (off) return
        haptic(hapticPreset)
        onPress?.()
      }}
      className={cnm(
        'hw3d-key uppercase',
        size === 'sm' ? 'hw3d-key-sm text-xs' : 'text-sm',
        KEY_VARIANT[variant],
        wide && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? (
        '···'
      ) : (
        <>
          {Icon && <Icon size={size === 'sm' ? 14 : 17} strokeWidth={2.6} />}
          {children}
        </>
      )}
    </button>
  )
}

// A round key sunk into a dark socket (the audio-cluster press button).
export function Hw3DIconButton({
  icon: Icon,
  label,
  size = 44,
  accent = '#f5a623',
  onPress,
  className,
}: {
  icon: LucideIcon
  label: string
  size?: number
  accent?: string
  onPress?: () => void
  className?: string
}) {
  return (
    <span className={cnm('hw3d-socket', className)}>
      <button
        type="button"
        aria-label={label}
        onClick={() => {
          haptic('selection')
          onPress?.()
        }}
        className="hw3d-cap"
        style={{ width: size, height: size }}
      >
        <Icon
          size={Math.round(size * 0.43)}
          strokeWidth={2.4}
          color={accent}
          style={{ filter: `drop-shadow(0 1px 1px rgba(0,0,0,0.6)) drop-shadow(0 0 5px ${accent}55)` }}
        />
      </button>
    </span>
  )
}

// A proud metallic slide toggle. Groove lights amber when on.
export function Hw3DToggle({
  isSelected,
  onChange,
  isDisabled,
  label,
  className,
}: {
  isSelected: boolean
  onChange: (value: boolean) => void
  isDisabled?: boolean
  label?: string
  className?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isSelected}
      aria-label={label}
      disabled={isDisabled}
      onClick={() => {
        haptic('selection')
        onChange(!isSelected)
      }}
      className={cnm('hw3d-toggle', className)}
    >
      <span className="hw3d-toggle-fill" />
      <span className="hw3d-toggle-thumb" />
    </button>
  )
}
