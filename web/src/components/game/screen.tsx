import type { ReactNode } from 'react'
import { cnm } from '@/utils/style'

// Shared in-screen pieces for the games: the win/loss result moment and the markets
// empty/error message. Copy stays game-specific (passed in); the chrome is shared.

// L-shaped aperture layout (web/CLAUDE.md "The console screen"): chart bleeds full width, top bar floats over its top edge, notch-safe readout sits below left-only (bottom-right is the knob + PLAY body).
// --screen-rim (from ConsoleCanvas, responsive) insets text zones; structural fills bleed full width under it.
const SCREEN_PAD = 'p-[var(--screen-rim,24px)]'

// Root: the black screen, a vertical flex stack absorbing the responsive height stretch in the chart;
// wrap loading/empty states and the result overlay inside it too.
export function GameScreen({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-black text-text">{children}</div>
  )
}

// Zones 1+2: the chart fills the slack height (child, `absolute inset-0`), the top bar (`top`) floats over its top edge, padded off the rim.
export function GameStage({ top, children }: { top?: ReactNode; children: ReactNode }) {
  return (
    <div className="relative min-h-0 flex-1">
      {children}
      {top != null && <div className={cnm('pointer-events-none absolute inset-x-0 top-0', SCREEN_PAD)}>{top}</div>}
    </div>
  )
}

// Zone 3: the notch-safe readout band, left-only, padded off the rim by the same inset as the top bar so numbers never crowd the bevel or device body.
export function GameReadout({ children }: { children: ReactNode }) {
  return <div className={cnm('pointer-events-none max-w-[62%] space-y-2.5', SCREEN_PAD)}>{children}</div>
}

// CRT finish for the canvas minigames: DOM screens get the powered-display look for free from the
// screen surface (scanlines + vignette), but a raw <canvas> reads flat, so minigames paint it on themselves. Pointer-transparent, cosmetic.
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

// Shared full-screen info overlay (How to play, History): flat black, top-aligned content, full-width rows, big type, header with title + close hint.
// The device screen isn't clickable, so this is a pure readout opened/closed by the same physical button; scrolls if a long list outgrows the screen.
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
      // pb clears the rim AND the occluded bottom-right body (--screen-notch), else the last section runs under the knob/PLAY corner.
      // ConsoleCanvas recomputeScreenFit measures this and shrinks the panel so every line stays clear.
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
export function Cell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-text-3">{label}</div>
      <div className="tnum text-base font-bold leading-tight text-text">{value}</div>
    </div>
  )
}

// In-device empty/error/stale message: no RETRY button (the screen isn't clickable), the markets query auto-polls and clears this the instant a market returns.
// Passive pulse only (docs/SCREEN.md style: flat black, amber status dot, mono uppercase copy).
export function ScreenMessage({ title, hint = 'Reconnecting' }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
      <p className="font-mono text-[13px] font-bold uppercase tracking-[0.16em] text-text-2">{title}</p>
      <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-text-3">{hint}</p>
    </div>
  )
}
