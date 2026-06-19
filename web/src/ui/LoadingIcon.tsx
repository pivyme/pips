import type { CSSProperties } from 'react'
import { cnm } from '@/utils/style'

type LoadingIconProps = {
  className?: string
  label?: string
  size?: number
}

export function LoadingIcon({
  className,
  label = 'Loading',
  size = 48,
}: LoadingIconProps) {
  return (
    <span
      className={cnm('loading-icon', className)}
      style={{ '--loading-icon-size': `${size}px` } as CSSProperties}
      role="status"
    >
      <span className="sr-only">{label}</span>
      <svg
        className="loading-icon-mark"
        viewBox="0 0 395 567"
        aria-hidden="true"
      >
        <use href="/pips-white.svg#pips-body" />
        <g className="loading-icon-eyes">
          <use href="/pips-white.svg#pips-eyes" />
        </g>
      </svg>
    </span>
  )
}
