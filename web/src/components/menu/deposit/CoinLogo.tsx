import { useState } from 'react'
import { cnm } from '@/utils/style'

// Token + chain art, served straight from LI.FI's catalog (the same place the addresses come from) so we
// never ship an asset set that rots when a chain rebrands.
//
// It is remote art on a screen that must not break: a missing url, a 404, or a dead CDN all degrade to a
// monogram instead of a blank hole where the logo should be.
export function CoinLogo({
  src,
  name,
  size = 28,
  className,
}: {
  src?: string | null
  name: string
  size?: number
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  const box = { width: size, height: size }

  if (!src || failed) {
    return (
      <span
        aria-hidden
        className={cnm(
          'flex shrink-0 items-center justify-center rounded-full bg-white/[0.09] font-black text-text-2',
          className,
        )}
        style={{ ...box, fontSize: size * 0.42 }}
      >
        {name.slice(0, 1).toUpperCase()}
      </span>
    )
  }

  return (
    <img
      src={src}
      alt=""
      aria-hidden
      loading="lazy"
      onError={() => setFailed(true)}
      className={cnm('shrink-0 rounded-full bg-white/[0.06] object-contain', className)}
      style={box}
    />
  )
}
