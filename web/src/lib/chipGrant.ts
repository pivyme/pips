// The TOP UP action for the chips-granted flow. The event bus itself lives in chipGrantBus (dependency-free
// to avoid an import cycle with auth); this adds the hook that games + the auto-watcher call to fetch a grant.

import { useCallback, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { api } from './api'
import { useAuth } from './auth'
import { isDemo } from './demo'
import { emitChipGrant } from './chipGrantBus'

export { emitChipGrant, subscribeChipGrant } from './chipGrantBus'

// The one top-up action: ask the backend for a starter grant, adopt the new balance, and bloom the
// celebration when chips land. Single-flighted so a double tap, or the auto-watcher racing a manual TOP UP,
// only ever fires one grant. When the grant is skipped (already funded, on cooldown, or a dry treasury) an
// explicit TOP UP press falls back to the deposit drawer; the silent on-load auto top-up passes
// fallbackToDeposit:false so a browsing player is never yanked to a drawer they didn't ask for.
export function useTopUp(): (opts?: { fallbackToDeposit?: boolean }) => Promise<void> {
  const { refresh } = useAuth()
  const navigate = useNavigate()
  const busy = useRef(false)
  return useCallback(
    async ({ fallbackToDeposit = true }: { fallbackToDeposit?: boolean } = {}) => {
      if (busy.current) return
      busy.current = true
      const toDeposit = () => {
        if (fallbackToDeposit && !isDemo()) void navigate({ to: '/menu/deposit' })
      }
      try {
        const { granted } = await api.grantChips()
        if (granted && granted > 0) {
          emitChipGrant(granted)
          await refresh()
          return
        }
        toDeposit() // nothing granted (cooldown or a dry treasury)
      } catch {
        toDeposit()
      } finally {
        busy.current = false
      }
    },
    [refresh, navigate],
  )
}
