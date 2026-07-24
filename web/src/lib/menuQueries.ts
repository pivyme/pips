import { queryOptions } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { NETWORK } from '@/lib/sui/config'

// One source of truth for the menu screens' data. Both the on-screen useQuery and the drawer's
// background prefetch pull from here, so the cached key can never drift from what a screen reads.

// Menu data moves slowly within a session, so keep it warm: no refetch on every remount/refocus, which
// is what made re-opening a screen feel instant but the first open feel cold. Screens still refetch on retry.
const MENU_STALE = 60_000

export const statsQuery = () =>
  queryOptions({ queryKey: ['stats'], queryFn: () => api.stats(), staleTime: MENU_STALE })

export const leaderboardQuery = () =>
  queryOptions({ queryKey: ['leaderboard'], queryFn: () => api.leaderboard(), staleTime: MENU_STALE })

export const achievementsQuery = () =>
  queryOptions({ queryKey: ['achievements'], queryFn: () => api.achievements(), staleTime: MENU_STALE })

export const referralQuery = () =>
  queryOptions({ queryKey: ['referral'], queryFn: () => api.referral(), staleTime: MENU_STALE })

export const depositOptionsQuery = () =>
  queryOptions({ queryKey: ['deposit-options'], queryFn: () => api.depositOptions(), staleTime: 5 * 60_000 })

// Held coins (the send picker) + the activity feed's first page. Short staleTime: money moves, so a re-open
// should feel current, but a warmed key still lands the first frame from cache.
export const walletCoinsQuery = () =>
  queryOptions({ queryKey: ['wallet-coins'], queryFn: () => api.walletCoins(), staleTime: 8_000 })

export const walletTransactionsQuery = () =>
  queryOptions({ queryKey: ['wallet-transactions'], queryFn: () => api.walletTransactions({ limit: 50 }), staleTime: 5_000 })

// History defaults to showing devnet rows (see history.tsx), so the warmed key must match that first render.
export const historyQuery = (showDevnet: boolean) =>
  queryOptions({
    queryKey: ['plays', 'history', showDevnet],
    queryFn: () => api.plays({ limit: 50, network: showDevnet ? undefined : NETWORK }),
    staleTime: MENU_STALE,
  })

// Warm every menu sub-screen the moment the menu opens, so the first tap into any of them renders from
// cache instead of a cold round trip. prefetchQuery respects staleTime (already-warm keys are no-ops) and
// never throws, the screen's own query still surfaces any error on open.
export function prefetchMenuData(qc: QueryClient): void {
  void qc.prefetchQuery(statsQuery())
  void qc.prefetchQuery(leaderboardQuery())
  void qc.prefetchQuery(achievementsQuery())
  void qc.prefetchQuery(referralQuery())
  void qc.prefetchQuery(depositOptionsQuery())
  void qc.prefetchQuery(historyQuery(true))
  void qc.prefetchQuery(walletTransactionsQuery())
}
