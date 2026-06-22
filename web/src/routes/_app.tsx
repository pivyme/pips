import { Outlet, createFileRoute, useMatchRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { ConsoleTheme } from '@/components/console/themes'
import { GamesConsole } from './_app/games/index'
import { LuckyScreen } from './_app/games/lucky'
import { RangeScreen } from './_app/games/range'
import { LineRiderScreen } from './_app/games/line-rider'
import { CandleHopScreen } from './_app/games/candle-hop'
import { AppFrame } from '@/components/console/AppFrame'
import { AchievementCelebration } from '@/components/AchievementCelebration'
import { AchievementDetailProvider } from '@/components/menu/AchievementDetail'
import { ConsoleControlsProvider, DeviceSettledProvider, useConsoleView } from '@/components/console/controls'
import ConsoleCanvas from '@/components/console/ConsoleCanvas'
import { MenuDrawer } from '@/components/console/MenuDrawer'
import { CustomizeStudio } from '@/components/console/CustomizeStudio'
import { LandingOverlay, AttractScreen } from '@/components/console/LandingOverlay'
import { UsernameScreen, ThemePicker, WelcomeScreen } from '@/components/console/Onboarding'
import { DEFAULT_THEME_ID, THEME_BY_ID, themeBackdrop, useConsoleTheme } from '@/components/console/themes'
import { LoadingIcon } from '@/ui/LoadingIcon'
import { haptic } from '@/lib/haptics'
import { api } from '@/lib/api'
import { useAuth, loadToken } from '@/lib/auth'
import { isDemo } from '@/lib/demo'
import { refreshDeployedConfig } from '@/lib/sui/config'
import { env } from '@/env'
import { useReducedMotion } from '@/hooks/useReducedMotion'

const LOADING_EXIT_DELAY_MS = 150
const LOADING_EXIT_DURATION_MS = 520
// Mirrors the canvas hero -> app settle (ConsoleCanvas HERO_MS): how long the device "drops in"
// before it's at rest. Screens can hold their content until then. Kept in sync by hand.
const DEVICE_SETTLE_MS = 900

// Runs before paint on the client, no-ops on the server. Lets us read localStorage (the auth token) and
// commit the "returning session" decision into the first painted frame, so a refresh never flashes the
// door or the hero -> app zoom.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

// The aperture games keyed by their route path. The 3D device mounts the active game's screen
// directly from here, not through the router Outlet. That is what lets the screen survive the menu:
// the menu is its own /menu route, so going through the Outlet would unmount the game the moment the
// drawer opens and flash the device black behind the blur. Mounting by path keeps the same instance
// alive across game <-> menu, so the live chart never blinks.
const DEVICE_SCREENS: Record<string, ComponentType> = {
  '/games': GamesConsole,
  '/games/lucky': LuckyScreen,
  '/games/range': RangeScreen,
  '/games/line-rider': LineRiderScreen,
  '/games/candle-hop': CandleHopScreen,
}

type OnboardingStep = 'username' | 'customize' | 'welcome'

// Everything lives on ONE persistent console: the landing door, the first-run onboarding, and the
// games + menu. They are phases of this single shell (never separate route trees), so the same 3D
// device instance survives the whole arc with no remount: it settles from a floating hero to center
// after sign-in, hosts the username + skin + welcome beats, then becomes the live games device.
// The landing route ("/") just redirects here.
export const Route = createFileRoute('/_app')({ component: AppLayout })

function AppLayout() {
  const { status, user, recovering, refresh } = useAuth()
  const reduced = useReducedMotion()
  const [showLoadingScreen, setShowLoadingScreen] = useState(true)
  const [loadingScreenLeaving, setLoadingScreenLeaving] = useState(false)
  const [customizePrepared, setCustomizePrepared] = useState(false)
  const [customizeOpening, setCustomizeOpening] = useState(false)
  const [customizeHandoff, setCustomizeHandoff] = useState(false)
  const navigate = useNavigate()
  const matchRoute = useMatchRoute()
  // The menu is a drawer over the device, not a screen inside it. When a /menu route is active we
  // render it through the drawer while the shell behind it stays put for the blur layer.
  const onMenu = Boolean(matchRoute({ to: '/menu', fuzzy: true }))
  const onRange = Boolean(matchRoute({ to: '/games/range' }))
  const onLucky = Boolean(matchRoute({ to: '/games/lucky' }))
  const onLineRider = Boolean(matchRoute({ to: '/games/line-rider' }))
  const onCandleHop = Boolean(matchRoute({ to: '/games/candle-hop' }))
  const on3D = Boolean(matchRoute({ to: '/games', fuzzy: true }))
  // Customize takes over the device: the menu drawer slides away and the device drops into the
  // workshop studio. It rides the same persistent 3D branch so the WebGL stays warm.
  const onCustomize = Boolean(matchRoute({ to: '/menu/customize' }))
  // The saved skin. Feeds the live games device; the studio + onboarding seed from it and write back.
  const savedTheme = useConsoleTheme()
  // Theme is a synced setting: localStorage paints it instantly (pre-auth, no flash), but the server is
  // the cross-device source of truth. On the first authenticated frame per account, adopt the server's
  // saved skin so a new device matches the one you customized. We only adopt a NON-default pick: when the
  // server is still on the default we leave the local skin alone, so a pre-sync local choice (or the
  // shared-key demo user) is never clobbered back to Classic. Same-device logins already match (every
  // pick writes both), so there's no recolor. setId is unstable (it closes over the stored value), so
  // reach it through a ref.
  const savedThemeRef = useRef(savedTheme)
  savedThemeRef.current = savedTheme
  const themeHydratedFor = useRef<string | null>(null)
  // Adopt the live deploy ids (the DUSDC coin type) from the backend once on boot, so a devnet
  // redeploy never needs a frontend rebuild. Demo has no backend, so it keeps the compile-time value.
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
    // own-property check: the server theme is a free-form string, so ignore anything not in the
    // catalog (and never let a prototype key like "constructor" slip through into the skin lookup).
    const known = serverTheme ? Object.prototype.hasOwnProperty.call(THEME_BY_ID, serverTheme) : false
    if (known && serverTheme !== DEFAULT_THEME_ID && serverTheme !== st.id) {
      st.setId(serverTheme)
    }
  }, [user])
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

  // Where Close returns the menu and which game the device mounts: the live game while on a games
  // route, held across the menu open so the chart never blinks. (Mounting by path, not the Outlet.)
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
  const DeviceScreen = DEVICE_SCREENS[last3DPath.current]

  // ===== Phase machine: landing (the door) -> onboarding (new account) -> app =====
  // The door always shows first and is left by tapping the CTA, even when dev/demo auto-login has
  // already resolved a session (a returning privy session auto-walks in). `entered` is that gate;
  // it resets on sign-out so the door returns. "Onboarded" is server-truth: user.username is set
  // (the same in demo, which persists it locally). onboardedRef latches the run so a flaky refresh
  // can't bounce a finished user back into onboarding.
  // A token already in storage means this is a refresh / returning user, not a fresh login. Those skip
  // the door and hold the settled app pose from frame one, so the hero -> app "zoom in" only plays on a
  // real login this session (the door CTA / privy handshake), never on every page load. Detected in a
  // pre-paint client layout effect (localStorage is client-only), so the first painted frame is already
  // committed to the app, no door/zoom flash. Demo keeps its door (it never persists a real token here).
  // Debug: replay the whole onboarding arc on every sign-in/reload even when the handle is already set,
  // so the flow can be evaluated without resetting an account. It must run the REAL first-run path
  // (door -> hero->app settle -> onboarding -> welcome zoom), so it skips the session-restore below.
  // Restoring would pin the device to the settled app pose with no hero, which is what made the 3D
  // movement break (the username step crossfaded instead of settling, the welcome zoom over-shot).
  // onboardedRef still latches it to once per session (resets on sign-out), so a finished run can't loop.
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
  // Welcome (the final onboarding beat) sub-state. The skin step's Done snap (its own customize outro)
  // already lands the device at the app pose with a black screen, so the welcome is pure screen content:
  // `revealed` flips after a short black hold, which gates the splash content + jingle fading in.
  const [welcomeRevealed, setWelcomeRevealed] = useState(false)
  // Sign-out (incl. the onboarding Log out) returns to the door with a clean slate, so the gate resets
  // and the next sign-in starts onboarding fresh, never mid-flow. A stale token that fails to restore
  // (401 -> anon, or error) also drops the no-animation path so the door comes back normally.
  useEffect(() => {
    if (status === 'anon' || status === 'error') setRestoredSession(false)
    if (status === 'anon') {
      setEntered(false)
      onboardedRef.current = false
      setOnboarding(false)
      setStep('username')
      setChosenName('')
      setWelcomeRevealed(false)
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

  // Keep the URL honest with the phase, on the one persistent shell. Signed out -> the door at the
  // root, so logging out never leaves a stale /games or /menu path behind the door. Signed in -> the
  // canonical /games hub (the menu is only ever a drawer over it, never a standalone page). Mid
  // onboarding we just strip a stray /menu. Skipped while auth is still resolving so a returning
  // session isn't bounced off /games during the loading veil.
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

  // Welcome dismissed: leave onboarding and refresh so the shell re-reads the new handle. We defer the
  // refresh to here (not the username step) so the user object stays "not onboarded" through every step
  // and the phase can't jump to the app mid-flow.
  const finishOnboarding = useCallback(() => {
    onboardedRef.current = true
    setOnboarding(false)
    setWelcomeRevealed(false)
    void refresh()
  }, [refresh])

  // The skin step's Done snap puts the device at the app pose with the screen black. Hold that black for
  // a beat (so it reads as "powered on, then greeted you", not a hard cut), then fade the splash in.
  useEffect(() => {
    if (phase !== 'onboarding' || step !== 'welcome' || welcomeRevealed) return
    if (reduced) {
      setWelcomeRevealed(true)
      return
    }
    const t = window.setTimeout(() => setWelcomeRevealed(true), 1000)
    return () => window.clearTimeout(t)
  }, [phase, step, welcomeRevealed, reduced])
  // The device tab buttons (HOME / MENU) bypass the controls registry and navigate directly, so they
  // must stay inert until the app proper, or a stray press mid-onboarding navigates away and wedges
  // the flow. In the welcome beat continue is the tap overlay, so tabs do nothing there too.
  const handleTab = useCallback(
    (tab: 'MENU' | 'GAMES') => {
      if (phase !== 'app') return
      haptic('selection')
      void navigate({ to: tab === 'MENU' ? '/menu' : '/games' })
    },
    [phase, navigate],
  )

  // The loading veil covers the very first paint until auth resolves (anon -> door, authed -> app),
  // then wipes up to reveal the live console underneath.
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

  // No Customize pre-warm on menu open. Building the studio is a whole second 3D device (~0.9s of
  // synchronous Three.js), and doing it while the drawer is open froze every scroll/close. The studio
  // builds only when you actually open it (onLaunchStart sets customizePrepared on the Customize tap),
  // so the menu itself does zero 3D work and stays smooth.

  useEffect(() => {
    if (!onMenu && !onCustomize && !customizeHandoff) {
      setCustomizePrepared(false)
    }
  }, [customizeHandoff, onCustomize, onMenu])

  const showCustomizeStudio = onCustomize || customizeOpening || customizeHandoff
  const mountCustomizeStudio = showCustomizeStudio || customizePrepared

  // What pose the one device holds, and whether its HTML screen content shows. A returning session
  // holds the settled app pose from the first frame (canvas inits heroT=0 -> no hero, so no settle).
  // Onboarding keeps it on 'app': the skin step's Done snap (the customize outro) is what flies the
  // device into the app pose for the welcome beat, so the persistent shell never runs its own zoom.
  const restoring = restoredSession && !onboarding && status !== 'anon' && status !== 'error'
  const canvasStage: 'hero' | 'app' = restoring ? 'app' : phase === 'landing' ? 'hero' : 'app'

  // The device plays a hero -> app settle on a real login (the door -> games walk-in: the handheld
  // flies in from the floating hero pose to center). Track when that move is done so the screen can
  // stay black through it and only power its content on once the device is at rest. Only the
  // landing -> app jump moves the device; onboarding -> app already sits at the app pose (the skin
  // step's Done snap landed it there), and a restored session / reduced motion has no settle at all,
  // so those resolve to settled immediately. A later game <-> game nav stays in 'app', so it never
  // re-fires and content reveals right away.
  const [deviceSettled, setDeviceSettled] = useState(true)
  const prevPhaseRef = useRef(phase)
  // Pre-paint so the first app frame is already committed to "settling" (screen dark) before the
  // browser paints, otherwise the hub would flash for a frame before the reset lands.
  useIsoLayoutEffect(() => {
    const prev = prevPhaseRef.current
    prevPhaseRef.current = phase
    // Outside the app the screen reveal is governed by the landing/onboarding code, so never gate
    // here. Crucially this also un-wedges a settle that the brief landing -> app render arms a frame
    // before the phase machine detours into onboarding: without it, deviceSettled stayed false for the
    // whole run, so the screen went black and stuck the instant onboarding handed off to the app (the
    // "click any button on Welcome -> all black" bug), since deviceChild gates on it.
    if (phase !== 'app') {
      setDeviceSettled(true)
      return
    }
    // Only the direct door -> games walk-in flies the device in from the hero pose; hold the screen
    // dark until it lands. Onboarding -> app (and a restored session / reduced motion) already sits at
    // the resting pose, so reveal at once.
    if (prev !== 'landing' || restoring || reduced) {
      setDeviceSettled(true)
      return
    }
    setDeviceSettled(false)
    const t = window.setTimeout(() => setDeviceSettled(true), DEVICE_SETTLE_MS)
    return () => window.clearTimeout(t)
  }, [phase, restoring, reduced])

  // Keep the screen black while the device flies into place on login, then fade the content in once
  // it has settled. The layer's backing is always black, so the screen reads as a powered-off display
  // that turns on when the handheld arrives, not content sliding around mid-move. Other transitions
  // (in-app nav, onboarding steps) are unaffected: deviceSettled stays true for them.
  const screenVisible =
    phase === 'app'
      ? !showCustomizeStudio && deviceSettled
      : phase === 'onboarding'
        ? step !== 'customize'
        : true

  // The content mounted on the device's screen, per phase. Onboarding's username + welcome render on
  // the screen (instrument language); the skin step turns the screen off so the body reads cleanly.
  let deviceChild: ReactNode = null
  if (phase === 'app') {
    // Hold the screen dark while the device flies in from the hero pose on login: mount the live
    // screen only once it has settled, so its content fades in cleanly as the device lands instead of
    // flickering through the fade-out as the door's attract screen hands off. deviceSettled is true for
    // every other path (in-app nav, restored session, onboarding -> app), so this only gates the login.
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
      <AppFrame bg={backdrop} dimmed={phase === 'landing' && !restoring}>
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

          {/* Mounted a step early (on username) so the skin canvas builds + holds at the app pose behind
              the handle screen, then `active` flips on the skin step and it snaps in over the live device
              and zooms out. Pre-warming is what kills the old ~500ms build stall at the hand-off. */}
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
          {/* The drawer slides itself away (closeTo) when Customize is tapped, then the studio takes
              over, so the device is revealed settling into the workshop. */}
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
      </AppFrame>
      {loadingScreen}
      {/* Shown only while healing a re-armed session in place (devnet refresh). Never appears on a
          healthy login, so onboarding and the normal first run are untouched. */}
      {recovering && !showLoadingScreen && <RecoveryOverlay />}
      <AchievementCelebration />
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

// The 3D handheld as the live shell. It reads the controls the screen registered and renders the
// screen content on the device's screen; the physical knob/buttons drive the game. The screen
// content is passed in (the active game's screen, the onboarding screens, or the landing attract).
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
