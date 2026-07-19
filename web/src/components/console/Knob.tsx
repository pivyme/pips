// The knurled knob, treated as a vertical slider: drag up to raise, down to lower, each step crossed ticks a haptic detent, like a weighted control.
// The shell owns it; the active screen supplies range/value via the knob binding.
import { useRef } from 'react'
import { cnm } from '@/utils/style'
import { haptic } from '@/lib/haptics'
import type { KnobSpec } from './controls'

const PX_PER_STEP = 7 // drag sensitivity: ~7px of travel per step

type KnobView = Omit<KnobSpec, 'onChange'> | null

export function Knob({ spec, onChange }: { spec: KnobView; onChange: (v: number) => void }) {
  const drag = useRef<{ y: number; value: number } | null>(null)
  const unavailable = !spec

  const clampSnap = (v: number) => {
    if (!spec) return v
    const snapped = Math.round(v / spec.step) * spec.step
    return Math.min(spec.max, Math.max(spec.min, Number(snapped.toFixed(6))))
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!spec) return
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    drag.current = { y: e.clientY, value: spec.value }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || !spec) return
    const dy = drag.current.y - e.clientY // up = positive
    const steps = Math.round(dy / PX_PER_STEP)
    const next = clampSnap(drag.current.value + steps * spec.step)
    if (next !== spec.value) {
      haptic('tick') // subtle detent, distinct from a button tap
      onChange(next)
    }
  }

  const end = (e: React.PointerEvent) => {
    drag.current = null
    try {
      ;(e.currentTarget as Element).releasePointerCapture(e.pointerId)
    } catch {}
  }

  // Keyboard operability for the slider role: arrows step, Home/End jump.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!spec) return
    let next: number
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        next = clampSnap(spec.value + spec.step)
        break
      case 'ArrowDown':
      case 'ArrowLeft':
        next = clampSnap(spec.value - spec.step)
        break
      case 'Home':
        next = spec.min
        break
      case 'End':
        next = spec.max
        break
      default:
        return
    }
    e.preventDefault()
    if (next !== spec.value) {
      haptic('selection')
      onChange(next)
    }
  }

  const pct = spec && spec.max > spec.min ? (spec.value - spec.min) / (spec.max - spec.min) : 0
  return (
    <div className="flex flex-1 flex-col items-center justify-end">
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={onKeyDown}
        className={cnm(
          'relative w-full flex-1 touch-none overflow-hidden rounded-md border border-line-strong',
          unavailable ? 'opacity-40' : 'cursor-ns-resize',
        )}
        style={{ background: 'linear-gradient(180deg,#2a2a2a,#161616)' }}
        role="slider"
        tabIndex={unavailable ? -1 : 0}
        aria-valuenow={spec?.value}
        aria-valuemin={spec?.min}
        aria-valuemax={spec?.max}
        aria-label={spec?.label}
      >
        {/* fill from the bottom showing position in range */}
        <div
          className="absolute inset-x-0 bottom-0 bg-brand-500/15"
          style={{ height: `${Math.round(pct * 100)}%` }}
        />
        {/* knurled ridges */}
        <div className="knurl absolute inset-0" />
        {/* current notch */}
        <div
          className="absolute inset-x-1 h-[3px] rounded-full bg-brand-500 shadow-[0_0_8px_rgba(255,192,22,0.6)]"
          style={{ bottom: `calc(${Math.round(pct * 100)}% - 1.5px)` }}
        />
      </div>
    </div>
  )
}
