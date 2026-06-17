import { Outlet, createFileRoute, useMatchRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { AppFrame } from '@/components/console/AppFrame'
import { ConsoleControlsProvider } from '@/components/console/controls'
import { ConsoleShell } from '@/components/console/ConsoleShell'
import { MenuDrawer } from '@/components/console/MenuDrawer'
import { Illo } from '@/ui/Illo'
import { useAuth } from '@/lib/auth'

const BACKDROP_GAMES = [
  { illo: 'dice', title: 'I Feel Lucky', sub: 'Spin. Ride it. Cash out.' },
  { illo: 'target', title: 'Range', sub: 'Call the zone. Tighter pays more.' },
  { illo: 'bolt', title: 'Tap', sub: 'Tap the chart. Catch the move.' },
] as const

// Everything under the device (games + menu) shares one persistent shell.
// The landing route ("/") lives outside this and gets the full viewport.
export const Route = createFileRoute('/_app')({ component: AppLayout })

function AppLayout() {
  const { status } = useAuth()
  const navigate = useNavigate()
  const matchRoute = useMatchRoute()
  // The menu is a drawer over the device, not a screen inside it. When a /menu route is active we
  // render it through the drawer while a quiet game screen stays behind for the blur layer.
  const onMenu = Boolean(matchRoute({ to: '/menu', fuzzy: true }))

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
        <ConsoleShell>{onMenu ? <MenuBackdropScreen /> : <Outlet />}</ConsoleShell>
        {onMenu && (
          <MenuDrawer>
            <Outlet />
          </MenuDrawer>
        )}
      </ConsoleControlsProvider>
    </AppFrame>
  )
}

function MenuBackdropScreen() {
  return (
    <div aria-hidden="true" className="pointer-events-none flex h-full flex-col gap-3 p-4 opacity-95">
      <div className="flex items-baseline justify-between px-1 pt-2">
        <h1 className="text-2xl font-extrabold tracking-tight">Games</h1>
        <div className="flex items-center gap-1.5 text-xs font-semibold text-text-3">
          <span className="h-1.5 w-1.5 rounded-full bg-up" />
          Live now
        </div>
      </div>

      {BACKDROP_GAMES.map((game) => (
        <div key={game.title} className="card-neo flex items-center gap-3 p-3">
          <Illo name={game.illo} size={56} />
          <div className="min-w-0 flex-1">
            <span className="text-[17px] font-bold">{game.title}</span>
            <div className="text-sm text-text-2">{game.sub}</div>
          </div>
          <span className="text-lg text-text-3">›</span>
        </div>
      ))}
    </div>
  )
}
