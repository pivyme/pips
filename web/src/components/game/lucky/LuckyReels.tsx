import { useEffect, useRef, useState } from 'react'

import { haptic } from '@/lib/haptics'
import { slotLock } from '@/lib/sound'
import { cnm } from '@/utils/style'

export function Reel({
  index,
  label,
  pool,
  target,
  cycling,
  landing,
  stopAt,
  accent,
  last = false,
}: {
  index: number
  label: string
  pool: string[]
  target?: string
  cycling: boolean
  landing: boolean
  stopAt: number
  accent?: 'amber' | 'up' | 'down'
  last?: boolean
}) {
  const [shown, setShown] = useState<string>('?')
  const poolRef = useRef(pool)
  poolRef.current = pool

  useEffect(() => {
    if (!cycling) {
      setShown(target ?? '?')
      return
    }
    let stopped = false
    let i = index % poolRef.current.length
    const iv = setInterval(() => {
      if (!stopped) {
        const nextPool = poolRef.current
        i = (i + 1) % nextPool.length
        setShown(nextPool[i])
      }
    }, 60)
    const timeout =
      landing && target
        ? setTimeout(() => {
            stopped = true
            clearInterval(iv)
            setShown(target)
            haptic('rigid')
            slotLock(index, last)
          }, stopAt)
        : undefined
    return () => {
      clearInterval(iv)
      if (timeout) clearTimeout(timeout)
    }
  }, [cycling, index, landing, last, stopAt, target])

  const palette =
    accent === 'amber'
      ? {
          text: 'text-brand-500',
          bar: 'bg-brand-500',
          wash: 'bg-brand-500/10',
          glow: 'var(--color-brand-500)',
        }
      : accent === 'up'
        ? {
            text: 'text-up',
            bar: 'bg-up',
            wash: 'bg-up/10',
            glow: 'var(--color-up)',
          }
        : accent === 'down'
          ? {
              text: 'text-down',
              bar: 'bg-down',
              wash: 'bg-down/10',
              glow: 'var(--color-down)',
            }
          : {
              text: 'text-text',
              bar: 'bg-text-3',
              wash: '',
              glow: 'var(--color-text)',
            }
  const locked = !cycling && shown !== '?'

  return (
    <div
      className={cnm(
        'relative flex flex-1 flex-col items-center justify-center gap-2 overflow-hidden border-l border-line-strong bg-black px-2 py-4 first:border-l-0',
        locked && palette.wash,
      )}
    >
      <span className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-text-3">
        {label}
      </span>
      <span
        className={cnm(
          'tnum text-[34px] font-extrabold leading-none transition-colors duration-200',
          cycling ? 'text-text-2' : palette.text,
        )}
        style={locked ? { textShadow: `0 0 16px ${palette.glow}` } : undefined}
      >
        {shown}
      </span>
      <span
        className={cnm(
          'absolute inset-x-0 bottom-0 h-[3px] transition-opacity duration-200',
          palette.bar,
          locked ? 'opacity-100' : 'opacity-25',
        )}
      />
    </div>
  )
}
