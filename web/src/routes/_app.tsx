import { Outlet, createFileRoute, useMatchRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ConsoleTheme } from '@/components/console/themes'
import { AppFrame } from '@/components/console/AppFrame'
import { ConsoleControlsProvider, useConsoleView } from '@/components/console/controls'
import { ConsoleShell } from '@/components/console/ConsoleShell'
import ConsoleCanvas from '@/components/console/ConsoleCanvas'
import { MenuDrawer } from '@/components/console/MenuDrawer'
import { CustomizeStudio } from '@/components/console/CustomizeStudio'
import { themeBackdrop, useConsoleTheme } from '@/components/console/themes'
import { Illo } from '@/ui/Illo'
import { LoadingIcon } from '@/ui/LoadingIcon'
import { haptic } from '@/lib/haptics'
import { useAuth } from '@/lib/auth'

const BACKDROP_GAMES = [
  { illo: 'dice', title: 'I Feel Lucky', sub: 'Spin. Ride it. Cash out.' },
  { illo: 'target', title: 'Range', sub: 'Call the zone. Tighter pays more.' },
  { illo: 'bolt', title: 'Tap', sub: 'Tap the chart. Catch the move.' },
] as const

const LOADING_EXIT_DELAY_MS = 150
const LOADING_EXIT_DURATION_MS = 520

// Everything under the device (games + menu) shares one persistent shell.
// The landing route ("/") lives outside this and gets the full viewport.
export const Route = createFileRoute('/_app')({ component: AppLayout })

function AppLayout() {
  const { status } = useAuth()
  const [showLoadingScreen, setShowLoadingScreen] = useState(true)
  const [loadingScreenLeaving, setLoadingScreenLeaving] = useState(false)
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
  const onLineRider = Boolean(matchRoute({ to: '/games/line-rider' }))
  const onCandleHop = Boolean(matchRoute({ to: '/games/candle-hop' }))
  const on3D = Boolean(matchRoute({ to: '/games', fuzzy: true })) && !onTap
  // Customize takes over the device: the menu drawer slides away and the device drops into the
  // workshop studio. It rides the same persistent 3D branch so the WebGL stays warm.
  const onCustomize = Boolean(matchRoute({ to: '/menu/customize' }))
  // The saved skin. Feeds the live games device; the studio seeds from it and writes back on Done.
  const savedTheme = useConsoleTheme()
  // The ambient the whole frame floats on, derived from the skin so the surround stops being flat
  // black. We paint html + body (body shows under the safe-area inset behind iOS Safari's status
  // bar) and retint the theme-color meta, which is what Safari uses to color the notch/status strip.
  const backdrop = themeBackdrop(savedTheme.theme)
  useEffect(() => {
    const root = document.documentElement
    root.style.background = backdrop
    document.body.style.background = backdrop
    // Cache it so the pre-paint bootstrap (see __root) can tint the status bar before React mounts.
    try {
      localStorage.setItem('pips_console_backdrop', backdrop)
    } catch {
      // private mode / storage blocked: this effect still tints once mounted, just no pre-paint help.
    }

    // TanStack re-syncs <head> on every navigation and would reset theme-color to the static default,
    // so pin it: re-apply our color whenever the head changes (the meta gets mutated or replaced).
    const pin = () => {
      let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      if (!meta) {
        meta = document.createElement('meta')
        meta.name = 'theme-color'
        document.head.appendChild(meta)
      }
      if (meta.content !== backdrop) meta.content = backdrop
    }
    pin()
    const obs = new MutationObserver(pin)
    obs.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['content'] })

    return () => {
      obs.disconnect()
      root.style.background = ''
      document.body.style.background = ''
      const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      if (meta) meta.content = '#000000'
    }
  }, [backdrop])

  // Remember which shell was live before the menu opened, so the drawer's blurred backdrop (and
  // where Close returns) matches where the user came from. Pressing Menu on the 3D handheld must
  // keep that device behind, not drop to the CSS shell.
  const lastShell = useRef<'3d' | 'css'>('css')
  if (!onMenu) lastShell.current = on3D ? '3d' : 'css'
  const menuOver3D = onMenu && lastShell.current === '3d'

  // Where Close returns the menu: back to the device screen the user came from (the hub by default).
  const last3DPath = useRef('/games')
  if (!onMenu && on3D)
    last3DPath.current = onRange
      ? '/games/range'
      : onLucky
        ? '/games/lucky'
        : onLineRider
          ? '/games/line-rider'
          : onCandleHop
            ? '/games/candle-hop'
            : '/games'

  // Not signed in (enoki, signed out): send them back to the door. dev auto-logs-in, so
  // this only fires when there is genuinely no session.
  useEffect(() => {
    if (status === 'anon') void navigate({ to: '/' })
  }, [status, navigate])

  useEffect(() => {
    if (status !== 'authed') return

    const exitTimer = window.setTimeout(
      () => setLoadingScreenLeaving(true),
      LOADING_EXIT_DELAY_MS,
    )
    const removeTimer = window.setTimeout(
      () => setShowLoadingScreen(false),
      LOADING_EXIT_DELAY_MS + LOADING_EXIT_DURATION_MS,
    )

    return () => {
      window.clearTimeout(exitTimer)
      window.clearTimeout(removeTimer)
    }
  }, [status])

  if (status !== 'authed') {
    return <AppLoadingScreen />
  }

  const loadingScreen = showLoadingScreen ? (
    <AppLoadingScreen leaving={loadingScreenLeaving} />
  ) : null

  // The 3D handheld is the persistent shell for the games hub + the aperture games, and for the menu
  // opened over them. Keeping one Console3DRoute element mounted across screen<->menu means the WebGL
  // scene builds once instead of rebuilding on every toggle. Screen content only mounts on a 3D route.
  if (on3D || menuOver3D || onCustomize) {
    return (
      <>
        <AppFrame bg={backdrop}>
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
        {loadingScreen}
      </>
    )
  }

  return (
    <>
      <AppFrame bg={backdrop}>
        <ConsoleControlsProvider>
          <ConsoleShell>{onMenu ? <MenuBackdropScreen /> : <Outlet />}</ConsoleShell>
          {onMenu && (
            <MenuDrawer>
              <Outlet />
            </MenuDrawer>
          )}
        </ConsoleControlsProvider>
      </AppFrame>
      {loadingScreen}
    </>
  )
}

function AppLoadingScreen({ leaving = false }: { leaving?: boolean }) {
  return (
    <div
      className={
        leaving
          ? 'app-loading-screen app-loading-screen-leaving'
          : 'app-loading-screen'
      }
    >
      <LoadingIcon size={72} />
    </div>
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
