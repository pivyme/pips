import { createFileRoute, redirect } from '@tanstack/react-router'

// The door, the device, and onboarding now all live on ONE persistent console inside the `_app`
// shell, so there is no standalone landing page anymore. `/` just funnels into the shell, which
// renders the landing overlay for signed-out visitors and the onboarding flow for new accounts.
// `replace` keeps `/` out of history so Back from the app never bounces through here.
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/games', replace: true })
  },
})
