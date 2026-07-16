import { useEffect, useRef, useState, type MutableRefObject } from 'react'

import { api, streamPlay, type PlayDTO, type PlayStatus, type PlayTick } from '@/lib/api'

export type LivePlaySnapshot = {
  markValue: string
  pnl: string
  multiplier: number
  entryValue?: string
  maxPayout?: string
  status: PlayStatus
  lockPrice?: string
}

const toSnapshot = (play: PlayTick | PlayDTO): LivePlaySnapshot => ({
  markValue: play.markValue,
  pnl: play.pnl,
  multiplier: play.multiplier,
  entryValue: play.entryValue,
  maxPayout: play.maxPayout,
  status: play.status,
  lockPrice: play.lockPrice,
})

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
  // Callers pass inline closures that get a new identity every render (they close over local state
  // setters). Keeping them as effect deps tore the EventSource down and reopened it on every single
  // tick. Read the latest callback via a ref instead, so the effects only reopen on what should
  // actually reopen them: enabled/playId flipping.
  const onSnapshotRef = useRef(onSnapshot)
  const onTerminalRef = useRef(onTerminal)
  const refreshOnOpenRef = useRef(refreshOnOpen)
  onSnapshotRef.current = onSnapshot
  onTerminalRef.current = onTerminal
  refreshOnOpenRef.current = refreshOnOpen

  // When the SSE last delivered a frame. The backend SSE is now event-driven (it pushes the instant the
  // status commits), so the watchdog below only hits the network when the stream has gone quiet past
  // watchdogMs (a stalled proxy, a dropped socket mid-reconnect, or a cross-process settle the in-process
  // play-bus never emitted to this box). On a healthy stream every frame pushes this forward and the
  // watchdog never fires. Shared between the two effects.
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

  // Lazy watchdog: a single safety net that reads the DB ONLY when the event-driven SSE has gone silent
  // past watchdogMs. It reconciles once, feeds the same callbacks, then re-arms. On a healthy stream it
  // keeps re-arming without ever hitting the network (this is the redundant-poll removal from
  // TRADE_REALTIME.md §1e, degraded to a true fallback).
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
