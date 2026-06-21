import { createFileRoute } from '@tanstack/react-router'

// The root URL is the console shell itself: the door for signed-out visitors, onboarding for new
// accounts, the live app for signed-in ones. The shell is rendered by the _app layout, so this index
// route just anchors `/` onto it. That keeps the door and the games on ONE persistent device (no
// remount, so the login settle stays seamless) and lets the URL rest at the root when signed out.
// Signed-in users get moved on to the canonical /games hub by the phase machine in _app.tsx.
export const Route = createFileRoute('/_app/')({
  component: () => null,
})
