import { Loader2, Pencil, Share2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { UserStatsDTO } from '@/lib/api'
import type { CardTone } from '@/lib/playerCard'
import { buildCardModel } from '@/lib/playerCard'
import { Avatar } from '@/components/Avatar'
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
  onEdit,
  onShare,
  sharing,
}: {
  stats: UserStatsDTO
  displayName: string
  // The custom uploaded avatar, or null (the PIPS identicon renders when absent).
  avatarUrl?: string | null
  // When set, a pen sits next to the handle so it can be changed. Omitted on the shareable card.
  onEdit?: () => void
  // When set, a share icon sits beside the pen for one-tap PNG export (renders the card via shareCard.ts).
  onShare?: () => void
  sharing?: boolean // share in progress: the icon spins and disables
}) {
  const card = buildCardModel(stats)

  return (
    // @container: the card sizes text + padding off its OWN width (cqi), not the viewport, so it shrinks
    // gracefully in a narrow drawer instead of numbers colliding. Clamp maxes match the original sizes, so a normal width looks exactly as before.
    <div className="trader-bezel @container overflow-hidden rounded-[26px] p-2.5">
      <CardHeader />
      <div className="trader-screen relative overflow-hidden rounded-[18px] p-[clamp(13px,5cqi,20px)]">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-[clamp(8px,3cqi,12px)]">
            <Avatar
              name={displayName}
              src={avatarUrl}
              size={44}
              className="shrink-0 ring-1 ring-white/15"
            />
            <div className="min-w-0 truncate text-[clamp(17px,6cqi,24px)] font-extrabold leading-tight text-white">{displayName}</div>
            {card.title && (
              <span className="shrink-0 rounded-md border border-brand-400/30 bg-brand-400/15 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.1em] text-brand-400">
                {card.title}
              </span>
            )}
          </div>
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
        </div>

        <div className="mt-[clamp(12px,5cqi,20px)] flex items-end justify-between gap-3">
          <div className="min-w-0">
            <Label>{card.hero.label}</Label>
            <div className={cnm('tnum truncate text-[clamp(32px,13cqi,52px)] font-extrabold leading-none', toneText(card.hero.tone))}>{card.hero.value}</div>
          </div>
          <div className="min-w-0 text-right">
            <Label>{card.netPnl.label}</Label>
            <div className={cnm('tnum truncate text-[clamp(18px,7.5cqi,30px)] font-extrabold leading-none', toneText(card.netPnl.tone))}>
              {card.netPnl.value}
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 divide-x divide-white/[0.08] overflow-hidden rounded-xl border border-white/[0.07] bg-black/40">
          {card.grid.map((c) => (
            <Cell key={c.label} label={c.label} value={c.value} tone={c.tone} />
          ))}
        </div>
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

function Label({ children }: { children: ReactNode }) {
  return <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-white/55">{children}</div>
}

function Cell({ label, value, tone }: { label: string; value: string; tone: CardTone }): ReactNode {
  return (
    <div className="min-w-0 px-[clamp(8px,3cqi,12px)] py-2.5">
      <div className="text-[10px] font-bold uppercase tracking-[0.06em] text-white/55">{label}</div>
      <div className={cnm('tnum mt-1 truncate text-[clamp(13px,4.3cqi,17px)] font-extrabold', toneText(tone))}>{value}</div>
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
