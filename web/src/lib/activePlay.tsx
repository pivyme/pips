import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { streamPlay, type Game, type PlayStatus } from '@/lib/api'

export type TrackedPlay = { id: string; game: Game }
export type ActivePlay = TrackedPlay & { status: PlayStatus | null; pnl: string | null }

// How long a terminal state holds in the chip before it clears itself, so a settle that lands while
// you're elsewhere still reads (the reveal), not just a chip that vanishes the instant it resolves.
const TERMINAL_HOLD_MS = 4000
export const PLAY_TERMINAL = new Set<PlayStatus>(['won', 'lost', 'cashed_out', 'error'])

interface Ctx {
  active: ActivePlay | null
  // Called by a game screen right after a mint lands. null clears tracking (e.g. leaving the game
  // screen mid-idle isn't tracked at all, only an actually open play is).
  track: (play: TrackedPlay | null) => void
}

const ActivePlayContext = createContext<Ctx | null>(null)

// One global "is a play still resolving" tracker, held at the app shell so it survives navigating off
// the game that opened it (Home, a different game). A game screen announces a play via track(); this
// then runs its OWN streamPlay subscription (independent of the screen's own usePlayResolutionWatch,
// which unmounts with the screen) so the chip and the off-screen settle toast keep working after you
// leave. Self-clears a beat after a terminal status so the final result gets to read before it goes.
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
