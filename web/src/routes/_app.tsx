import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { AppFrame } from '@/components/console/AppFrame'
import { ConsoleControlsProvider } from '@/components/console/controls'
import { ConsoleShell } from '@/components/console/ConsoleShell'
import { Illo } from '@/ui/Illo'
import { useAuth } from '@/lib/auth'

// Everything under the device (games + menu) shares one persistent shell.
// The landing route ("/") lives outside this and gets the full viewport.
export const Route = createFileRoute('/_app')({ component: AppLayout })

function AppLayout() {
  const { status } = useAuth()
  const navigate = useNavigate()

  // Not signed in (enoki, signed out): send them back to the door. dev auto-logs-in, so
  // this only fires when there is genuinely no session.
  useEffect(() => {
    if (status === 'anon') void navigate({ to: '/' })
  }, [status, navigate])

  if (status !== 'authed') {
    return (
      <AppFrame>
        <div className="flex h-full flex-col items-center justify-center gap-4 bg-black">
          <Illo name="console" size={88} />
          <p className="text-sm text-text-3">{status === 'error' ? 'Could not connect' : 'Warming up'}</p>
        </div>
      </AppFrame>
    )
  }

  return (
    <AppFrame>
      <ConsoleControlsProvider>
        <ConsoleShell>
          <Outlet />
        </ConsoleShell>
      </ConsoleControlsProvider>
    </AppFrame>
  )
}
