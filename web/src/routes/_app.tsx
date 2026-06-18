import { Outlet, createFileRoute, useMatchRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { AppFrame } from '@/components/console/AppFrame'
import { ConsoleControlsProvider, useConsoleView } from '@/components/console/controls'
import { ConsoleShell } from '@/components/console/ConsoleShell'
import ConsoleCanvas from '@/components/console/ConsoleCanvas'
import { MenuDrawer } from '@/components/console/MenuDrawer'
import { CustomizeStudio } from '@/components/console/CustomizeStudio'
import { useConsoleTheme, type ConsoleTheme } from '@/components/console/themes'
import { Illo } from '@/ui/Illo'
import { haptic } from '@/lib/haptics'
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
  // render it through the drawer while the shell behind it stays put for the blur layer.
  const onMenu = Boolean(matchRoute({ to: '/menu', fuzzy: true }))
  // The 3D handheld now hosts the games hub (the selectable list) and the games laid out for the
  // L-shaped aperture (Lucky, Range). Tap still runs on the CSS shell until its tap-the-chart
  // surface is migrated, so it is the one /games route that stays off the device.
  const onTap = Boolean(matchRoute({ to: '/games/tap' }))
  const onRange = Boolean(matchRoute({ to: '/games/range' }))
  const onLucky = Boolean(matchRoute({ to: '/games/lucky' }))
  const on3D = Boolean(matchRoute({ to: '/games', fuzzy: true })) && !onTap
  // Customize takes over the device: the menu drawer slides away and the device drops into the
  // workshop studio. It rides the same persistent 3D branch so the WebGL stays warm.
  const onCustomize = Boolean(matchRoute({ to: '/menu/customize' }))
  // The saved skin. Feeds the live games device; the studio seeds from it and writes back on Done.
  const savedTheme = useConsoleTheme()

  // Remember which shell was live before the menu opened, so the drawer's blurred backdrop (and
  // where Close returns) matches where the user came from. Pressing Menu on the 3D handheld must
  // keep that device behind, not drop to the CSS shell.
  const lastShell = useRef<'3d' | 'css'>('css')
  if (!onMenu) lastShell.current = on3D ? '3d' : 'css'
  const menuOver3D = onMenu && lastShell.current === '3d'

  // Where Close returns the menu: back to the device screen the user came from (the hub by default).
  const last3DPath = useRef('/games')
  if (!onMenu && on3D) last3DPath.current = onRange ? '/games/range' : onLucky ? '/games/lucky' : '/games'

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

  // The 3D handheld is the persistent shell for the games hub + the aperture games, and for the menu
  // opened over them. Keeping one Console3DRoute element mounted across screen<->menu means the WebGL
  // scene builds once instead of rebuilding on every toggle. Screen content only mounts on a 3D route.
  if (on3D || menuOver3D || onCustomize) {
    return (
      <AppFrame>
        <ConsoleControlsProvider>
          {onCustomize ? (
            <CustomizeStudio
              initialThemeId={savedTheme.id}
              onDone={(id) => {
                savedTheme.setId(id)
                void navigate({ to: '/games' })
              }}
              onCancel={() => void navigate({ to: '/menu' })}
            />
          ) : (
            <Console3DRoute theme={savedTheme.theme}>{on3D ? <Outlet /> : null}</Console3DRoute>
          )}
          {/* The drawer slides itself away (closeTo) when Customize is tapped, then the studio takes
              over, so the device is revealed settling into the workshop. */}
          {onMenu && !onCustomize && (
            <MenuDrawer returnTo={last3DPath.current}>
              <Outlet />
            </MenuDrawer>
          )}
        </ConsoleControlsProvider>
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

// The 3D handheld as the live shell. It reads the controls the screen registered and renders the
// screen content on the device's screen; the physical knob/buttons drive the game. The screen
// content is passed in (the active game's Outlet, or nothing while the menu sits over the device).
function Console3DRoute({ children, theme }: { children?: ReactNode; theme?: ConsoleTheme }) {
  const { view, handlers } = useConsoleView()
  const navigate = useNavigate()
  const onNav = useCallback(
    (tab: 'MENU' | 'GAMES') => {
      haptic('selection')
      void navigate({ to: tab === 'MENU' ? '/menu' : '/games' })
    },
    [navigate],
  )
  return (
    <ConsoleCanvas view={view} handlers={handlers} onNav={onNav} theme={theme}>
      {children}
    </ConsoleCanvas>
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
