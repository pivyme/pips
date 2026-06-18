import { createFileRoute } from '@tanstack/react-router'

// Customize is a full takeover, not a drawer page: `_app` detects this route and renders the
// CustomizeStudio over the device (workshop backdrop, spinnable device, preset rail). The route
// itself paints nothing, so the menu drawer just slides away to reveal the studio.
export const Route = createFileRoute('/_app/menu/customize')({ component: () => null })
