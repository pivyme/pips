import { createFileRoute } from '@tanstack/react-router'
import ConsoleCanvas from '@/components/console/ConsoleCanvas'

// Dev playground for tuning the device (lil-gui on). No game bound, so the screen is just black.
export const Route = createFileRoute('/dev/console')({ component: ConsolePage })

function ConsolePage() {
    return <ConsoleCanvas debug />
}
