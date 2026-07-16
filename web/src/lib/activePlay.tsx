import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { streamPlay, type Game, type PlayStatus } from '@/lib/api'

export type TrackedPlay = { id: string; game: Game }
export type ActivePlay = TrackedPlay & { status: PlayStatus | null; pnl: string | null }

// How long a terminal state holds in the chip before clearing, so a settle landing while you're elsewhere still gets a reveal, not an instant vanish.
const TERMINAL_HOLD_MS = 4000
export const PLAY_TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out', 'error'])

interface Ctx {
  active: ActivePlay | null
  // Called by a game screen right after a mint lands; null clears tracking (only an actually open play is tracked, not idle).
  track: (play: TrackedPlay | null) => void
}

const ActivePlayContext = createContext<Ctx | null>(null)

// One global "is a play still resolving" tracker, held at the app shell so it survives navigating off the game.
// It runs its own streamPlay subscription (independent of the screen's usePlayResolutionWatch, which unmounts with the screen), so the chip and settle toast keep working after you leave; self-clears a beat after terminal so the result reads first.
export function ActivePlayProvider({ children }: { children: ReactNode }) {
  const [tracked, setTracked] = useState<TrackedPlay | null>(null)
  const [live, setLive] = useState<{ status: PlayStatus | null; pnl: string | null }>({ status: null, pnl: null })
  const trackedIdRef = useRef<string | null>(null)

  const track = useCallback((play: TrackedPlay | null) => {
    setTracked(play)
    setLive({ status: null, pnl: null })
  }, [])

  useEffect(() => {
    trackedIdRef.current = tracked?.id ?? null
    if (!tracked) return
    const unsub = streamPlay(tracked.id, (t) => {
      if (trackedIdRef.current !== tracked.id) return
      setLive({ status: t.status, pnl: t.pnl })
      if (PLAY_TERMINAL.has(t.status)) {
        setTimeout(() => {
          if (trackedIdRef.current === tracked.id) setTracked(null)
        }, TERMINAL_HOLD_MS)
      }
    })
    return unsub
  }, [tracked?.id])

  const active = tracked ? { ...tracked, ...live } : null
  return <ActivePlayContext.Provider value={{ active, track }}>{children}</ActivePlayContext.Provider>
}

export function useActivePlay(): Ctx {
  const ctx = useContext(ActivePlayContext)
  if (!ctx) throw new Error('useActivePlay used outside ActivePlayProvider')
  return ctx
}
