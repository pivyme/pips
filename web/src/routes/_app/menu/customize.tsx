import { createFileRoute } from '@tanstack/react-router'

// Customize is a full takeover, not a drawer page: `_app` detects this route and renders CustomizeStudio
// over the device. The route itself paints nothing, so the menu drawer just slides away to reveal it.
export const Route = createFileRoute('/_app/menu/customize')({ component: () => null })
