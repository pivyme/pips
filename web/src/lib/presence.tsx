import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { livePing, streamLive } from '@/lib/api'

type Presence = { online: number | null; live: boolean }

const PresenceContext = createContext<Presence>({ online: null, live: false })

// A slept phone or a switched network leaves the socket open with nobody behind it, so the server expires
// a session that stops pinging. Under a minute keeps us well inside that window even when a background tab
// throttles the timer.
const PING_MS = 45_000

// One live-presence connection for the whole session, held at the app shell so it survives every game<->menu nav.
// The backend counts claimed `/stream/live` sessions, so this connection IS the user's presence; it used to live on Home, so anyone mid-game vanished from the count.
export function LivePresenceProvider({ userId, children }: { userId: string | null; children: ReactNode }) {
  const [online, setOnline] = useState<number | null>(null)
  const [live, setLive] = useState(false)
  const sid = useRef<string | null>(null)
  useEffect(() => {
    if (!userId) {
      setOnline(null)
      setLive(false)
      return
    }
    const stop = streamLive(
      (t) => {
        if (t.sid) sid.current = t.sid
        setOnline(t.online)
        setLive(true)
      },
      () => setLive(false),
    )
    // Fire-and-forget: a dropped ping costs nothing, the next one lands, and a swept session comes back as
    // a fresh one when EventSource reconnects.
    const ping = setInterval(() => {
      if (sid.current) void livePing(sid.current).catch(() => {})
    }, PING_MS)
    return () => {
      clearInterval(ping)
      sid.current = null
      stop()
    }
  }, [userId])
  return <PresenceContext.Provider value={{ online, live }}>{children}</PresenceContext.Provider>
}

export const useLivePresence = (): Presence => useContext(PresenceContext)
