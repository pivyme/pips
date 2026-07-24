import { createFileRoute } from '@tanstack/react-router'
import ConsoleCanvas from '@/components/console/ConsoleCanvas'

// Dev playground for tuning the device (lil-gui on). No game bound, so the screen is just black.
export const Route = createFileRoute('/dev/console')({ component: ConsolePage })

// The lil-gui tuning panel docks fixed at the top-right (280px wide). Reserve a gutter for it so the
// device auto-fits into the space beside it (it fits to this stage), instead of centering under the panel.
const GUI_GUTTER = 300

function ConsolePage() {
  return (
    <div className="relative h-dvh w-full overflow-hidden">
      <div className="absolute inset-y-0 left-0" style={{ right: GUI_GUTTER }}>
        <ConsoleCanvas debug />
      </div>
    </div>
  )
}
