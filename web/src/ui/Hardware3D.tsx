import { useEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { HapticPreset } from '@/lib/haptics'
import { haptic } from '@/lib/haptics'
import { uiSfx } from '@/lib/uiSfx'
import { cnm } from '@/utils/style'

const AMBER = '#f5a623'
const AMBER_HI = '#ffd25e'

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
      // aria-disabled rather than disabled, here and on the parts below: a disabled button never
      // receives the click, so a dead key could not answer with the reject sound. Styling keys off both.
      aria-disabled={off || undefined}
      onClick={() => {
        if (off) {
          uiSfx('disabled')
          return
        }
        haptic(hapticPreset)
        uiSfx('tap')
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
  disabled,
  onPress,
  className,
}: {
  icon: LucideIcon
  label: string
  size?: number
  accent?: string
  disabled?: boolean
  onPress?: () => void
  className?: string
}) {
  return (
    <span className={cnm('hw3d-socket', className)}>
      <button
        type="button"
        aria-label={label}
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (disabled) {
            uiSfx('disabled')
            return
          }
          haptic('selection')
          uiSfx('tap')
          onPress?.()
        }}
        className="hw3d-cap"
        style={{ width: size, height: size }}
      >
        <Icon
          size={Math.round(size * 0.43)}
          strokeWidth={2.4}
          color={disabled ? 'rgba(255,255,255,0.22)' : accent}
          style={{
            filter: disabled
              ? 'none'
              : `drop-shadow(0 1px 1px rgba(0,0,0,0.6)) drop-shadow(0 0 5px ${accent}55)`,
          }}
        />
      </button>
    </span>
  )
}

// The Game Boy style volume fader: a recessed notched groove with an amber level fill and a proud
// ridged cap. Controlled (value 0..1). Width comes from `className` (e.g. flex-1 or w-32), everything
// else is fixed material. This is the fader the whole hardware kit is built from.
const FADER_THUMB = 22
// Cap centre travels half a cap in from each rim, so the usable track is that much shorter.
function faderValueAt(track: HTMLElement, clientX: number): number {
  const r = track.getBoundingClientRect()
  return Math.max(0, Math.min(1, (clientX - r.left - FADER_THUMB / 2) / (r.width - FADER_THUMB)))
}
export function Hw3DFader({
  value,
  onChange,
  label,
  className,
}: {
  value: number
  onChange: (v: number) => void
  label: string
  className?: string
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  // Held in a ref so the window listeners below never close over a stale handler.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const setFromClientX = (clientX: number) => {
    const el = trackRef.current
    if (el) onChangeRef.current(faderValueAt(el, clientX))
  }

  // A grab owns the pointer until it is released: the finger can wander off the track, above it, or
  // clean off the sheet and the cap still follows. Window-level, so it survives losing the capture.
  useEffect(() => {
    if (!dragging) return
    const move = (e: PointerEvent) => {
      const el = trackRef.current
      if (el) onChangeRef.current(faderValueAt(el, e.clientX))
    }
    const end = () => setDragging(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [dragging])

  // Cap centre + fill both stop at the same point: half a cap in from each rim.
  const travel = `calc(${FADER_THUMB / 2}px + (100% - ${FADER_THUMB}px) * ${value})`

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      onPointerDown={(e) => {
        setDragging(true)
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          // capture is best-effort, the window listeners carry the drag either way
        }
        haptic('selection')
        setFromClientX(e.clientX)
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
          onChange(Math.min(1, value + 0.02))
          haptic('tick')
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
          onChange(Math.max(0, value - 0.02))
          haptic('tick')
        }
      }}
      className={cnm('relative outline-none', className)}
      style={{
        height: 22,
        borderRadius: 11,
        cursor: dragging ? 'grabbing' : 'pointer',
        touchAction: 'none',
        background: 'linear-gradient(180deg, #121316 0%, #1d1f22 100%)',
        boxShadow: 'inset 0 2px 5px rgba(0,0,0,0.75), inset 0 -1px 0 rgba(255,255,255,0.05)',
      }}
    >
      {/* amber level fill */}
      <div
        className="pointer-events-none absolute left-0 top-0 h-full"
        style={{
          width: travel,
          borderRadius: '11px 4px 4px 11px',
          background: `linear-gradient(180deg, ${AMBER_HI} 0%, ${AMBER} 55%, #d98a12 100%)`,
          boxShadow: `inset 0 1px 0 rgba(255,255,255,0.45), 0 0 10px ${AMBER}55`,
        }}
      />
      {/* etched scale ticks across the groove */}
      <div
        className="pointer-events-none absolute inset-y-[6px] left-0 right-0"
        style={{
          backgroundImage:
            'repeating-linear-gradient(90deg, rgba(0,0,0,0.35) 0 1px, transparent 1px, transparent 10%)',
          opacity: 0.55,
          mixBlendMode: 'overlay',
        }}
      />
      {/* the fader cap */}
      <div
        className="pointer-events-none absolute top-1/2"
        style={{
          left: travel,
          width: FADER_THUMB,
          height: 30,
          transform: `translate(-50%, -50%) ${dragging ? 'scale(1.04)' : 'scale(1)'}`,
          borderRadius: 5,
          background: 'linear-gradient(180deg, #5a5f66 0%, #3d4046 48%, #2a2c30 100%)',
          boxShadow: `inset 0 1px 0 rgba(255,255,255,0.4), inset 0 -2px 3px rgba(0,0,0,0.5), 0 4px 8px -1px rgba(0,0,0,0.65)${dragging ? `, 0 0 0 1px ${AMBER}55` : ''}`,
          transition: 'transform 120ms cubic-bezier(0.2,0.7,0.2,1), box-shadow 160ms ease',
        }}
      >
        {/* grip ridges + a center index line */}
        <div
          className="absolute inset-x-[3px] top-1/2 -translate-y-1/2"
          style={{
            height: 16,
            backgroundImage:
              'repeating-linear-gradient(0deg, rgba(255,255,255,0.16) 0 1px, transparent 1px, transparent 3px)',
            borderRadius: 2,
          }}
        />
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
          style={{ width: 2, height: 20, borderRadius: 1, background: AMBER, boxShadow: `0 0 6px ${AMBER}` }}
        />
      </div>
    </div>
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
      aria-disabled={isDisabled || undefined}
      onClick={() => {
        if (isDisabled) {
          uiSfx('disabled')
          return
        }
        haptic('selection')
        uiSfx(isSelected ? 'toggleOff' : 'toggleOn')
        onChange(!isSelected)
      }}
      className={cnm('hw3d-toggle', className)}
    >
      <span className="hw3d-toggle-fill" />
      <span className="hw3d-toggle-thumb" />
    </button>
  )
}
