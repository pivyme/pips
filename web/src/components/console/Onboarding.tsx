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

const HANDLE_RE = /^[a-zA-Z0-9_]{3,20}$/

// Step 1, on the device screen. A raw flat input in the instrument language (no rounded App-Surface
// field), auto-focused on web, tap-anywhere-to-focus so mobile reliably raises the keyboard. The
// physical PLAY button or Enter commits.
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
      <span className="font-mono text-[10px] font-bold uppercase tracking-[0.3em] text-text-3">
        Pick your handle
      </span>

      <div className="flex w-full max-w-[300px] flex-col items-center">
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => {
            setName(e.target.value.replace(/\s/g, ''))
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
          className="w-full bg-transparent text-center text-[28px] font-black tracking-tight text-text placeholder:text-text-3/40 focus:outline-none"
          style={{ caretColor: 'var(--color-brand-500)' }}
        />
        <div className="mt-2 h-px w-full bg-line-strong" />
      </div>

      <div className="h-4 font-mono text-[10px] font-bold uppercase tracking-[0.16em]">
        {error ? (
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
}: {
  selectedId: string
  onSelect: (id: string) => void
  onDone: () => void
}) {
  const reduced = useReducedMotion()
  // Let the workshop paint one beat before the WebGL device mounts, same as the studio.
  const [ready, setReady] = useState(reduced)
  const theme = THEME_BY_ID[selectedId] ?? THEMES[0]

  useEffect(() => {
    if (reduced) return
    const t = setTimeout(() => setReady(true), 90)
    return () => clearTimeout(t)
  }, [reduced])

  return (
    <div className="absolute inset-0 z-20 overflow-hidden">
      <WorkshopBackdrop />

      {/* The floating device, repainting live from the chosen skin. Transparent canvas → the workshop
          shows around it. Mounted a beat late so the backdrop is up first. */}
      {ready && <ConsoleCanvas customize theme={theme} />}

      {/* Chrome on top. The device area stays click-through so drags spin it; only the controls grab. */}
      <div className="pointer-events-none absolute inset-0 z-30 flex flex-col">
        <div className="flex-1" />
        <motion.div
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 36 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
          transition={{ duration: reduced ? 0.3 : 0.5, ease: [0.16, 1, 0.3, 1], delay: reduced ? 0 : 0.1 }}
          className="pointer-events-auto relative z-10 px-4 pb-[max(30px,calc(env(safe-area-inset-bottom)+20px))]"
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
            onClick={() => {
              haptic('rigid')
              onDone()
            }}
            className="btn-primary mt-4 flex h-14 w-full items-center justify-center rounded-full text-base"
          >
            Continue
          </button>
        </motion.div>
      </div>
    </div>
  )
}

// Step 3, on the device screen: the welcome moment. The camera zooms into the screen (driven by the
// canvas `stage='welcome'`); this is what it lands on. Jingle + haptic fire on mount (gesture-unlocked
// by the Continue tap that brought us here).
export function WelcomeScreen({ name }: { name: string }) {
  useEffect(() => {
    welcomeJingle()
    haptic('success')
  }, [])

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-black px-[var(--screen-rim,24px)] text-center">
      {/* The 512 export of the square 3D logo: same mark, far lighter than the 1MB source. */}
      <img
        src="/assets/logos/pips-512.png"
        alt="Pips"
        draggable={false}
        className="welcome-pop h-24 w-24 select-none rounded-[18px] shadow-[0_18px_50px_-12px_rgba(253,176,2,0.5)]"
      />
      <div>
        <div className="text-2xl font-black tracking-tight text-text">
          Welcome{name ? `, ${name}` : ''}
        </div>
        <p className="mx-auto mt-2 max-w-[260px] text-[13px] font-medium leading-snug text-text-2">
          We've sent you <span className="font-bold text-brand-500">1,000 USDC</span> to play around. Have fun!
        </p>
      </div>
    </div>
  )
}
