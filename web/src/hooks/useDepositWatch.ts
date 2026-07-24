// Watches the user's Sui address for incoming funds while mounted (the deposit screen). Records a baseline at
// mount, polls /wallet/sync every few seconds, fires the celebration for a new receive, and refreshes the
// balance. Paused on tab-hidden, stopped on unmount, exponential backoff on error, so it stays cheap on the
// free public endpoint (§12c). Returns the latest landed row for the deposit screen's inline affordance.

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { WalletTxDTO } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { emitDepositLanded } from '@/lib/depositBus'

const POLL_MS = 3500
const START_DELAY_MS = 1200
const MAX_BACKOFF_MS = 30_000

export function useDepositWatch(enabled = true): { landed: WalletTxDTO | null } {
  const { refresh } = useAuth()
  const [landed, setLanded] = useState<WalletTxDTO | null>(null)

  useEffect(() => {
    if (!enabled) return
    // Baseline: only receives at or after now count, so an old row never re-celebrates on this screen.
    let since = Date.now()
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let backoff = POLL_MS

    const schedule = (ms: number): void => {
      if (stopped) return
      timer = setTimeout(() => void tick(), ms)
    }

    const tick = async (): Promise<void> => {
      if (stopped) return
      // Paused while the tab is hidden: re-check soon without hitting the server.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        schedule(POLL_MS)
        return
      }
      try {
        const { received } = await api.walletSync({ sinceMs: since })
        backoff = POLL_MS
        if (received.length > 0) {
          const newest = Math.max(...received.map((r) => Number(r.timestampMs)))
          since = Math.max(since, newest + 1) // advance past what we've seen so we never re-report it
          for (const r of received) emitDepositLanded(r)
          setLanded(received[received.length - 1])
        }
        void refresh() // adopt the fresh balance (a bump pre-lights the landed state, §11b)
      } catch {
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      }
      schedule(backoff)
    }

    const onVisible = (): void => {
      if (stopped || document.visibilityState !== 'visible') return
      if (timer) clearTimeout(timer)
      void tick() // resume immediately on foreground
    }

    schedule(START_DELAY_MS)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, refresh])

  return { landed }
}
