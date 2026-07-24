import { createFileRoute } from '@tanstack/react-router'
import ConsoleCanvas from '@/components/console/ConsoleCanvas'
import { DEFAULT_THEME } from '@/components/console/themes'

// Dev playground for tuning the device (lil-gui on). No game bound, so the screen is just black.
// Pinned to the stock Classic skin so it renders the exact device the app ships by default, instead
// of the bare material defaults (/dev/console-transparent is the alternate-skin showcase).
export const Route = createFileRoute('/dev/console')({ component: ConsolePage })

// The lil-gui tuning panel docks fixed at the top-right (280px wide). Reserve a gutter for it so the
// device auto-fits into the space beside it (it fits to this stage), instead of centering under the panel.
const GUI_GUTTER = 300

function ConsolePage() {
  return (
    <div className="relative h-dvh w-full overflow-hidden">
      <div className="absolute inset-y-0 left-0" style={{ right: GUI_GUTTER }}>
        <ConsoleCanvas debug theme={DEFAULT_THEME} />
      </div>
    </div>
  )
}
