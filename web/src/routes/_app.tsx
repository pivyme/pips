import { createFileRoute, Outlet } from '@tanstack/react-router'
import { AppFrame } from '@/components/console/AppFrame'
import { ConsoleControlsProvider } from '@/components/console/controls'
import { ConsoleShell } from '@/components/console/ConsoleShell'

// Everything under the device (games + menu) shares one persistent shell.
// The landing route ("/") lives outside this and gets the full viewport.
export const Route = createFileRoute('/_app')({ component: AppLayout })

function AppLayout() {
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
