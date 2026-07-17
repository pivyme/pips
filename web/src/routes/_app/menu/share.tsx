import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Loader2, Share2 } from 'lucide-react'
import { MenuScreen, ScreenEmpty, ScreenError } from '@/components/menu/shared'
import { StatsCard, StatsCardSkeleton } from '@/components/menu/StatsCard'
import { Switch } from '@/ui/Switch'
import { HapticOverlay } from '@/components/HapticOverlay'
import { api } from '@/lib/api'
import type { UserStatsDTO } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import type { CardConfig, Kind } from '@/lib/playerCard'
import {
  ALL_KINDS,
  KIND_ICON,
  KIND_LABEL,
  MAX_GRID,
  defaultCardConfig,
  sanitizeConfig,
} from '@/lib/playerCard'
import { shareStatsCard } from '@/lib/shareCard'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { haptic } from '@/lib/haptics'
import { displayHandle } from '@/utils/format'
import { cnm } from '@/utils/style'

// The share screen: a live preview of the exact card the PNG will render, plus the controls to make it
// yours before it leaves your hands. Net P&L is private for a lot of people, so it's a first-class toggle;
// the hero and the small stats are yours to pick too. Choices persist locally (pips_card_share) so the next
// share remembers them; the menu-home card stays on the auto default (it never reads this override).
export const Route = createFileRoute('/_app/menu/share')({ component: ShareScreen })

function ShareScreen() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const q = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() })
  const stats = q.data?.stats

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
        <ShareEditor stats={stats} displayName={displayHandle(user)} avatarUrl={user.avatarUrl} />
      )}
    </MenuScreen>
  )
}

function ShareEditor({
  stats,
  displayName,
  avatarUrl,
}: {
  stats: UserStatsDTO
  displayName: string
  avatarUrl?: string | null
}) {
  const [override, setOverride] = useLocalStorage<CardConfig | null>('pips_card_share', null)
  const config = useMemo(
    () => (override ? sanitizeConfig(override, stats) : defaultCardConfig(stats)),
    [override, stats],
  )
  const [sharing, setSharing] = useState(false)

  const gridFull = config.grid.length >= MAX_GRID
  const customized = override != null

  const setHero = (k: Kind) => {
    if (k === config.hero) return
    haptic('selection')
    // The new hero can't also sit in the grid; drop it there if present.
    setOverride({ ...config, hero: k, grid: config.grid.filter((g) => g !== k) })
  }

  const toggleGrid = (k: Kind, on: boolean) => {
    if (on && (gridFull || config.grid.includes(k))) return
    setOverride({ ...config, grid: on ? [...config.grid, k] : config.grid.filter((g) => g !== k) })
  }

  const reset = () => {
    haptic('selection')
    setOverride(null)
  }

  const doShare = async () => {
    if (sharing) return
    haptic('medium')
    setSharing(true)
    try {
      await shareStatsCard(stats, { displayName, avatarUrl }, config)
      haptic('success')
    } catch {
      const { default: toast } = await import('react-hot-toast')
      toast.error('Could not make your card. Try again.', { id: 'share-card' })
    } finally {
      setSharing(false)
    }
  }

  // The stats that can toggle into the grid: everything except the hero (it has its own big slot).
  const gridPool = ALL_KINDS.filter((k) => k !== config.hero)

  return (
    <div className="flex flex-col gap-5">
      {/* Live preview: the exact card the PNG will render. */}
      <StatsCard stats={stats} displayName={displayName} avatarUrl={avatarUrl} config={config} />

      {/* Featured: the big hero number. */}
      <div>
        <div className="flex items-center justify-between">
          <SectionLabel>Featured</SectionLabel>
          {customized && (
            <div className="relative">
              <button
                type="button"
                className="pointer-events-none text-[12px] font-bold uppercase tracking-wide text-text-3 transition active:scale-95"
              >
                Reset
              </button>
              <HapticOverlay className="absolute inset-0" preset="selection" silent onTap={reset} />
            </div>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {ALL_KINDS.map((k) => (
            <Chip key={k} label={KIND_LABEL[k]} icon={KIND_ICON[k]} selected={k === config.hero} onTap={() => setHero(k)} />
          ))}
        </div>
      </div>

      {/* Shown: Net P&L + the small stat cells. */}
      <div>
        <SectionLabel>Shown on card</SectionLabel>
        <div className="mt-2 flex flex-col gap-2">
          <ToggleRow
            label="Net P&L"
            selected={config.showNetPnl}
            onChange={(v) => setOverride({ ...config, showNetPnl: v })}
          />
          {gridPool.map((k) => {
            const on = config.grid.includes(k)
            return (
              <ToggleRow
                key={k}
                label={KIND_LABEL[k]}
                icon={KIND_ICON[k]}
                selected={on}
                disabled={!on && gridFull}
                onChange={(v) => toggleGrid(k, v)}
              />
            )
          })}
          <p className="px-1 text-[12px] leading-snug text-text-3">Up to {MAX_GRID} stat cells. Tap a chip above to feature it big.</p>
        </div>
      </div>

      {/* Share. */}
      <div className="relative">
        <button
          type="button"
          disabled={sharing}
          className="btn-primary pointer-events-none flex w-full items-center justify-center gap-2 rounded-md py-3.5 text-[15px] font-extrabold uppercase tracking-wide disabled:opacity-70"
        >
          {sharing ? <Loader2 className="h-[18px] w-[18px] animate-spin" strokeWidth={2.6} /> : <Share2 className="h-[18px] w-[18px]" strokeWidth={2.6} />}
          {sharing ? 'Making your card' : 'Share card'}
        </button>
        <HapticOverlay className="absolute inset-0 rounded-md" preset="medium" disabled={sharing} silent onTap={() => void doShare()} />
      </div>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">{children}</div>
}

function Chip({ label, icon, selected, onTap }: { label: string; icon?: string; selected: boolean; onTap: () => void }) {
  return (
    <div className="relative">
      <button
        type="button"
        className={cnm(
          'pointer-events-none flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-bold transition-transform active:scale-95',
          selected ? 'border-brand-500 bg-brand-500/15 text-brand-400' : 'border-line bg-white/[0.04] text-text-2',
        )}
      >
        {icon && <img src={icon} alt="" aria-hidden className="h-4 w-4 object-contain" />}
        {label}
      </button>
      <HapticOverlay className="absolute inset-0 rounded-full" preset="selection" silent onTap={onTap} />
    </div>
  )
}

function ToggleRow({
  label,
  icon,
  selected,
  disabled,
  onChange,
}: {
  label: string
  icon?: string
  selected: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className={cnm('surface-skeuo flex items-center gap-3 rounded-card px-4 py-3', disabled && 'opacity-50')}>
      {icon && <img src={icon} alt="" aria-hidden className="h-5 w-5 shrink-0 object-contain" />}
      <div className="min-w-0 flex-1 text-[15px] font-bold text-white">{label}</div>
      <Switch label={label} isSelected={selected} isDisabled={disabled} onChange={onChange} />
    </div>
  )
}
