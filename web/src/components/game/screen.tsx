import type { ReactNode } from 'react'
import { explorerTxUrl } from '@/lib/sui/config'
import { cnm } from '@/utils/style'

// Shared in-screen pieces for the games: the win/loss result moment and the markets
// empty/error message. Copy stays game-specific (passed in); the chrome is shared.

// The L-shaped aperture layout for the games that run on the device (web/CLAUDE.md "The
// console screen"). The rim inset lives here, once, so no game pads its own zones by hand:
// the chart bleeds full width, the top bar floats over its top edge, and a notch-safe
// readout band sits below (left-only, the bottom-right is the knob + PLAY body).
//
// The inset is --screen-rim, published by ConsoleCanvas per device scale (the 3D device is
// responsive, so a fixed px pad crops once it grows). Falls back to 24px for the CSS shell /
// pre-layout. Text zones inset by it; the chart bleeds full width and tucks under the rim.
const SCREEN_PAD = 'p-[var(--screen-rim,24px)]'

// Root: the black screen, a vertical flex stack that absorbs the responsive height stretch
// in the chart. Wrap the loading/empty states and the result overlay inside it too.
export function GameScreen({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-black text-text">{children}</div>
  )
}

// Zones 1+2: the chart fills the slack height (pass it as the child, positioned
// `absolute inset-0`), the top bar (`top`) floats over its top edge, padded off the rim.
export function GameStage({ top, children }: { top?: ReactNode; children: ReactNode }) {
  return (
    <div className="relative min-h-0 flex-1">
      {children}
      {top != null && <div className={cnm('pointer-events-none absolute inset-x-0 top-0', SCREEN_PAD)}>{top}</div>}
    </div>
  )
}

// Zone 3: the notch-safe readout band. Left-only and padded off the rim by the same inset
// as the top bar, so the play's numbers never crowd the bevel or the device body.
export function GameReadout({ children }: { children: ReactNode }) {
  return <div className={cnm('pointer-events-none max-w-[62%] space-y-2.5', SCREEN_PAD)}>{children}</div>
}

// CRT finish for the canvas minigames. The DOM screens (Home, Lucky, Range) get the "this is a
// powered display" look for free, from the screen surface (scanlines + vignette) and the per-glyph
// text bloom. A raw <canvas> field gets none of it and reads flat, so the minigames paint it on
// themselves. Drop it once inside GameScreen, after the stage and readout so it rides over the field
// but under the title/result overlays. Pointer-transparent, purely cosmetic.
export function ScreenCRT() {
  return (
    <div className="pointer-events-none absolute inset-0">
      {/* phosphor bloom: a soft screen-blend lift so the bright ink glows like a tube, not flat pixels */}
      <div
        className="absolute inset-0 mix-blend-screen"
        style={{ background: 'radial-gradient(120% 95% at 50% 40%, rgba(130,165,205,0.11), transparent 60%)' }}
      />
      {/* tv scanlines */}
      <div className="viz-scanlines absolute inset-0" />
      {/* edge falloff so the flat panel reads like a curved tube */}
      <div className="viz-vignette absolute inset-0" />
    </div>
  )
}

export function ResultOverlay({
  title,
  tone,
  digest,
  onDismiss,
}: {
  title: string
  tone: 'up' | 'down'
  digest?: string
  onDismiss: () => void
}) {
  return (
    <button
      type="button"
      onClick={onDismiss}
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/80 backdrop-blur-sm"
    >
      <div className={cnm('text-3xl font-extrabold', tone === 'up' ? 'text-up' : 'text-down')}>{title}</div>
      {digest && (
        <a
          href={explorerTxUrl(digest)}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-xs font-semibold text-text-3 underline underline-offset-4 transition-colors hover:text-text-2"
        >
          View on explorer
        </a>
      )}
      <span className="text-[11px] uppercase tracking-[0.1em] text-text-3">Tap to continue</span>
    </button>
  )
}

// One readout cell in a game's notch-safe bottom band: tiny label over a tabular value.
export function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-text-3">{label}</div>
      <div className="tnum text-base font-bold leading-tight text-text">{value}</div>
    </div>
  )
}

// The in-device empty/error/stale message. Teenage Engineering instrument language (docs/SCREEN.md):
// flat black, a red status dot, mono uppercase copy, and a sharp-cornered hairline RETRY, no rounded
// App-Surface card. Copy is passed in per game.
export function ScreenMessage({
  title,
  action,
  onAction,
}: {
  title: string
  action: string
  onAction: () => void
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <span className="h-1.5 w-1.5 rounded-full bg-down" />
      <p className="font-mono text-[13px] font-bold uppercase tracking-[0.16em] text-text-2">{title}</p>
      <button
        type="button"
        onClick={onAction}
        className="border border-line-strong px-4 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-brand-500 transition-colors hover:bg-brand-500 hover:text-black"
      >
        {action}
      </button>
    </div>
  )
}
