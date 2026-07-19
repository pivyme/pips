import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api, streamPlay, type Game, type PlayDTO, type PlayStatus, type PlayTick } from '@/lib/api'

export type LivePlaySnapshot = {
  markValue: string
  pnl: string
  multiplier: number
  entryValue?: string
  maxPayout?: string
  status: PlayStatus
  lockPrice?: string
  // Real minted market, carried so a mid-flight re-route/restrike snaps overlays + countdown (mergeSnapshotMarket).
  entrySpot?: string
  strike?: string
  lower?: string
  upper?: string
  expiry?: number
}

const toSnapshot = (play: PlayTick | PlayDTO): LivePlaySnapshot => ({
  markValue: play.markValue,
  pnl: play.pnl,
  multiplier: play.multiplier,
  entryValue: play.entryValue,
  maxPayout: play.maxPayout,
  status: play.status,
  lockPrice: play.lockPrice,
  entrySpot: play.entrySpot,
  // The SSE tick carries market fields flat; the full-DTO watchdog path nests them under `market`. Discriminate on `market` (always on the DTO, never on the tick).
  strike: 'market' in play ? play.market.strike : play.strike,
  lower: 'market' in play ? play.market.lower : play.lower,
  upper: 'market' in play ? play.market.upper : play.upper,
  expiry: 'market' in play ? play.market.expiry : play.expiry,
})

// Snap a play's real minted market onto the row when a mid-flight re-route/restrike moved it; returns the same
// reference when nothing changed, so React bails out of a no-op render. Only fields the overlays + countdown read.
export function mergeSnapshotMarket(play: PlayDTO, s: LivePlaySnapshot): PlayDTO {
  const entrySpot = s.entrySpot ?? play.entrySpot
  const strike = s.strike ?? play.market.strike
  const lower = s.lower ?? play.market.lower
  const upper = s.upper ?? play.market.upper
  const expiry = s.expiry ?? play.market.expiry
  if (
    entrySpot === play.entrySpot &&
    strike === play.market.strike &&
    lower === play.market.lower &&
    upper === play.market.upper &&
    expiry === play.market.expiry
  ) {
    return play
  }
  return { ...play, entrySpot, market: { ...play.market, strike, lower, upper, expiry } }
}

const syncOpenBalance = (
  status: PlayStatus,
  playId: string,
  syncedOpenPlayIdRef?: MutableRefObject<string | null>,
  refreshOnOpen?: () => void | Promise<void>,
) => {
  if (status !== 'open' || !refreshOnOpen) return
  if (syncedOpenPlayIdRef?.current === playId) return
  if (syncedOpenPlayIdRef) syncedOpenPlayIdRef.current = playId
  void refreshOnOpen()
}

