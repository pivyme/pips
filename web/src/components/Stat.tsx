import { useEffect, useRef } from 'react'
import { cnm } from '@/utils/style'
import { useReducedMotion } from '@/hooks/useReducedMotion'

// Tabular rolling number. Counts up/down to a new value on change instead of snapping, which
// is what makes a PnL climb or a balance tick feel alive. Drives a single span's textContent
// from a rAF loop so React never re-renders mid-roll. Reduced motion snaps straight to value.
interface StatProps {
  value: number
  prefix?: string
  suffix?: string
  decimals?: number
  duration?: number
  className?: string
}

function ease(t: number): number {
  return 1 - Math.pow(1 - t, 3) // ease-out cubic, settles soft
}

export function Stat({ value, prefix = '', suffix = '', decimals = 2, duration = 450, className }: StatProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const fromRef = useRef(value)
  const rafRef = useRef<number | null>(null)
  const reduced = useReducedMotion()

  const fmt = (n: number): string =>
    `${prefix}${n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${suffix}`

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const from = fromRef.current
    const to = value
    if (reduced || from === to) {
      el.textContent = fmt(to)
      fromRef.current = to
      return
    }

    let start: number | null = null
    const tick = (now: number) => {
      if (start === null) start = now
      const t = Math.min(1, (now - start) / duration)
      const cur = from + (to - from) * ease(t)
      el.textContent = fmt(cur)
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        fromRef.current = to
      }
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
    // fmt is derived from the same primitive props; re-running on value change is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, decimals, duration, reduced, prefix, suffix])

  return (
    <span ref={ref} className={cnm('tnum', className)}>
      {fmt(value)}
    </span>
  )
}
