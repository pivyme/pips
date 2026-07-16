import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { streamLive } from '@/lib/api'

type Presence = { online: number | null; live: boolean }

const PresenceContext = createContext<Presence>({ online: null, live: false })

// One live-presence connection for the whole session, held at the app shell so it survives every game<->menu nav.
// The backend counts open `/stream/live` sockets, so this connection IS the user's presence; it used to live on Home, so anyone mid-game vanished from the count.
export function LivePresenceProvider({ userId, children }: { userId: string | null; children: ReactNode }) {
  const [online, setOnline] = useState<number | null>(null)
  const [live, setLive] = useState(false)
  useEffect(() => {
    if (!userId) {
      setOnline(null)
      setLive(false)
      return
    }
    const stop = streamLive(
      (t) => {
        setOnline(t.online)
        setLive(true)
      },
      () => setLive(false),
    )
    return stop
  }, [userId])
  return <PresenceContext.Provider value={{ online, live }}>{children}</PresenceContext.Provider>
}

export const useLivePresence = (): Presence => useContext(PresenceContext)
