import { createFileRoute, Link } from '@tanstack/react-router'
import { Illo } from '@/ui/Illo'
import { config } from '@/config'

// Landing is the one full-width surface. Just hero + footer, one screen, no
// scroll on desktop. The door in. (Auth gets wired onto "Enter" in Phase 2.)
export const Route = createFileRoute('/')({ component: Landing })

function Landing() {
  return (
    <div className="flex min-h-dvh flex-col bg-black">
      <main className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <Illo name="console" size={148} />
        <h1 className="mt-7 text-5xl font-extrabold tracking-tight sm:text-6xl">Pips</h1>
        <p className="mt-3 max-w-sm text-lg text-text-2">{config.tagline}</p>
        <p className="mt-1 max-w-xs text-sm text-text-3">No charts to read. No jargon. Just plays.</p>
        <Link
          to="/games"
          className="btn-primary mt-9 flex h-14 w-full max-w-xs items-center justify-center rounded-full text-base"
        >
          Enter
        </Link>
      </main>
      <footer className="flex items-center justify-between px-6 py-5 text-xs text-text-3">
        <span>Built on Sui · DeepBook Predict</span>
        <a href={config.links.github} target="_blank" rel="noreferrer" className="transition-colors hover:text-text-2">
          GitHub
        </a>
      </footer>
    </div>
  )
}
