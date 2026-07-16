// A single app-level watcher + overlay that surfaces every unlock, however it happened. The settle
// worker has no channel back to the client, so this diffs the ['achievements'] query against a per-user "seen" set in localStorage, blooming in anything newly unlocked.

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { resolveAchievement, type ResolvedAchievement } from '@/lib/achievements'
import { achievementUnlock } from '@/lib/sound'
import { haptic } from '@/lib/haptics'

const SEEN_PREFIX = 'pips_ach_seen:'
// On a user's first run we suppress the historical backlog, except anything just earned: an unlock
// fresher than RECENT_MS still surfaces so a play that settled right before load isn't swallowed.
const RECENT_MS = 120_000
// Let the round's result land and read for a beat before the celebration blooms over it; the query refetch already lags slightly anyway.
const SHOW_DELAY_MS = 1400
const AUTO_CLOSE_MS = 3000

function readSeen(userId: string): { seen: Set<string>; firstRun: boolean } {
  try {
    const raw = localStorage.getItem(SEEN_PREFIX + userId)
    if (raw == null) return { seen: new Set(), firstRun: true }
    return { seen: new Set(JSON.parse(raw) as string[]), firstRun: false }
  } catch {
    return { seen: new Set(), firstRun: true }
  }
}

function writeSeen(userId: string, slugs: Iterable<string>): void {
  try {
    localStorage.setItem(SEEN_PREFIX + userId, JSON.stringify([...slugs]))
  } catch {
    // storage blocked: the in-session set still dedupes; a reload may re-surface, harmless
  }
}

// Big and bold for a single trophy; tighter as more land together so a multi-unlock still fits.
function stickerSize(count: number): number {
  if (count <= 1) return 184
  if (count === 2) return 152
  if (count === 3) return 132
  return 110
}

export function AchievementCelebration() {
  const { status, user } = useAuth()
  const reduced = useReducedMotion()
  const userId = user?.id

  const q = useQuery({
    queryKey: ['achievements'],
    queryFn: () => api.achievements(),
    enabled: status === 'authed' && !!userId,
    staleTime: 5_000,
  })

  const [queue, setQueue] = useState<ResolvedAchievement[][]>([])
  const [current, setCurrent] = useState<ResolvedAchievement[] | null>(null)

  // Diff the freshly fetched unlocks against what this user has already seen, enqueue the rest.
  useEffect(() => {
    if (!userId || !q.data) return
    const unlocked = q.data.achievements.filter((a) => a.unlocked)
    const { seen, firstRun } = readSeen(userId)
    const fresh = unlocked.filter((a) => !seen.has(a.slug))
    // Advance the baseline to the full current set (so a celebrated unlock never re-fires on reload).
    if (fresh.length > 0 || firstRun) writeSeen(userId, unlocked.map((a) => a.slug))
    if (fresh.length === 0) return
    const now = Date.now()
    const toShow = firstRun
      ? fresh.filter((a) => a.unlockedAt != null && now - Date.parse(a.unlockedAt) < RECENT_MS)
      : fresh
    if (toShow.length > 0) setQueue((qq) => [...qq, toShow.map((a) => resolveAchievement(a.slug))])
  }, [q.data, userId])

  // Pop the next batch once the screen is clear, after the post-result beat. Sound + haptic on appear.
  useEffect(() => {
    if (current || queue.length === 0) return
    const next = queue[0]
    const id = window.setTimeout(() => {
      setQueue((qq) => qq.slice(1))
      setCurrent(next)
      // A sound/haptic hiccup on some exotic browser must never break the celebration flow.
      try {
        achievementUnlock()
        haptic('success')
      } catch {
        // ignore
      }
    }, SHOW_DELAY_MS)
    return () => window.clearTimeout(id)
  }, [current, queue])

  // Auto-close after the hold; a tap dismisses early.
  useEffect(() => {
    if (!current) return
    const id = window.setTimeout(() => setCurrent(null), AUTO_CLOSE_MS)
    return () => window.clearTimeout(id)
  }, [current])

  const count = current?.length ?? 0
  const size = stickerSize(count)

  return (
    <AnimatePresence>
      {current && (
        <motion.div
          key="ach-celebration"
          role="status"
          aria-live="polite"
          onClick={() => setCurrent(null)}
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 px-6 backdrop-blur-2xl"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0.18 : 0.42, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* Warm amber bloom behind the cluster, breathing slowly. */}
          {!reduced && (
            <motion.div
              aria-hidden
              className="pointer-events-none absolute h-[64vmin] w-[64vmin] rounded-full"
              style={{ background: 'radial-gradient(circle, rgba(255,179,0,0.24) 0%, rgba(255,179,0,0) 70%)' }}
              animate={{ scale: [1, 1.12, 1], opacity: [0.5, 0.78, 0.5] }}
              transition={{ duration: 3.4, repeat: Infinity, ease: 'easeInOut' }}
            />
          )}

          <div className="relative flex w-full max-w-[520px] flex-col items-center gap-7 text-center">
            <motion.h2
              className="text-[30px] font-extrabold leading-none tracking-tight text-white"
              initial={reduced ? false : { opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: reduced ? 0 : 0.08, duration: 0.4, ease: 'easeOut' }}
            >
              {count === 1 ? 'New Achievement!' : 'New Achievements!'}
            </motion.h2>

            <div className="flex flex-wrap items-start justify-center gap-x-8 gap-y-5">
              {current.map((a, i) => (
                <motion.div
                  key={a.slug}
                  className="flex flex-col items-center gap-3"
                  initial={reduced ? false : { opacity: 0, scale: 0.3, y: 18, rotate: -8 }}
                  animate={{ opacity: 1, scale: 1, y: 0, rotate: 0 }}
                  transition={
                    reduced
                      ? { duration: 0.2 }
                      : { type: 'spring', stiffness: 360, damping: 17, delay: 0.2 + i * 0.1 }
                  }
                >
                  <img
                    src={a.image}
                    alt={a.name}
                    draggable={false}
                    style={{
                      width: size,
                      height: size,
                      filter: 'drop-shadow(0 16px 26px rgba(0,0,0,0.5)) drop-shadow(0 0 22px rgba(255,179,0,0.34))',
                    }}
                    className="object-contain"
                  />
                  <span className="max-w-[160px] text-[17px] font-semibold leading-tight text-white">
                    {a.name}
                  </span>
                </motion.div>
              ))}
            </div>

            <motion.span
              className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/40"
              initial={reduced ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: reduced ? 0 : 0.5, duration: 0.4 }}
            >
              Tap to dismiss
            </motion.span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
