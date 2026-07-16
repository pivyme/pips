import { useEffect, useRef, useState } from 'react'

// Trailing-edge throttle: updates at most once per intervalMs, a change inside the window schedules one trailing update so the latest value always lands.
// Used for readouts fed by a fast tick stream (e.g. the top-bar live price) that would otherwise judder many times a second.
export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value)
  const lastUpdate = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(value)
  latest.current = value

  useEffect(() => {
    const elapsed = Date.now() - lastUpdate.current
    if (elapsed >= intervalMs) {
      lastUpdate.current = Date.now()
      setThrottled(value)
      return
    }
    if (timer.current) return // a trailing update is already scheduled, it will pick up latest.current
    timer.current = setTimeout(() => {
      timer.current = null
      lastUpdate.current = Date.now()
      setThrottled(latest.current)
    }, intervalMs - elapsed)
  }, [value, intervalMs])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  return throttled
}
