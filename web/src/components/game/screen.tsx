import type { ReactNode } from 'react'
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

// The full-screen info overlay every game shares (How to play, History). One shape so they all read
// identically: flat black, content top-aligned under a generous top inset (sits high, clears the rim),
// full-width rows, big readable type, header with the title + a close hint. The device screen is NOT
// clickable (it renders behind the 3D body, taps hit the physical controls), so the overlay is a pure
// readout: it opens and closes from the same physical button that toggled it. Scrolls if a long list
// outgrows the screen. Keeping this chrome in one place is what keeps the overlays consistent.
export function ScreenOverlay({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: ReactNode
}) {
  return (
    <div
      data-screen-overlay
      // pb clears the rim AND the occluded bottom-right body (--screen-notch): without it the last
      // section runs under the knob/PLAY corner and its right edge is hidden. The auto-fit (ConsoleCanvas
      // recomputeScreenFit) measures this and shrinks the whole panel so every line stays in the clear.
      className="absolute inset-0 z-20 flex flex-col gap-4 overflow-y-auto bg-black/96 px-[var(--screen-rim,24px)] pb-[calc(var(--screen-rim,24px)+var(--screen-notch,0px))] pt-[calc(var(--screen-rim,24px)+2.25rem)] text-left"
    >
      <div className="flex shrink-0 items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[20px] font-bold uppercase tracking-[0.16em] text-brand-500">{title}</div>
          {subtitle && (
            <div className="mt-1.5 font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-text-3">{subtitle}</div>
          )}
        </div>
        <span className="mt-1 shrink-0 text-right font-mono text-[10px] uppercase tracking-[0.12em] text-text-3">Press again to close</span>
      </div>
      {children}
    </div>
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

// The in-device empty/error/stale message. The device screen is NOT clickable, so there is no RETRY
// button to press: the underlying markets query auto-polls (fast while empty) and clears this the
// instant a market returns, so the only honest affordance is a passive "we're on it" pulse. Teenage
// Engineering instrument language (docs/SCREEN.md): flat black, a pulsing amber status dot, mono
// uppercase copy. Copy is passed in per game.
export function ScreenMessage({ title, hint = 'Reconnecting' }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
      <p className="font-mono text-[13px] font-bold uppercase tracking-[0.16em] text-text-2">{title}</p>
      <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-text-3">{hint}</p>
    </div>
  )
}
