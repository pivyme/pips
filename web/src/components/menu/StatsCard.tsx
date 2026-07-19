import { Loader2, Pencil, Share2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { UserStatsDTO } from '@/lib/api'
import type { CardStat, CardTone, RankBadge, RankStanding } from '@/lib/playerCard'
import { buildCardModel } from '@/lib/playerCard'
import { Avatar } from '@/components/Avatar'
import { XGlyph } from '@/components/menu/BrandGlyphs'
import { cnm } from '@/utils/style'

// Tone -> ink. Gold is the featured/brag color, up/down for signed facts, white for neutral.
const toneText = (t: CardTone): string =>
  t === 'gold' ? 'text-brand-400' : t === 'up' ? 'text-up' : t === 'down' ? 'text-down' : 'text-white'

// The shareable trader card, styled as a little PIPS handheld: a bright amber bezel with a branded
// screen window. Shown on menu home (pen + share icons) and the Stats screen (Share renders this to a PNG via shareCard.ts, keep them in sync). Presentational, no data fetching.

export function StatsCard({
  stats,
  displayName,
  avatarUrl,
  twitter,
  showNetPnl,
  rank,
  onEdit,
  onShare,
  sharing,
}: {
  stats: UserStatsDTO
  displayName: string
  // The custom uploaded avatar, or null (the PIPS identicon renders when absent).
  avatarUrl?: string | null
  // The linked (server-verified) X account, or null. When set, an X pill sits under the handle.
  twitter?: { username: string } | null
  // Whether Net P&L is on the card (dollar P&L is private for some). Defaults on.
  showNetPnl?: boolean
  // The player's global-board standing, drives the rank chip. Omitted/null = no chip.
  rank?: RankStanding | null
  // When set, a pen sits next to the handle so it can be changed. Omitted on the shareable card.
  onEdit?: () => void
  // When set, a share icon sits beside the pen for one-tap PNG export (renders the card via shareCard.ts).
  onShare?: () => void
  sharing?: boolean // share in progress: the icon spins and disables
}) {
  const card = buildCardModel(stats, { showNetPnl, rank })

  return (
    // @container: the card sizes text + padding off its OWN width (cqi), not the viewport, so it shrinks
    // gracefully in a narrow drawer instead of numbers colliding. Clamp maxes match the original sizes, so a normal width looks exactly as before.
    <div className="trader-bezel @container overflow-hidden rounded-[26px] p-2.5">
      <CardHeader />
      <div className="trader-screen relative overflow-hidden rounded-[18px] p-[clamp(13px,5cqi,20px)]">
        {/* Single row, same height as before. The rank chip is taken out of flow (absolute, under the actions)
            so it never eats the name's width. With no actions it just sits top-right (e.g. the exported card). */}
        <div className="relative flex items-center gap-[clamp(8px,3cqi,12px)]">
          <Avatar
            name={displayName}
            src={avatarUrl}
            size={44}
            className="shrink-0 ring-1 ring-white/15"
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="truncate text-[clamp(17px,6cqi,24px)] font-extrabold leading-tight text-white">{displayName}</div>
            {twitter && (
              <span className="mt-[3px] inline-flex w-fit max-w-full items-center gap-1 rounded-full bg-white/[0.08] py-[2px] pl-1.5 pr-2 text-[clamp(10px,3.2cqi,12px)] font-semibold text-white/70">
                <XGlyph className="h-[clamp(9px,2.8cqi,11px)] w-[clamp(9px,2.8cqi,11px)] shrink-0 text-white" />
                <span className="truncate">@{twitter.username}</span>
              </span>
            )}
          </div>
          {(onShare || onEdit) && (
            <div className="flex shrink-0 items-center gap-2">
              {onShare && (
                <button
                  type="button"
                  onClick={onShare}
                  disabled={sharing}
                  aria-label="Share your card"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.1] text-white/80 transition active:scale-90 disabled:opacity-60"
                >
                  {sharing ? (
                    <Loader2 className="h-[18px] w-[18px] animate-spin" strokeWidth={2.4} />
                  ) : (
                    <Share2 className="h-[18px] w-[18px]" strokeWidth={2.4} />
                  )}
                </button>
              )}
              {onEdit && (
                <button
                  type="button"
                  onClick={onEdit}
                  aria-label="Change your handle"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.1] text-white/80 transition active:scale-90"
                >
                  <Pencil className="h-[18px] w-[18px]" strokeWidth={2.4} />
                </button>
              )}
            </div>
          )}
          {/* Under the actions when present, else pinned top-right. Absolute so it adds no height. */}
          {card.rank && (
            <div
              className={cnm(
                'pointer-events-none absolute right-0',
                onShare || onEdit ? 'top-full mt-[clamp(6px,2cqi,9px)]' : 'top-0',
              )}
            >
              <RankChip badge={card.rank} />
            </div>
          )}
        </div>

        <div className="mt-[clamp(12px,5cqi,20px)] flex items-end justify-between gap-3">
          <div className="min-w-0">
            <Label>{card.hero.label}</Label>
            <div className={cnm('tnum truncate text-[clamp(32px,13cqi,52px)] font-extrabold leading-none', toneText(card.hero.tone))}>{card.hero.value}</div>
          </div>
          {card.netPnl && (
            <div className="min-w-0 text-right">
              <Label>{card.netPnl.label}</Label>
              <div className={cnm('tnum truncate text-[clamp(18px,7.5cqi,30px)] font-extrabold leading-none', toneText(card.netPnl.tone))}>
                {card.netPnl.value}
              </div>
            </div>
          )}
        </div>

        {card.grid.length > 0 && (
          // Docked full-bleed to the bottom of the screen: the negative margins cancel the screen padding so
          // the readout bar sticks to the very bottom edge-to-edge instead of floating as a padded pill.
          <div
            className="mt-[clamp(12px,4.5cqi,18px)] -mx-[clamp(13px,5cqi,20px)] -mb-[clamp(13px,5cqi,20px)] grid divide-x divide-white/[0.07] border-t border-white/[0.08] bg-black/40"
            style={{ gridTemplateColumns: `repeat(${card.grid.length}, minmax(0, 1fr))` }}
          >
            {card.grid.map((c) => (
              <Cell key={c.kind} stat={c} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function CardHeader() {
  return (
    <div className="flex items-center justify-between px-1.5 pb-2.5 pt-1">
      <img src="/assets/logos/pips-horizontal-black.svg" alt="PIPS" className="h-6 w-auto" />
      <span
        className="text-[10px] font-extrabold uppercase tracking-[0.18em]"
        style={{ color: 'rgba(46,30,0,0.58)', textShadow: '0 1px 0 rgba(255,255,255,0.28)' }}
      >
        Player Card
      </span>
    </div>
  )
}

// The leaderboard chip: "#4 TOP REKT" (red) or "#2 TOP GAINER" (green). The card's brag. No outline: a
// filled enamel pill, recessed at the top with a tone glow rising from the bottom (inset, not a border).
function RankChip({ badge }: { badge: RankBadge }) {
  const rekt = badge.kind === 'rekt'
  const rgb = rekt ? '255,90,77' : '52,211,153'
  return (
    <span
      className={cnm(
        'shrink-0 rounded-full px-[clamp(9px,3.2cqi,13px)] py-[clamp(4px,1.7cqi,6px)] text-[clamp(10px,3.5cqi,12px)] font-black uppercase leading-none tracking-[0.03em]',
        rekt ? 'text-down' : 'text-up',
      )}
      style={{
        background: `linear-gradient(180deg, rgba(${rgb},0.30), rgba(${rgb},0.13))`,
        boxShadow: `inset 0 1.5px 1.5px rgba(0,0,0,0.55), inset 0 -7px 10px -6px rgba(${rgb},0.7)`,
      }}
    >
      #{badge.rank} Top {rekt ? 'Rekt' : 'Gainer'}
    </span>
  )
}

function Label({ children }: { children: ReactNode }) {
  return <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-white/55">{children}</div>
}

// Two columns: the 3D icon on the left, label over a bigger value on the right, so the number reads large.
function Cell({ stat }: { stat: CardStat }): ReactNode {
  return (
    <div className="flex min-w-0 items-center gap-[clamp(6px,2.4cqi,10px)] px-[clamp(8px,3cqi,13px)] py-[clamp(9px,3.2cqi,13px)]">
      {stat.icon && (
        <img
          src={stat.icon}
          alt=""
          aria-hidden
          className="h-[clamp(22px,7.5cqi,30px)] w-[clamp(22px,7.5cqi,30px)] shrink-0 object-contain"
        />
      )}
      <div className="min-w-0">
        <div className="truncate text-[clamp(9px,3cqi,11px)] font-bold uppercase tracking-[0.05em] text-white/55">{stat.label}</div>
        <div className={cnm('tnum truncate text-[clamp(15px,5.2cqi,21px)] font-extrabold leading-tight', toneText(stat.tone))}>{stat.value}</div>
      </div>
    </div>
  )
}

export function StatsCardSkeleton() {
  return (
    <div className="trader-bezel overflow-hidden rounded-[26px] p-2.5">
      <CardHeader />
      <div className="trader-screen rounded-[18px] p-5">
        <div className="shimmer h-7 w-40 rounded-lg" />
        <div className="shimmer mt-2 h-4 w-28 rounded-md" />
        <div className="mt-5 flex justify-between">
          <div className="shimmer h-12 w-28 rounded-lg" />
          <div className="shimmer h-9 w-24 rounded-lg" />
        </div>
        <div className="shimmer mt-4 h-[60px] rounded-xl" />
      </div>
    </div>
  )
}
