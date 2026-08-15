// The games lab: real routes on the real console, ADMIN only, hidden from the cartridge grid until a
// game is promoted. Spec: bigdev/plans/cont/04-GAMES-LAB.md §2.
//
// The server is the gate: /games/:game/play answers 404 for a non-admin, the same as a name that does
// not exist. Everything here is tidiness, so a deep link lands somewhere sensible instead of a screen
// whose every action fails.

import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Crosshair, Layers, MapPin, MoveVertical, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAuth } from '@/lib/auth'

export type LabGame = { to: string; icon: LucideIcon; name: string; tag: string }

// Lab games carry a lucide glyph rather than a cartridge SVG: the art is commissioned at promotion.
export const LAB_GAMES: ReadonlyArray<LabGame> = [
  { to: '/games/pin', icon: MapPin, name: 'Pin', tag: 'Name the price. Closest call wins.' },
  { to: '/games/snipe', icon: Crosshair, name: 'Snipe', tag: 'The wall drifts in. Press when it is close.' },
  { to: '/games/press', icon: Layers, name: 'Press', tag: 'Tighten your winning band, or fold.' },
  { to: '/games/rush', icon: Zap, name: 'Rush', tag: 'The machine deals. Take it or lose it.' },
  { to: '/games/breakout', icon: MoveVertical, name: 'Breakout', tag: 'Bet that something happens. Flat kills you.' },
]

export function useIsLabUser(): boolean {
  const { user } = useAuth()
  return !!user?.specialRoles?.includes('ADMIN')
}

/** Renders a lab screen only for an ADMIN, and sends everyone else back to the hub. */
export function useLabGate(): boolean {
  const { status } = useAuth()
  const isLabUser = useIsLabUser()
  const navigate = useNavigate()
  const settling = status === 'loading'

  useEffect(() => {
    if (!settling && !isLabUser) void navigate({ to: '/games', replace: true })
  }, [settling, isLabUser, navigate])

  return isLabUser
}
