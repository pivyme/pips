import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api, type MarketDTO } from '@/lib/api'

// Shared market feed for the games (lucky, range, moonshot). The chain's oracle ladder rolls every few seconds
// and the operator can briefly fall behind, so `live` flickers off for a moment now and then. Three
// things keep that from flashing the scary "Market catching up" screen at the player:
//
//  1. Poll fast, and faster while nothing is live, so the UI recovers within a poll of the chain coming
//     back instead of sitting stale for the old 10s interval.
//  2. Grace the blackout: only surface "no market" after the chain has been empty for BLACKOUT_GRACE_MS.
//     A real outage trips it; a single ladder roll never does. It clears the instant a market returns.
//  3. Hold the last live set on screen through a brief blip so the device keeps its charts instead of
//     blanking, then handing over to the message only if the outage is real.
//
// `liveAssets` stays instantaneous (it gates whether a play can actually mint), only the message is graced.

const POLL_MS = 3_000
const POLL_MS_EMPTY = 1_500
const BLACKOUT_GRACE_MS = 6_000

export type LiveMarkets = {
  markets: MarketDTO[] // what to render (holds the last live set through a brief blip)
  liveAssets: string[] // tradeable right now, never graced (drives canPlay)
  allAssets: string[]
  spotByAsset: Record<string, number>
  noLiveMarket: boolean // graced: true only after a sustained outage
  isLoading: boolean
  isError: boolean
  refetch: () => void
}

export function useLiveMarkets(): LiveMarkets {
  const q = useQuery({
    queryKey: ['markets'],
    queryFn: () => api.markets(),
    refetchInterval: (query) =>
      query.state.data?.markets.some((m) => m.live) ? POLL_MS : POLL_MS_EMPTY,
    placeholderData: (prev) => prev,
  })

  const fresh = q.data?.markets ?? []
  const liveAssets = fresh.filter((m) => m.live).map((m) => m.asset)

  // Keep the last set that actually had a live market so a brief outage doesn't blank the device.
  const lastLiveRef = useRef<MarketDTO[]>([])
  if (liveAssets.length > 0) lastLiveRef.current = fresh

  // Flip the blackout only after the chain stays empty past the grace window; clear it immediately on
  // recovery. A cold outage (we never had a live market, e.g. opened mid-outage) shows at once, there is
  // nothing to hold over. Timer-driven so the message appears/clears without waiting on a poll.
  const [blackout, setBlackout] = useState(false)
  const empty = !q.isLoading && !q.isError && liveAssets.length === 0
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
    isLoading: q.isLoading,
    isError: q.isError,
    refetch: () => void q.refetch(),
  }
}
