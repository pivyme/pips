import { useState } from 'react'
import { cnm } from '@/utils/style'
import { avatarColor, avatarInitial, AVATAR_GLYPH_RATIO } from '@/lib/avatar'

// One avatar component every surface uses. Falls back to the PIPS identicon (a deterministic disc with
// the handle's initial) on a load error or missing src, so a broken URL or no photo never breaks the avatar.
export function Avatar({
  name,
  src,
  size = 40,
  className,
}: {
  name: string
  src?: string | null
  size?: number
  className?: string
}) {
  // Track the failed URL, not a bare boolean, so switching to a new src (e.g. right after an upload)
  // retries instead of staying stuck on the letter chip.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const showImg = Boolean(src) && failedSrc !== src
  const { bg, ink } = avatarColor(name)

  return (
    <div
      className={cnm('relative shrink-0 overflow-hidden rounded-full', className)}
      style={{ width: size, height: size }}
    >
      {showImg ? (
        <img
          src={src as string}
          alt=""
          width={size}
          height={size}
          draggable={false}
          onError={() => setFailedSrc(src ?? null)}
          className="h-full w-full object-cover"
        />
      ) : (
        <div
          aria-hidden
          className="flex h-full w-full items-center justify-center leading-none"
          style={{
            backgroundColor: bg,
            color: ink,
            fontSize: Math.round(size * AVATAR_GLYPH_RATIO),
            fontFamily: "'Open Runde', var(--font-sans)",
            fontWeight: 700,
          }}
        >
          {avatarInitial(name)}
        </div>
      )}
    </div>
  )
}
