import { createFileRoute } from '@tanstack/react-router'
import ConsoleCanvas from '@/components/console/ConsoleCanvas'
import { THEME_BY_ID } from '@/components/console/themes'

// Showcase route for the transparent "Clear" (Nothing-style) device: frosted acrylic shell over exposed
// guts, on a dark bench. Debug mode keeps the tuning GUI handy and skips auth; isolated from /console so the molded device stays default there.
export const Route = createFileRoute('/console-transparent')({ component: ConsoleTransparentPage })

function ConsoleTransparentPage() {
  return <ConsoleCanvas debug theme={THEME_BY_ID['clear']} />
}
