// 3D illustration slot (docs/DESIGN.md §6). Renders the real art from
// /illustrations/<name>.webp when it lands, else a clean neumorphic placeholder
// with the right glow and footprint, so layouts never shift when assets arrive.
// Placeholders use emoji for now; swap the folder in, nothing else changes.
import { useState } from 'react'
import { cnm } from '@/utils/style'

type Glow = 'amber' | 'violet' | 'up' | 'down' | 'neutral'

const GLOW: Record<Glow, string> = {
  amber: 'rgba(255,192,22,0.35)',
  violet: 'rgba(154,45,246,0.35)',
  up: 'rgba(52,211,153,0.32)',
  down: 'rgba(255,90,77,0.32)',
  neutral: 'rgba(255,255,255,0.14)',
}

// Concept -> default emoji + glow, matching the DESIGN.md illustration library.
const LIBRARY: Record<string, { emoji: string; glow: Glow }> = {
  console: { emoji: '🎮', glow: 'amber' },
  coin: { emoji: '🪙', glow: 'amber' },
  up: { emoji: '🚀', glow: 'up' },
  down: { emoji: '🪂', glow: 'down' },
  target: { emoji: '🎯', glow: 'amber' },
  hourglass: { emoji: '⏳', glow: 'violet' },
  trophy: { emoji: '🏆', glow: 'amber' },
  flame: { emoji: '🔥', glow: 'amber' },
  bolt: { emoji: '⚡', glow: 'amber' },
  dice: { emoji: '🎲', glow: 'violet' },
  vault: { emoji: '🔐', glow: 'neutral' },
  gift: { emoji: '🎁', glow: 'violet' },
  medal: { emoji: '🎖️', glow: 'amber' },
  gem: { emoji: '💎', glow: 'violet' },
  gear: { emoji: '⚙️', glow: 'neutral' },
  cards: { emoji: '🃏', glow: 'amber' },
}

export interface IlloProps {
  name: string
  glow?: Glow
  size?: number
  emoji?: string
  alt?: string
  className?: string
  showGlow?: boolean
}

export function Illo({
  name,
  glow,
  size = 88,
  emoji,
  alt,
  className,
  showGlow = true,
}: IlloProps) {
  const [failed, setFailed] = useState(false)
  const def = LIBRARY[name] ?? { emoji: '✦', glow: 'neutral' }
  const g = glow ?? def.glow

  return (
    <div
      className={cnm(
        'relative inline-flex items-center justify-center',
        className,
      )}
      style={{ width: size, height: size }}
      aria-label={alt ?? name}
    >
      {showGlow && (
        <div
          className="pointer-events-none absolute inset-0 rounded-full blur-2xl"
          style={{ background: GLOW[g], transform: 'scale(0.9)' }}
        />
      )}
      {!failed ? (
        <img
          src={`/illustrations/${name}.webp`}
          alt={alt ?? name}
          width={size}
          height={size}
          className="relative z-10 object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <div
          className="card-neo relative z-10 flex items-center justify-center rounded-[28%]"
          style={{
            width: size,
            height: size,
            fontSize: size * 0.46,
            lineHeight: 1,
          }}
        >
          <span>{emoji ?? def.emoji}</span>
        </div>
      )}
    </div>
  )
}
