import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { MenuScreen, ScreenEmpty, ScreenError } from '@/components/menu/shared'
import { StatsCard, StatsCardSkeleton } from '@/components/menu/StatsCard'
import { Button } from '@/ui/Button'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { shareStatsCard } from '@/lib/shareCard'
import { haptic } from '@/lib/haptics'
import { HapticOverlay } from '@/components/HapticOverlay'
import { displayHandle } from '@/utils/format'

// The shareable trader card detail. "Share card" renders the same card to a PNG and opens the
// native share sheet. Reached by tapping the card on the menu home.
export const Route = createFileRoute('/_app/menu/stats')({ component: StatsScreen })

function StatsScreen() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const q = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() })
  const [sharing, setSharing] = useState(false)

  const stats = q.data?.stats

  const onShare = async () => {
    if (!stats || !user) return
    haptic('medium')
    setSharing(true)
    try {
      await shareStatsCard(stats, { displayName: displayHandle(user), avatarUrl: user.avatarUrl })
      haptic('success')
    } catch {
      const { default: toast } = await import('react-hot-toast')
      toast.error('Could not make your card. Try again.', { id: 'share-card' })
    } finally {
      setSharing(false)
    }
  }

  return (
    <MenuScreen title="Stats">
      {q.isLoading ? (
        <StatsCardSkeleton />
      ) : q.isError ? (
        <ScreenError message="Could not load stats" onRetry={() => void q.refetch()} />
      ) : !stats || stats.gamesPlayed === 0 ? (
        <ScreenEmpty illo="vault" title="No plays yet" sub="Make your first play to fill this in.">
          <div className="relative inline-block">
            <Link
              to="/games"
              onClick={() => haptic('medium')}
              className="pointer-events-none btn-primary flex rounded-full px-5 py-2.5 text-sm font-extrabold uppercase tracking-wide"
            >
              Play now
            </Link>
            <HapticOverlay
              className="absolute inset-0 rounded-full"
              preset="medium"
              silent
              onTap={() => void navigate({ to: '/games' })}
            />
          </div>
        </ScreenEmpty>
      ) : (
        <div className="flex flex-col gap-4">
          <StatsCard stats={stats} displayName={displayHandle(user)} />
          <div className="relative w-full">
            <Button disabled={sharing} onClick={() => void onShare()} className="pointer-events-none w-full">
              {sharing ? 'Making your card...' : 'Share card'}
            </Button>
            <HapticOverlay
              className="absolute inset-0 rounded-md"
              preset="medium"
              disabled={sharing}
              silent
              onTap={() => void onShare()}
            />
          </div>
        </div>
      )}
    </MenuScreen>
  )
}
