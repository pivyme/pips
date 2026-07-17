import { Outlet, createFileRoute, useMatchRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { ConsoleTheme } from '@/components/console/themes'
import { Route as GamesRoute } from './_app/games/index'
import { Route as LuckyRoute } from './_app/games/lucky'
import { Route as RangeRoute } from './_app/games/range'
import { Route as RangeV2Route } from './_app/games/range-v2'
import { Route as MoonshotRoute } from './_app/games/moonshot'
import { Route as LineRiderRoute } from './_app/games/line-rider'
import { Route as FlappyPiperRoute } from './_app/games/flappy-piper'
import { AppFrame } from '@/components/console/AppFrame'
import { ActivePlayChip } from '@/components/console/ActivePlayChip'
import { AchievementCelebration } from '@/components/AchievementCelebration'
import { AchievementDetailProvider } from '@/components/menu/AchievementDetail'
import { ConsoleControlsProvider, DeviceSettledProvider, useConsoleView } from '@/components/console/controls'
import ConsoleCanvas from '@/components/console/ConsoleCanvas'
import { MenuDrawer } from '@/components/console/MenuDrawer'
import { CustomizeStudio } from '@/components/console/CustomizeStudio'
import { LandingOverlay, AttractScreen } from '@/components/console/LandingOverlay'
import { InstallGate } from '@/components/InstallGate'
import { UsernameScreen, ThemePicker, WelcomeScreen } from '@/components/console/Onboarding'
import { TourProvider } from '@/components/console/tour'
import { DEFAULT_THEME_ID, THEME_BY_ID, themeBackdrop, useConsoleTheme } from '@/components/console/themes'
import { LoadingIcon } from '@/ui/LoadingIcon'
import { haptic } from '@/lib/haptics'
import { api } from '@/lib/api'
import { LivePresenceProvider } from '@/lib/presence'
import { ActivePlayProvider } from '@/lib/activePlay'
import { useAuth, loadToken } from '@/lib/auth'
import { useInstallGate } from '@/lib/platform'
import { isDemo } from '@/lib/demo'
import { refreshDeployedConfig } from '@/lib/sui/config'
import { env } from '@/env'
import { useReducedMotion } from '@/hooks/useReducedMotion'

const LOADING_EXIT_DELAY_MS = 150
const LOADING_EXIT_DURATION_MS = 520
// Mirrors ConsoleCanvas's HERO_MS (kept in sync by hand); screens hold content until the device settles.
const DEVICE_SETTLE_MS = 900

// Pre-paint on the client (no-op on server) so the returning-session decision lands in the first frame, no door/zoom flash on refresh.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

const routeComponent = (route: { options: { component?: ComponentType } }): ComponentType =>
  route.options.component as ComponentType

// Aperture games keyed by route path. Mounted directly here (not through the Outlet) so opening /menu never unmounts the live game screen and flashes the device black.
const DEVICE_SCREENS: Record<string, ComponentType> = {
  '/games': routeComponent(GamesRoute),
  '/games/lucky': routeComponent(LuckyRoute),
  '/games/range': routeComponent(RangeRoute),
  '/games/range-v2': routeComponent(RangeV2Route),
  '/games/moonshot': routeComponent(MoonshotRoute),
  '/games/line-rider': routeComponent(LineRiderRoute),
  '/games/flappy-piper': routeComponent(FlappyPiperRoute),
}

type OnboardingStep = 'username' | 'customize' | 'welcome'

// Landing, onboarding, and games+menu are phases of ONE persistent console shell (never separate route trees), so the 3D device instance survives the whole arc with no remount.
// The landing route ("/") just redirects here.
export const Route = createFileRoute('/_app')({ component: AppLayout })

function AppLayout() {
  const { status, user, recovering, refresh } = useAuth()
  const reduced = useReducedMotion()
  // Add-to-Home-Screen guide: an opaque overlay, active only on a mobile browser not yet installed/skipped.
  const gate = useInstallGate()
  // Warms the 3D console under the install gate so dismissing it reveals the device instantly, deferred a beat while the gate is up so it paints first.
  // Sticky once mounted, so toggling the gate never thrashes the WebGL scene.
  const [mountConsole, setMountConsole] = useState(false)
  useEffect(() => {
    if (mountConsole) return
    if (!gate.active) {
      setMountConsole(true)
      return
    }
    const t = window.setTimeout(() => setMountConsole(true), 300)
    return () => window.clearTimeout(t)
  }, [gate.active, mountConsole])
  const [showLoadingScreen, setShowLoadingScreen] = useState(true)
  const [loadingScreenLeaving, setLoadingScreenLeaving] = useState(false)
  const [customizePrepared, setCustomizePrepared] = useState(false)
  const [customizeOpening, setCustomizeOpening] = useState(false)
  const [customizeHandoff, setCustomizeHandoff] = useState(false)
  const navigate = useNavigate()
  const matchRoute = useMatchRoute()
  // The menu is a drawer over the device, not a screen inside it; the shell stays mounted behind it for the blur layer.
  const onMenu = Boolean(matchRoute({ to: '/menu', fuzzy: true }))
  const onRange = Boolean(matchRoute({ to: '/games/range' }))
  const onRangeV2 = Boolean(matchRoute({ to: '/games/range-v2' }))
  const onLucky = Boolean(matchRoute({ to: '/games/lucky' }))
  const onMoonshot = Boolean(matchRoute({ to: '/games/moonshot' }))
  const onLineRider = Boolean(matchRoute({ to: '/games/line-rider' }))
  const onFlappyPiper = Boolean(matchRoute({ to: '/games/flappy-piper' }))
  const on3D = Boolean(matchRoute({ to: '/games', fuzzy: true }))
  // Customize takes over the device (drawer slides away, workshop studio drops in) on the same persistent 3D branch, so WebGL stays warm.
  const onCustomize = Boolean(matchRoute({ to: '/menu/customize' }))
  // The saved skin. Feeds the live games device; the studio + onboarding seed from it and write back.
  const savedTheme = useConsoleTheme()
  // Theme syncs from the server on first authenticated frame per account, but only adopts a NON-default server pick, so a pre-sync local choice (or the shared demo user) is never clobbered back to Classic.
  // setId is unstable (closes over the stored value), so it's read through a ref.
  const savedThemeRef = useRef(savedTheme)
  savedThemeRef.current = savedTheme
  const themeHydratedFor = useRef<string | null>(null)
  // Adopts the live deploy ids (the DUSDC coin type) from the backend on boot, so a backend re-deploy never needs a frontend rebuild.
  // Demo has no backend, so it keeps the compile-time value.
  useEffect(() => {
    if (!isDemo()) void refreshDeployedConfig()
  }, [])
  useEffect(() => {
    if (!user) {
      themeHydratedFor.current = null
      return
    }
    if (themeHydratedFor.current === user.id) return
    themeHydratedFor.current = user.id
    const serverTheme = user.settings.theme
    const st = savedThemeRef.current
    // Own-property check: the server theme is free-form, so reject anything outside the catalog (blocks a prototype key like "constructor" from slipping through).
    const known = serverTheme ? Object.prototype.hasOwnProperty.call(THEME_BY_ID, serverTheme) : false
    if (known && serverTheme !== DEFAULT_THEME_ID && serverTheme !== st.id) {
      st.setId(serverTheme)
    }
  }, [user])
  // The ambient the frame floats on, derived from the skin. Paints html + body (body shows under iOS Safari's safe-area status bar) and retints the theme-color meta that Safari uses for the notch/status strip.
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

    // TanStack re-syncs <head> on every navigation, resetting theme-color; pin it by re-applying our color whenever the head mutates.
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

  // Tracks which game the device mounts (held across menu open so the chart never blinks) and where Close returns to; mounted by path, not the Outlet.
  const last3DPath = useRef('/games')
  if (!onMenu && on3D)
    last3DPath.current = onRangeV2
      ? '/games/range-v2'
      : onRange
      ? '/games/range'
      : onLucky
        ? '/games/lucky'
        : onMoonshot
          ? '/games/moonshot'
          : onLineRider
            ? '/games/line-rider'
            : onFlappyPiper
              ? '/games/flappy-piper'
              : '/games'
  const DeviceScreen = DEVICE_SCREENS[last3DPath.current]

  // Phase machine: landing (door) -> onboarding (new account) -> app, all phases of one persistent shell; `entered` gates the door and onboardedRef latches onboarding done, both reset on sign-out.
  // A stored token means a returning session: skip the door/zoom and hold the settled app pose (unless onboardingDebug, which forces the real first-run arc for QA).
  const onboardingDebug = env.VITE_ONBOARDING_DEBUG === 'true'
  const [entered, setEntered] = useState(false)
  const [restoredSession, setRestoredSession] = useState(false)
  useIsoLayoutEffect(() => {
    if (!isDemo() && !onboardingDebug && loadToken() != null) {
      setEntered(true)
      setRestoredSession(true)
    }
  }, [])
  const onboardedRef = useRef(false)
  const enteredAndAuthed = entered && status === 'authed'
  const needsOnboarding =
    enteredAndAuthed && !!user && (onboardingDebug || user.username == null) && !onboardedRef.current
  const [onboarding, setOnboarding] = useState(false)
  const [step, setStep] = useState<OnboardingStep>('username')
  const [chosenName, setChosenName] = useState('')
  // Latched true when a fresh account finishes onboarding, so the console tour auto-runs once on the home screen.
  const [justOnboarded, setJustOnboarded] = useState(false)
  // Welcome (final onboarding beat) sub-state: the skin step's Done snap already lands the device at the app pose with a black screen, so welcome is pure screen content.
  // `revealed` flips after a short black hold, gating the splash content + jingle fade-in.
  const [welcomeRevealed, setWelcomeRevealed] = useState(false)
  // Sign-out (incl. onboarding Log out) resets the gate so the next sign-in starts onboarding fresh, never mid-flow.
  // A stale token that fails to restore (401 -> anon, or error) also drops the no-animation path so the door returns normally.
  useEffect(() => {
    if (status === 'anon' || status === 'error') setRestoredSession(false)
    if (status === 'anon') {
      setEntered(false)
      onboardedRef.current = false
      setOnboarding(false)
      setStep('username')
      setChosenName('')
      setWelcomeRevealed(false)
      setJustOnboarded(false)
    }
  }, [status])
  useEffect(() => {
    if (needsOnboarding && !onboarding) {
      setOnboarding(true)
      setStep('username')
    }
  }, [needsOnboarding, onboarding])

  const phase: 'landing' | 'onboarding' | 'app' =
    !enteredAndAuthed ? 'landing' : onboarding ? 'onboarding' : 'app'

  // Keeps the URL honest with the phase: signed out -> door at root, signed in -> canonical /games hub (menu is only ever a drawer, never a standalone page), mid-onboarding strips a stray /menu.
  // Skipped while auth is resolving so a returning session isn't bounced off /games during the loading veil.
  useEffect(() => {
    if (status === 'loading') return
    if (phase === 'landing') {
      if (!matchRoute({ to: '/' })) void navigate({ to: '/', replace: true })
    } else if (phase === 'app') {
      if (matchRoute({ to: '/' })) void navigate({ to: '/games', replace: true })
    } else if (phase === 'onboarding' && onMenu) {
      void navigate({ to: '/games', replace: true })
    }
  }, [status, phase, onMenu, navigate, matchRoute])

  // Welcome dismissed: leave onboarding and refresh here (not at the username step) so the user object stays "not onboarded" through every step, and the phase can't jump to app mid-flow.
  const finishOnboarding = useCallback(() => {
    onboardedRef.current = true
    setOnboarding(false)
    setWelcomeRevealed(false)
    setJustOnboarded(true)
    void refresh()
  }, [refresh])

  // The skin step's Done snap lands the device at the app pose with a black screen; hold that black a beat so it reads as "powered on, then greeted you", not a hard cut.
  useEffect(() => {
    if (phase !== 'onboarding' || step !== 'welcome' || welcomeRevealed) return
    if (reduced) {
      setWelcomeRevealed(true)
      return
    }
    const t = window.setTimeout(() => setWelcomeRevealed(true), 1000)
    return () => window.clearTimeout(t)
  }, [phase, step, welcomeRevealed, reduced])
  // Device tab buttons (HOME/MENU) bypass the controls registry and navigate directly, so they stay inert until the app proper, or a stray press mid-onboarding wedges the flow.
  // In the welcome beat, continue is the tap overlay, so tabs do nothing there too.
  const handleTab = useCallback(
    (tab: 'MENU' | 'GAMES') => {
      if (phase !== 'app') return
      haptic('selection')
      void navigate({ to: tab === 'MENU' ? '/menu' : '/games' })
    },
    [phase, navigate],
  )

  // The loading veil covers the first paint until auth resolves (anon -> door, authed -> app), then wipes up to reveal the console.
  useEffect(() => {
    if (status === 'loading') return
    const exitTimer = window.setTimeout(() => setLoadingScreenLeaving(true), LOADING_EXIT_DELAY_MS)
    const removeTimer = window.setTimeout(
      () => setShowLoadingScreen(false),
      LOADING_EXIT_DELAY_MS + LOADING_EXIT_DURATION_MS,
    )
    return () => {
      window.clearTimeout(exitTimer)
      window.clearTimeout(removeTimer)
    }
  }, [status])

  useEffect(() => {
    if (onCustomize) setCustomizeOpening(false)
  }, [onCustomize])

  // No Customize pre-warm on menu open: building the studio is a second 3D device (~0.9s synchronous Three.js) that froze scroll/close if built while the drawer was open.
  // It builds only when actually opened (onLaunchStart sets customizePrepared on the Customize tap), so the menu does zero 3D work.

  useEffect(() => {
    if (!onMenu && !onCustomize && !customizeHandoff) {
      setCustomizePrepared(false)
    }
  }, [customizeHandoff, onCustomize, onMenu])

  const showCustomizeStudio = onCustomize || customizeOpening || customizeHandoff
  const mountCustomizeStudio = showCustomizeStudio || customizePrepared

  // Which pose the device holds and whether its screen content shows. A returning session holds the settled app pose from frame one (canvas inits heroT=0, no hero, no settle).
  // Onboarding stays on 'app' too: the skin step's Done snap flies the device into the app pose for the welcome beat, so the shell never runs its own zoom.
  const restoring = restoredSession && !onboarding && status !== 'anon' && status !== 'error'
  const canvasStage: 'hero' | 'app' = restoring ? 'app' : phase === 'landing' ? 'hero' : 'app'

  // Tracks whether the hero -> app settle (the door -> games walk-in) is done, so the screen stays black until the device is at rest.
  // Only the landing -> app jump actually moves the device; onboarding -> app, a restored session, and reduced motion all resolve to settled immediately, and a later game <-> game nav stays in 'app' so it never re-fires.
  const [deviceSettled, setDeviceSettled] = useState(true)
  const prevPhaseRef = useRef(phase)
  // Pre-paint so the first app frame is already committed to "settling" (screen dark), otherwise the hub flashes for a frame before the reset lands.
  useIsoLayoutEffect(() => {
    const prev = prevPhaseRef.current
    prevPhaseRef.current = phase
    // Outside the app the screen reveal is governed by landing/onboarding code, so never gate here.
    // Also un-wedges a settle armed a frame before the phase machine detours into onboarding (was the "click any button on Welcome -> all black" bug: deviceSettled stuck false, and deviceChild gates on it).
    if (phase !== 'app') {
      setDeviceSettled(true)
      return
    }
    // Only the direct door -> games walk-in flies the device in from the hero pose (hold the screen dark until it lands); onboarding -> app, a restored session, and reduced motion already sit at rest, so reveal at once.
    if (prev !== 'landing' || restoring || reduced) {
      setDeviceSettled(true)
      return
    }
    setDeviceSettled(false)
    const t = window.setTimeout(() => setDeviceSettled(true), DEVICE_SETTLE_MS)
    return () => window.clearTimeout(t)
  }, [phase, restoring, reduced])

  // Keeps the screen black while the device flies into place on login, then fades content in once settled, so it reads as a powered-off display turning on, not content sliding mid-move.
  // Other transitions (in-app nav, onboarding steps) are unaffected: deviceSettled stays true for them.
  const screenVisible =
    phase === 'app'
      ? !showCustomizeStudio && deviceSettled
      : phase === 'onboarding'
        ? step !== 'customize'
        : true

  // The console tour auto-runs once for a fresh account, the first time the home screen is actually visible.
  const firstRunReady = phase === 'app' && screenVisible && justOnboarded && !isDemo()

  // Content mounted on the device screen per phase. Onboarding's username + welcome render on-screen; the skin step turns the screen off so the body reads cleanly.
  let deviceChild: ReactNode = null
  if (phase === 'app') {
    // Hold the screen dark while the device flies in on login: mount the live screen only once settled, so content fades in cleanly instead of flickering through the door handoff.
    // deviceSettled is true for every other path, so this only gates the login.
    deviceChild = deviceSettled && DeviceScreen ? <DeviceScreen /> : null
  } else if (phase === 'landing') {
    deviceChild = <AttractScreen />
  } else if (step === 'username') {
    deviceChild = (
      <UsernameScreen
        onDone={(name) => {
          setChosenName(name)
          setStep('customize')
        }}
      />
    )
  } else if (step === 'welcome') {
    deviceChild = <WelcomeScreen name={chosenName} revealed={welcomeRevealed} onContinue={finishOnboarding} />
  }

  const loadingScreen = showLoadingScreen ? <AppLoadingScreen leaving={loadingScreenLeaving} /> : null

  return (
    <AchievementDetailProvider>
      <TourProvider firstRunReady={firstRunReady}>
      <LivePresenceProvider userId={status === 'authed' ? user?.id ?? null : null}>
      <ActivePlayProvider>
      <AppFrame bg={backdrop} dimmed={phase === 'landing' && !restoring}>
        {mountConsole && (
        <ConsoleControlsProvider>
          <Console3DRoute
            theme={savedTheme.theme}
            stage={canvasStage}
            reducedMotion={reduced}
            instant={restoring}
            screenContentVisible={screenVisible}
            onNav={handleTab}
          >
            <DeviceSettledProvider settled={deviceSettled}>{deviceChild}</DeviceSettledProvider>
          </Console3DRoute>

          {phase === 'landing' && !restoring && <LandingOverlay onEnter={() => setEntered(true)} />}

          {/* Mounted a step early (on username) so the skin canvas pre-warms behind the handle screen; `active` flips on the skin step to snap it in and zoom out.
              Pre-warming kills the old ~500ms build stall at hand-off. */}
          {phase === 'onboarding' && (step === 'username' || step === 'customize') && (
            <ThemePicker
              selectedId={savedTheme.id}
              onSelect={savedTheme.setId}
              active={step === 'customize'}
              onDone={() => {
                // onSelect already previewed the pick locally; persist the final one to the server.
                void api.patchSettings({ theme: savedTheme.id }).catch(() => {})
                setWelcomeRevealed(false)
                setStep('welcome')
              }}
            />
          )}

          {phase === 'app' && mountCustomizeStudio && (
            <CustomizeStudio
              initialThemeId={savedTheme.id}
              visible={showCustomizeStudio}
              active={onCustomize || customizeHandoff}
              onCommit={(id) => {
                setCustomizeHandoff(true)
                savedTheme.setId(id)
                // Persist the pick so it follows the user to any device. Fire-and-forget, local wins.
                void api.patchSettings({ theme: id }).catch(() => {})
                void navigate({ to: '/games' })
              }}
              onOutroComplete={() => setCustomizeHandoff(false)}
              onCancel={() => void navigate({ to: '/menu' })}
            />
          )}
          {/* The drawer slides itself away (closeTo) when Customize is tapped, revealing the device settling into the workshop. */}
          {phase === 'app' && onMenu && !onCustomize && (
            <MenuDrawer
              returnTo={last3DPath.current}
              onLaunchStart={(to) => {
                if (to === '/menu/customize') {
                  setCustomizePrepared(true)
                  setCustomizeOpening(true)
                }
              }}
            >
              <Outlet />
            </MenuDrawer>
          )}
        </ConsoleControlsProvider>
        )}
        <ActivePlayChip />
        {gate.active && <InstallGate {...gate} />}
      </AppFrame>
      {loadingScreen}
      {/* Shown only while healing a re-armed session in place; never appears on a healthy login. */}
      {recovering && !showLoadingScreen && <RecoveryOverlay />}
      <AchievementCelebration />
      </ActivePlayProvider>
      </LivePresenceProvider>
      </TourProvider>
    </AchievementDetailProvider>
  )
}

function AppLoadingScreen({ leaving = false }: { leaving?: boolean }) {
  return (
    <div className={leaving ? 'app-loading-screen app-loading-screen-leaving' : 'app-loading-screen'}>
      <LoadingIcon size={72} />
    </div>
  )
}

function RecoveryOverlay() {
  return (
    <div className="recovery-overlay">
      <LoadingIcon size={56} />
      <div className="recovery-overlay-text">Getting your account ready</div>
    </div>
  )
}

// The 3D handheld as the live shell: reads the registered controls, renders the passed-in screen content (game, onboarding, or landing attract), and the physical knob/buttons drive the game.
function Console3DRoute({
  children,
  theme,
  stage,
  reducedMotion,
  instant,
  screenContentVisible = true,
  onWelcomeArrived,
  onWelcomeComplete,
  onNav,
}: {
  children?: ReactNode
  theme?: ConsoleTheme
  stage?: 'hero' | 'app' | 'welcome'
  reducedMotion?: boolean
  instant?: boolean
  screenContentVisible?: boolean
  onWelcomeArrived?: () => void
  onWelcomeComplete?: () => void
  // Built by the parent so the device tabs respect the phase machine (inert outside the app).
  onNav?: (tab: 'MENU' | 'GAMES') => void
}) {
  const { view, handlers } = useConsoleView()
  return (
    <ConsoleCanvas
      view={view}
      handlers={handlers}
      onNav={onNav}
      theme={theme}
      stage={stage}
      reducedMotion={reducedMotion}
      instant={instant}
      screenContentVisible={screenContentVisible}
      onWelcomeArrived={onWelcomeArrived}
      onWelcomeComplete={onWelcomeComplete}
    >
      {children}
    </ConsoleCanvas>
  )
}
