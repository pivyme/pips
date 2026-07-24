import { GAME_ICON_SRC } from '@/lib/gameIcons'
import { cnm } from '@/utils/style'

// Renders a play's game as its cartridge glyph (assets/games/*.svg), CSS-masked to currentColor so it
// tints with the surrounding text like any other icon. Renders nothing for an unknown game key.
export function GameIcon({ game, size = 16, className }: { game: string; size?: number; className?: string }) {
  const src = GAME_ICON_SRC[game]
  if (!src) return null
  return <MaskGlyph src={src} size={size} className={className} />
}

// Lower-level primitive: masks any single-color SVG to currentColor. Used directly where the source
// isn't a game key (e.g. a lucide icon mixed into the same row).
export function MaskGlyph({ src, size, className }: { src: string; size: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cnm('inline-block shrink-0 bg-current', className)}
      style={{
        width: size,
        height: size,
        maskImage: `url(${src})`,
        WebkitMaskImage: `url(${src})`,
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        maskPosition: 'center',
        WebkitMaskPosition: 'center',
      }}
    />
  )
}
