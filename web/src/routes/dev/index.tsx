import { Link, createFileRoute } from '@tanstack/react-router'
import { ArrowUpRight, AudioLines, Camera, Gamepad2, Palette, Scan } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Dev hub: every internal tool/playground page in one grid. Adding a dev page? Drop the route
// in routes/dev/ and list it here with its own icon + tint so it stays scannable.
export const Route = createFileRoute('/dev/')({ component: DevHub })

const PAGES: { to: string; name: string; desc: string; tag: string; Icon: LucideIcon; tint: string; tile: string }[] = [
  { to: '/dev/console', name: 'Console Lab', desc: 'The 3D device with lil-gui tuning on. No game bound, screen stays black.', tag: 'device', Icon: Gamepad2, tint: 'text-brand-500', tile: 'bg-brand-500/12' },
  { to: '/dev/console-transparent', name: 'Console Clear', desc: 'The transparent "Clear" skin showcase: frosted shell over exposed guts.', tag: 'device', Icon: Scan, tint: 'text-info', tile: 'bg-info/12' },
  { to: '/dev/design-system', name: 'Design System', desc: 'Living UI-kit reference: tokens, instruments, App Surface patterns.', tag: 'ui', Icon: Palette, tint: 'text-premium-500', tile: 'bg-premium-500/12' },
  { to: '/dev/export', name: 'Export Studio', desc: 'PNG asset dump: bare device per skin, game screens, screen-only shots.', tag: 'tooling', Icon: Camera, tint: 'text-up', tile: 'bg-up/12' },
  { to: '/dev/sounds', name: 'Sound Lab', desc: 'Every music bed and SFX in one audition bench, grouped per game.', tag: 'audio', Icon: AudioLines, tint: 'text-down', tile: 'bg-down/12' },
]

function DevHub() {
  return (
    <div className="min-h-dvh bg-canvas px-5 py-10 text-text sm:px-8">
      <div className="mx-auto max-w-4xl">
        <header className="flex items-end justify-between gap-4 border-b border-line-strong pb-5">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-wider text-text-3">Internal</p>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight">PIPS Dev</h1>
          </div>
          <Link
            to="/games"
            className="border border-line-strong px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-text-2 transition hover:text-text"
          >
            To console
          </Link>
        </header>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {PAGES.map(({ to, name, desc, tag, Icon, tint, tile }) => (
            <Link
              key={to}
              to={to}
              className="group flex flex-col border border-line-strong p-4 transition hover:border-brand-500/60 hover:bg-surface"
            >
              <div className="flex items-start justify-between gap-2">
                <span className={`flex h-10 w-10 items-center justify-center ${tile}`}>
                  <Icon size={20} className={tint} />
                </span>
                <ArrowUpRight size={14} className="text-text-3 transition group-hover:text-brand-500" />
              </div>
              <h2 className="mt-3 text-base font-bold tracking-tight">{name}</h2>
              <p className="mt-1 flex-1 text-[13px] leading-snug text-text-2">{desc}</p>
              <div className="mt-3 flex items-center justify-between gap-2 font-mono text-[11px] text-text-3">
                <span>{to}</span>
                <span className="uppercase tracking-wider">{tag}</span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
