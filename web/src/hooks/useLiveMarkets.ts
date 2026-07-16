import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api, streamMarkets, type MarketDTO, type MarketsTick } from '@/lib/api'

// Shared market feed for the games: seeds once from api.markets(), then live-updates over /stream/markets SSE, no per-client polling.
// Two grace mechanics stop a brief oracle-ladder blip from flashing "Market catching up": blackout only surfaces after BLACKOUT_GRACE_MS, and the last live set holds through the blip.

const BLACKOUT_GRACE_MS = 6_000

export type LiveMarkets = {
  markets: MarketDTO[] // what to render (holds the last live set through a brief blip)
  liveAssets: string[] // tradeable right now, never graced (drives canPlay)
  allAssets: string[]
  spotByAsset: Record<string, number>
  noLiveMarket: boolean // graced: true only after a sustained outage
  playsPaused: boolean // real-mode sponsor-floor pause: new plays are blocked while gas tops up
  isLoading: boolean
  isError: boolean
  refetch: () => void
}

export function useLiveMarkets(): LiveMarkets {
  // Seed once for first paint (and as the reconnect/error fallback); no refetchInterval since updates arrive over the SSE below.
  const seed = useQuery({
    queryKey: ['markets'],
    queryFn: () => api.markets(),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })

  // Latest pushed frame from the SSE, overrides the seed once it lands; EventSource auto-reconnects and re-primes on every (re)connect, so a dropped socket self-heals with no polling.
  const [pushed, setPushed] = useState<MarketsTick | null>(null)
  useEffect(() => streamMarkets((t) => setPushed(t)), [])

  const data = pushed ?? seed.data
  const fresh = data?.markets ?? []
  const liveAssets = fresh.filter((m) => m.live).map((m) => m.asset)

  // Keep the last set that actually had a live market so a brief outage doesn't blank the device.
  const lastLiveRef = useRef<MarketDTO[]>([])
  if (liveAssets.length > 0) lastLiveRef.current = fresh

  // Still loading until either a push or seed lands; error only if the seed failed AND no frame ever pushed.
  const isLoading = !data
  const isError = !data && seed.isError

  // Flip the blackout only after the chain stays empty past the grace window, clear it immediately on recovery.
  // A cold outage (never had a live market, e.g. opened mid-outage) shows at once since there's nothing to hold over. Timer-driven so it doesn't wait on a frame.
  const [blackout, setBlackout] = useState(false)
  const empty = !isLoading && !isError && liveAssets.length === 0
  useEffect(() => {
    if (!empty) {
      setBlackout(false)
      return
    }
    if (lastLiveRef.current.length === 0) {
      setBlackout(true)
      return
    }
    const t = setTimeout(() => setBlackout(true), BLACKOUT_GRACE_MS)
    return () => clearTimeout(t)
  }, [empty])

  const markets = liveAssets.length > 0 || blackout ? fresh : lastLiveRef.current
  const spotByAsset: Record<string, number> = {}
  for (const m of markets) {
    const s = parseFloat(m.spot)
    if (Number.isFinite(s) && s > 0) spotByAsset[m.asset] = s
  }

  return {
    markets,
    liveAssets,
    allAssets: markets.map((m) => m.asset),
    spotByAsset,
    noLiveMarket: blackout,
    playsPaused: data?.playsPaused ?? false,
    isLoading,
    isError,
    refetch: () => void seed.refetch(),
  }
}
