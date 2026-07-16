import { useState } from 'react'
import { cnm } from '@/utils/style'
import { avatarColor, avatarInitial } from '@/lib/avatar'

// One avatar component every surface uses. Renders the uploaded image when `src` is set; on a load
// error (a dead or blocked URL) or when there's no src, it falls back to the PIPS identicon: a bright
// deterministic disc with the handle's initial in Open Runde Bold. So a broken URL never shows a busted
// <img>, and a user with no photo still gets a distinct, on-brand avatar. `name` is the handle.
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
            fontSize: Math.round(size * 0.52),
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
