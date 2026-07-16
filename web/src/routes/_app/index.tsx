import { createFileRoute } from '@tanstack/react-router'

// The root URL is the console shell: the door, onboarding, or the live app depending on auth state.
// This just anchors `/` onto the _app layout's shell (no remount), which moves signed-in users on to /games.
export const Route = createFileRoute('/_app/')({
  component: () => null,
})
