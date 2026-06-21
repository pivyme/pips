// First-run onboarding, played out on the same persistent console: type a handle on the device
// screen, pick a skin, then a short welcome moment. The username + welcome screens render INSIDE the
// device (docs/SCREEN.md instrument language); the skin picker reuses the menu Customize studio so it
// looks identical, the device floating pulled-back over the workbench photo, free to spin.
import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import ConsoleCanvas from './ConsoleCanvas'
import { ThemeRail, WorkshopBackdrop } from './CustomizeStudio'
import { THEMES, THEME_BY_ID } from './themes'
import { useConsoleControls } from './controls'
import { ApiError, api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { haptic } from '@/lib/haptics'
import { welcomeJingle } from '@/lib/sound'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { cnm } from '@/utils/style'

const HANDLE_RE = /^[a-zA-Z0-9_]{3,20}$/

// Step 1, on the device screen. A raw flat input in the instrument language (no rounded App-Surface
// field), auto-focused on web, tap-anywhere-to-focus so mobile reliably raises the keyboard. The
// physical PLAY button or Enter commits. (Changing the handle later lives on the menu drawer, not here.)
export function UsernameScreen({ onDone }: { onDone: (name: string) => void }) {
  const { signOut } = useAuth()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const trimmed = name.trim()
  const valid = HANDLE_RE.test(trimmed)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = useCallback(async () => {
    const handle = name.trim()
    if (!HANDLE_RE.test(handle)) {
      setError('3 to 20 letters, numbers, or _')
      haptic('warning')
      inputRef.current?.focus()
      return
    }
    setSaving(true)
    setError(null)
    try {
      await api.setUsername(handle)
      haptic('success')
      onDone(handle)
    } catch (e) {
      setSaving(false)
      const msg = e instanceof ApiError && e.code === 'USERNAME_TAKEN' ? 'That handle is taken' : 'Could not save that. Try again.'
      setError(msg)
      haptic('error')
      inputRef.current?.focus()
    }
  }, [name, onDone])

  // The PLAY button commits (so does Enter). The left action button is the way out of onboarding, back
  // to the door, since the menu doesn't exist yet at this phase. Handlers stay fresh via the controls ref.
  useConsoleControls({
    main: { label: saving ? 'SAVING' : 'CONTINUE', color: 'amber', loading: saving, onPress: () => void submit() },
    action1: {
      label: 'LOGOUT',
      color: 'neutral',
      onPress: () => {
        if (saving) return
        haptic('rigid')
        signOut()
      },
    },
  })

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-5 bg-black px-[var(--screen-rim,24px)] text-center"
      onClick={() => inputRef.current?.focus()}
    >
      <span className="font-mono text-[13px] font-bold uppercase tracking-[0.3em] text-text-3">
        Pick your handle
      </span>

      <div className="flex w-full max-w-[300px] flex-col items-center">
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => {
            setName(e.target.value.replace(/\s/g, '').toLowerCase())
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
          maxLength={20}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="yourname"
          aria-label="Username"
          className="w-full bg-transparent text-center text-[36px] font-extrabold tracking-tight text-text placeholder:text-text-3/40 focus:outline-none"
          style={{ caretColor: 'var(--color-brand-500)' }}
        />
        <div className="mt-2 h-px w-full bg-line-strong" />
      </div>

      <div className="h-5 font-mono text-[12px] font-bold uppercase tracking-[0.16em]">
        {saving ? (
          <span className="text-brand-500 motion-safe:animate-pulse">Saving...</span>
        ) : error ? (
          <span className="text-down">{error}</span>
        ) : valid ? (
          <span className="text-up">Looks good</span>
        ) : (
          <span className="text-text-3">Hit play to continue</span>
        )}
      </div>
    </div>
  )
}

// Step 2: the skin picker, played in the same black-and-white workshop as the menu's Customize studio
// so the two surfaces match exactly. Its own `customize` canvas floats the device pulled-back over the
// workbench photo and repaints live as you scroll the rail; the persistent shell waits behind (screen
// off, hidden under the backdrop) and takes over for the welcome zoom once Continue is tapped. The
// selection is owned by the shell so the chosen skin survives into welcome + app.
export function ThemePicker({
  selectedId,
  onSelect,
  onDone,
  active,
}: {
  selectedId: string
  onSelect: (id: string) => void
  onDone: () => void
  // false while it pre-warms behind the username step (the WebGL device builds + holds at the app pose,
  // kept invisible); true once the skin step is live, which snaps the device in exactly over the live
  // shell, releases its zoom-out, and fades the workshop + chrome in. Pre-warming kills the build lag.
  active: boolean
}) {
  const reduced = useReducedMotion()
  // Continue plays the menu studio's exact Done snap: the device spins + zooms back to the app pose and
  // holds black, then hands off (onOutroComplete -> onDone advances to the welcome beat). Chrome bows out.
  const [exiting, setExiting] = useState(false)
  const theme = THEME_BY_ID[selectedId] ?? THEMES[0]

  const commit = () => {
    if (exiting) return
    haptic('rigid')
    setExiting(true)
  }

  return (
    <div
      className="absolute inset-0 z-20 overflow-hidden"
      style={{ pointerEvents: active ? undefined : 'none' }}
      aria-hidden={!active}
    >
      {/* Workshop fades in as the device zooms out. Clear during the pre-warm so the live device behind
          shows through, so the handheld reads as one object pulling back into the bench, not a crossfade. */}
      <div className="absolute inset-0 transition-opacity duration-[600ms] ease-out" style={{ opacity: active ? 1 : 0 }}>
        <WorkshopBackdrop />
      </div>

      {/* The floating device, repainting live from the chosen skin. Built during the pre-warm (active
          false renders it once, held at the app pose via introFromApp) and kept invisible, then snapped
          in the instant the skin step goes live so it sits exactly on the live device behind and zooms
          out from there. Transparent canvas → the workshop shows around it. */}
      <div className="absolute inset-0" style={{ opacity: active ? 1 : 0 }}>
        <ConsoleCanvas customize introFromApp active={active} theme={theme} outro={exiting} onOutroComplete={onDone} />
      </div>

      {/* Chrome on top. The device area stays click-through so drags spin it; only the controls grab. */}
      <div className="pointer-events-none absolute inset-0 z-30 flex flex-col">
        <div className="flex-1" />
        <motion.div
          initial={{ opacity: 0, y: 36 }}
          animate={!active ? { opacity: 0, y: 36 } : exiting ? { opacity: 0, y: 26 } : { opacity: 1, y: 0 }}
          transition={
            exiting
              ? { duration: 0.26, ease: 'easeIn' }
              : { duration: reduced ? 0.3 : 0.5, ease: [0.16, 1, 0.3, 1], delay: reduced ? 0 : 0.35 }
          }
          className={cnm(
            'relative z-10 px-4 pb-[max(30px,calc(env(safe-area-inset-bottom)+20px))]',
            active && !exiting ? 'pointer-events-auto' : 'pointer-events-none',
          )}
        >
          <div className="mb-1 px-1 text-center">
            <div className="text-[22px] font-black leading-none tracking-tight text-white">Make it yours</div>
            <div className="mt-1.5 text-[13px] font-medium text-white/55">Pick a skin. Change it anytime.</div>
          </div>

          <ThemeRail
            selectedId={selectedId}
            onSelect={(next) => {
              haptic('selection')
              onSelect(next)
            }}
          />

          <button
            type="button"
            onClick={commit}
            className="btn-primary mt-4 flex h-14 w-full items-center justify-center rounded-full text-base"
          >
            Continue
          </button>
        </motion.div>
      </div>
    </div>
  )
}

// Step 3, on the device screen: the welcome moment. The skin step's Done snap already settled the device
// at the app pose with a black screen; this just reveals on the screen once the black hold passes
// (`revealed`), so the content pops + the jingle land cleanly. Any physical button continues.
export function WelcomeScreen({
  name,
  revealed,
  onContinue,
}: {
  name: string
  revealed: boolean
  onContinue: () => void
}) {
  // Jingle + success haptic on the reveal (gesture already unlocked by the press that got us here).
  useEffect(() => {
    if (!revealed) return
    welcomeJingle()
    haptic('success')
  }, [revealed])

  // Any of the physical buttons continues, but only once the splash is up, so a stray press during the
  // black hold can't skip it. The big button glows to pull the eye; the screen copy says press anything.
  const go = useCallback(() => {
    if (!revealed) return
    haptic('rigid')
    onContinue()
  }, [revealed, onContinue])
  useConsoleControls({
    main: { label: 'CONTINUE', color: 'amber', onPress: go },
    action1: { label: 'CONTINUE', color: 'neutral', pulse: revealed, onPress: go },
    action2: { label: 'CONTINUE', color: 'neutral', pulse: revealed, onPress: go },
  })

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-black px-[var(--screen-rim,24px)] text-center">
      {revealed && (
        <>
          {/* The 512 export of the square 3D logo: same mark, far lighter than the 1MB source. */}
          <img
            src="/assets/logos/pips-512.png"
            alt="PIPS"
            draggable={false}
            className="welcome-pop h-24 w-24 select-none rounded-[18px] shadow-[0_18px_50px_-12px_rgba(253,176,2,0.5)]"
          />
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1], delay: 0.12 }}
          >
            <div className="text-2xl font-black tracking-tight text-text">
              Welcome{name ? `, @${name.toLowerCase()}` : ''}
            </div>
            <p className="mx-auto mt-2 max-w-[260px] text-[13px] font-medium leading-snug text-text-2">
              We've sent you <span className="font-bold text-brand-500">1,000 DUSDC</span> to play around. Have fun!
            </p>
          </motion.div>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.75 }}
            className="mt-2"
          >
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.3em] text-brand-500 motion-safe:animate-pulse">
              Press any button to continue
            </span>
          </motion.div>
        </>
      )}
    </div>
  )
}
