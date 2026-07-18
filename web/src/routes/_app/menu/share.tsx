import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Loader2, Share2 } from 'lucide-react'
import { MenuScreen, ScreenEmpty, ScreenError } from '@/components/menu/shared'
import { StatsCardSkeleton } from '@/components/menu/StatsCard'
import { Switch } from '@/ui/Switch'
import { HapticOverlay } from '@/components/HapticOverlay'
import { api } from '@/lib/api'
import type { UserStatsDTO } from '@/lib/api'
import type { RankStanding } from '@/lib/playerCard'
import { useAuth } from '@/lib/auth'
import { renderCard, shareStatsCard } from '@/lib/shareCard'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { haptic } from '@/lib/haptics'
import { displayHandle } from '@/utils/format'

// Share screen: a live preview of the exact card the PNG renders, one Share button, and a single knob.
// The card auto-builds (best stat featured, your board rank chipped) so there's nothing to configure; the
// only choice is whether to show your dollar P&L, which is private for some. Persists locally.
export const Route = createFileRoute('/_app/menu/share')({ component: ShareScreen })

function ShareScreen() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const q = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() })
  // Same key the leaderboard screen uses, so this reads warm cache; drives the "#4 TOP REKT" chip.
  const lbq = useQuery({ queryKey: ['leaderboard'], queryFn: () => api.leaderboard() })
  const stats = q.data?.stats
  const rank = lbq.data?.leaderboard.global.you ?? null

  return (
    <MenuScreen title="Share card">
      {q.isLoading ? (
        <StatsCardSkeleton />
      ) : q.isError ? (
        <ScreenError message="Could not load stats" onRetry={() => void q.refetch()} />
      ) : !stats || stats.gamesPlayed === 0 || !user ? (
        <ScreenEmpty illo="vault" title="No plays yet" sub="Make your first play to get a card to share.">
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
        <ShareEditor
          stats={stats}
          displayName={displayHandle(user)}
          avatarUrl={user.avatarUrl}
          twitter={user.twitter}
          rank={rank}
        />
      )}
    </MenuScreen>
  )
}

function ShareEditor({
  stats,
  displayName,
  avatarUrl,
  twitter,
  rank,
}: {
  stats: UserStatsDTO
  displayName: string
  avatarUrl?: string | null
  twitter?: { username: string } | null
  rank: RankStanding | null
}) {
  const [hidePnl, setHidePnl] = useLocalStorage<boolean>('pips_card_hide_pnl', false)
  const [sharing, setSharing] = useState(false)
  const showNetPnl = !hidePnl

  const doShare = async () => {
    if (sharing) return
    haptic('medium')
    setSharing(true)
    try {
      await shareStatsCard(stats, { displayName, avatarUrl, twitter }, { showNetPnl, rank })
      haptic('success')
    } catch {
      const { default: toast } = await import('react-hot-toast')
      toast.error('Could not make your card. Try again.', { id: 'share-card' })
    } finally {
      setSharing(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* The preview IS the exported PNG, so what you see is exactly what gets shared. */}
      <CardPreview stats={stats} displayName={displayName} avatarUrl={avatarUrl} twitter={twitter} showNetPnl={showNetPnl} rank={rank} />

      {/* The one knob: dollar P&L is private for a lot of people. */}
      <div className="surface-skeuo flex items-center gap-3 rounded-card px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-bold text-white">Show my P&L</div>
          <div className="mt-0.5 text-[12px] leading-snug text-text-3">Your net dollar profit on the card.</div>
        </div>
        <Switch
          label="Show my P&L"
          isSelected={showNetPnl}
          onChange={(v) => {
            haptic('selection')
            setHidePnl(!v)
          }}
        />
      </div>

      {/* Share. */}
      <div className="relative">
        <button
          type="button"
          disabled={sharing}
          className="btn-primary pointer-events-none flex w-full items-center justify-center gap-2 rounded-md py-3.5 text-[15px] font-extrabold uppercase tracking-wide disabled:opacity-70"
        >
          {sharing ? (
            <Loader2 className="h-[18px] w-[18px] animate-spin" strokeWidth={2.6} />
          ) : (
            <Share2 className="h-[18px] w-[18px]" strokeWidth={2.6} />
          )}
          {sharing ? 'Making your card' : 'Share card'}
        </button>
        <HapticOverlay className="absolute inset-0 rounded-md" preset="medium" disabled={sharing} silent onTap={() => void doShare()} />
      </div>
    </div>
  )
}

// The preview IS the real exported PNG (the canvas in shareCard.ts), so it's pixel-identical to what gets
// shared. Re-renders whenever an input changes (e.g. the P&L toggle).
function CardPreview({
  stats,
  displayName,
  avatarUrl,
  twitter,
  showNetPnl,
  rank,
}: {
  stats: UserStatsDTO
  displayName: string
  avatarUrl?: string | null
  twitter?: { username: string } | null
  showNetPnl: boolean
  rank: RankStanding | null
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [rendering, setRendering] = useState(true)
  const urlRef = useRef<string | null>(null)

  const swapUrl = (next: string | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = next
    setUrl(next)
  }

  useEffect(() => {
    let cancelled = false
    setRendering(true)
    renderCard(stats, { displayName, avatarUrl, twitter }, { showNetPnl, rank })
      .then((blob) => {
        if (!cancelled && blob) swapUrl(URL.createObjectURL(blob))
      })
      .finally(() => {
        if (!cancelled) setRendering(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats, displayName, avatarUrl, twitter, showNetPnl, rank])

  useEffect(() => () => swapUrl(null), [])

  return (
    <div className="relative aspect-[16/9] w-full overflow-hidden rounded-card bg-black/40 ring-1 ring-white/10">
      {url && <img src={url} alt="Your PIPS card" className="h-full w-full object-contain" />}
      {rendering && !url && (
        <div className="absolute inset-0 grid place-items-center">
          <Loader2 className="h-5 w-5 animate-spin text-white/50" strokeWidth={2.6} />
        </div>
      )}
    </div>
  )
}
