import type { CSSProperties } from 'react'
import { cnm } from '@/utils/style'

type LoadingIconProps = {
  className?: string
  label?: string
  size?: number
}

// Two stacked svgs: a static body and a moving eyes layer. The eyes animate via a transform on the
// root <svg> (a composited HTML box) rather than an inner <g>, so the motion runs on the GPU instead
// of re-rasterizing the whole mark on the main thread every frame. Paths are inlined (no external
// <use> fetch) since this paints on first load.
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
        className="loading-icon-mark loading-icon-body"
        viewBox="0 0 395 567"
        aria-hidden="true"
      >
        <path
          d="M395 368.975C395 393.646 395 405.981 389.745 415.193C386.196 421.416 381.041 426.571 374.818 430.12C365.606 435.375 353.271 435.375 328.6 435.375H291.812C267.698 435.375 255.641 435.375 246.584 440.403C240.047 444.033 234.658 449.422 231.028 455.959C226 465.016 226 477.073 226 501.188C226 525.302 226 537.359 220.972 546.416C217.342 552.953 211.953 558.342 205.416 561.972C196.359 567 184.302 567 160.187 567H66.4C41.7295 567 29.3942 567 20.1817 561.745C13.9592 558.196 8.80399 553.041 5.25474 546.818C0 537.606 0 525.271 0 500.6V66.4C0 41.7295 0 29.3942 5.25474 20.1817C8.80399 13.9592 13.9592 8.80399 20.1817 5.25474C29.3942 0 41.7295 0 66.4 0H328.6C353.271 0 365.606 0 374.818 5.25474C381.041 8.80399 386.196 13.9592 389.745 20.1817C395 29.3942 395 41.7295 395 66.4V368.975Z"
          fill="white"
        />
      </svg>
      <svg
        className="loading-icon-mark loading-icon-eyes"
        viewBox="0 0 395 567"
        aria-hidden="true"
      >
        <rect x="132" y="288" width="66" height="86" rx="28" fill="black" />
        <rect x="279" y="288" width="66" height="86" rx="28" fill="black" />
      </svg>
    </span>
  )
}