export function usePlayResolutionWatch({
  enabled,
  playId,
  finalizedRef,
  watchdogMs,
  syncedOpenPlayIdRef,
  refreshOnOpen,
  onSnapshot,
  onTerminal,
}: {
  enabled: boolean
  playId?: string | null
  finalizedRef: MutableRefObject<boolean>
  watchdogMs: number
  syncedOpenPlayIdRef?: MutableRefObject<string | null>
  refreshOnOpen?: () => void | Promise<void>
  onSnapshot: (snapshot: LivePlaySnapshot) => void
  onTerminal: (status: PlayStatus, playId: string) => void
}) {
  // Inline closures get a new identity every render; keeping them as effect deps tore down and reopened the
  // EventSource on every tick. Read the latest callback via a ref so effects only reopen on enabled/playId flipping.
  const onSnapshotRef = useRef(onSnapshot)
  const onTerminalRef = useRef(onTerminal)
  const refreshOnOpenRef = useRef(refreshOnOpen)
  onSnapshotRef.current = onSnapshot
  onTerminalRef.current = onTerminal
  refreshOnOpenRef.current = refreshOnOpen

  // When the SSE last delivered a frame. The backend SSE is event-driven, so the watchdog below only hits the
  // network once the stream goes quiet past watchdogMs (stalled proxy, dropped socket, or a cross-process settle the play-bus missed). Shared between the two effects.
  const lastFrameAtRef = useRef(0)

  useEffect(() => {
    if (!enabled || !playId) return
    lastFrameAtRef.current = Date.now() // arm the quiet window from open, not from epoch
    return streamPlay(
      playId,
      (tick) => {
        if (finalizedRef.current) return
        lastFrameAtRef.current = Date.now()
        onSnapshotRef.current(toSnapshot(tick))
        syncOpenBalance(tick.status, playId, syncedOpenPlayIdRef, refreshOnOpenRef.current)
        onTerminalRef.current(tick.status, playId)
      },
      () => {
        // EventSource auto-reconnects. The watchdog below still guarantees the terminal frame lands.
      },
    )
  }, [enabled, finalizedRef, playId, syncedOpenPlayIdRef])

  // Lazy watchdog: reads the DB only when the SSE has gone silent past watchdogMs, reconciles once, then re-arms.
  // On a healthy stream it never hits the network (the redundant-poll removal from TRADE_REALTIME.md §1e, degraded to a true fallback).
  useEffect(() => {
    if (!enabled || !playId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>

    const arm = (delay: number): void => {
      timer = setTimeout(() => void check(), delay)
    }
    const check = async (): Promise<void> => {
      if (stopped || finalizedRef.current) return
      const quietFor = Date.now() - lastFrameAtRef.current
      if (quietFor < watchdogMs) {
        arm(watchdogMs - quietFor) // a frame arrived recently; recheck only when the window would lapse
        return
      }
      try {
        const { play } = await api.getPlay(playId)
        if (stopped || finalizedRef.current) return
        lastFrameAtRef.current = Date.now()
        onSnapshotRef.current(toSnapshot(play))
        syncOpenBalance(play.status, playId, syncedOpenPlayIdRef, refreshOnOpenRef.current)
        onTerminalRef.current(play.status, playId)
      } catch {
        // transient; the next arm retries
      }
      if (!stopped && !finalizedRef.current) arm(watchdogMs)
    }

    arm(watchdogMs)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [enabled, finalizedRef, playId, syncedOpenPlayIdRef, watchdogMs])
}

export function useRoundCountdown({
  enabled,
  play,
  fallbackDurationSec,
  intervalMs = 250,
}: {
  enabled: boolean
  play: PlayDTO | null
  fallbackDurationSec: number
  intervalMs?: number
}) {
  const [secsLeft, setSecsLeft] = useState<number | null>(null)
  const [remainingMs, setRemainingMs] = useState<number | null>(null)
  const [settleMs, setSettleMs] = useState(0)

  useEffect(() => {
    if (!enabled || !play) {
      setSecsLeft(null)
      setRemainingMs(null)
      setSettleMs(0)
      return
    }

    const openedAt = play.openedAt ? Date.parse(play.openedAt) : Date.now()
    const durationSec =
      'duration' in play.params && typeof play.params.duration === 'number'
        ? play.params.duration
        : fallbackDurationSec
    const endAt = play.market.expiry || openedAt + durationSec * 1000

    const tick = () => {
      const remaining = endAt - Date.now()
      setSecsLeft(Math.max(0, Math.ceil(remaining / 1000)))
      setRemainingMs(remaining)
      setSettleMs(remaining < 0 ? -remaining : 0)
    }

    tick()
    const interval = setInterval(tick, intervalMs)
    return () => clearInterval(interval)
  }, [enabled, fallbackDurationSec, intervalMs, play])

  return { secsLeft, remainingMs, settleMs }
}

// Restore a live round when a game screen (re)mounts. The durable `GET /plays?status=open` is the truth that
// survives navigating Home and back AND a hard refresh (the in-session phase/play state does not). Fires
// onRestore once with this game's open play, so the screen rehydrates into its live phase instead of idle.
// Reuses the hub's query key, so Home -> game hits the warm cache and restores with no flash; a cold refresh
// fetches fresh. `active` gates it off once the player has a round going this mount (never clobbers a fresh mint).
export function useRestoreOpenPlay({
  game,
  active,
  onRestore,
}: {
  game: Game
  active: boolean
  onRestore: (play: PlayDTO) => void
}) {
  const restoredRef = useRef(false)
  const onRestoreRef = useRef(onRestore)
  onRestoreRef.current = onRestore

  const openQ = useQuery({
    queryKey: ['plays', 'open'],
    queryFn: () => api.plays({ status: 'open', limit: 30 }),
    refetchInterval: 5000,
    staleTime: 3000,
    retry: false,
  })

  const plays = openQ.data?.plays
  useEffect(() => {
    if (restoredRef.current || active || !plays) return
    const match = plays.find((p) => p.game === game)
    if (!match) return
    restoredRef.current = true
    onRestoreRef.current(match)
  }, [plays, active, game])

  // True until the first open-plays fetch settles. On a cold refresh the screen is momentarily idle before
  // restore lands, so callers gate PLAY on this to avoid opening a second round on top of a live one.
  return { restorePending: openQ.isLoading && !restoredRef.current }
}

export function usePhaseElapsed(active: boolean, intervalMs = 100): number {
  const [elapsedMs, setElapsedMs] = useState(0)

  useEffect(() => {
    if (!active) {
      setElapsedMs(0)
      return
    }
    const startedAt = Date.now()
    const interval = setInterval(() => setElapsedMs(Date.now() - startedAt), intervalMs)
    return () => clearInterval(interval)
  }, [active, intervalMs])

  return elapsedMs
}
