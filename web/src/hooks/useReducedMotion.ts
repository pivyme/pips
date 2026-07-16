import { useEffect, useState } from 'react'
import { useAuth } from '@/lib/auth'

// Single source of truth for "calm down the motion": honors both the in-app Settings toggle and OS-level prefers-reduced-motion.
// The chart and rolling numbers read this to switch to discrete, non-animated updates.
export function useReducedMotion(): boolean {
  const { user } = useAuth()
  const [osReduced, setOsReduced] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setOsReduced(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setOsReduced(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return Boolean(user?.settings.reducedMotion) || osReduced
}
