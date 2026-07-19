import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { MenuScreen, ScreenError } from '@/components/menu/shared'
import { XGlyph } from '@/components/menu/BrandGlyphs'
import { Avatar } from '@/components/Avatar'
import { type GlobalLeaderboard, type LeaderboardPnlEntry } from '@/lib/api'
import { leaderboardQuery } from '@/lib/menuQueries'
import { useAuth } from '@/lib/auth'
import { HapticOverlay } from '@/components/HapticOverlay'
import { cnm } from '@/utils/style'
import { formatExactDecimal } from '@/utils/format'

// The menu leaderboard, App Surface language (docs/DESIGN.md), distinct from the in-device TE board. One
// PnL board with two faces, GAINERS and REKT, toggled by a segmented control: a top-3 podium of trophy
// cards, flat rows below, and a sticky "your rank" footer. One fetch feeds both faces (already cached).
export const Route = createFileRoute('/_app/menu/leaderboard')({ component: LeaderboardScreen })

type Board = 'gainers' | 'rekt'

// Podium tiers: gold / silver / bronze. `ink` tints the name + value, `ring`+`dark` build the medallion,
// `rgb` drives the soft glow. Trophy colors are intentionally board-agnostic (the mode reads from the toggle
// + the signed value), so #1 always feels like #1.
const TIER = {
  1: { ink: '#ffd24a', ring: '#ffcf52', dark: '#e79a09', rgb: '255,192,22' },
  2: { ink: '#e6ebf1', ring: '#d4dce4', dark: '#98a4b0', rgb: '203,211,219' },
  3: { ink: '#eeb083', ring: '#dc9057', dark: '#b06a34', rgb: '214,139,84' },
} as const

const abs = (s: string): string => formatExactDecimal(s, { absolute: true })
// Signed by board: gainers always read +, rekt always read -.
const money = (netPnl: string, board: Board): string => `${board === 'gainers' ? '+' : '-'}$${abs(netPnl)}`

// Identity is the @username, full stop, never displayName. `display` is what shows; `seed` (the bare handle)
// only feeds the avatar's identicon color/initial. A player without a username reads "Anon", never an address.
function label(e: { username: string | null }): { display: string; seed: string } {
  const u = e.username?.trim()
  return u ? { display: `@${u.toLowerCase()}`, seed: u } : { display: 'Anon', seed: 'Anon' }
}

function LeaderboardScreen() {
  const [board, setBoard] = useState<Board>('gainers')
  // One query for the whole board; the toggle reads a slice of it, so switching never refetches.
  const q = useQuery(leaderboardQuery())
  const global = q.data?.leaderboard.global

  return (
    <MenuScreen title="Leaderboard">
      <div className="flex flex-1 flex-col gap-4">
        <Segmented board={board} onChange={setBoard} />
        {q.isError ? (
          <ScreenError message="Couldn't load the leaderboard." onRetry={() => void q.refetch()} />
        ) : !global ? (
          <BoardSkeleton />
        ) : (
          <BoardBody global={global} board={board} />
        )}
        {global && (
          <>
            {/* Spacer floats the rank plate to the bottom on a short board; sticky keeps it there on a long one. */}
            <div className="min-h-2 flex-1" />
            <YourRankFooter you={global.you} board={board} />
          </>
        )}
      </div>
    </MenuScreen>
  )
}

// GAINERS | REKT with a sliding enamel pill. Green for gainers, crimson for rekt, so the mode is unmistakable.
function Segmented({ board, onChange }: { board: Board; onChange: (b: Board) => void }) {
  const segs: Array<{ key: Board; label: string; ink: string }> = [
    { key: 'gainers', label: 'Top Gainers', ink: 'text-up' },
    { key: 'rekt', label: 'Top REKT', ink: 'text-down' },
  ]
  const rgb = board === 'gainers' ? '52,211,153' : '255,90,77'
  return (
    <div className="surface-skeuo relative flex rounded-full p-1">
      <div
        aria-hidden
        className="absolute bottom-1 left-1 top-1 w-[calc((100%-8px)/2)] rounded-full transition-transform duration-300 ease-out-expo"
        style={{
          transform: board === 'rekt' ? 'translateX(100%)' : 'translateX(0)',
          background: `linear-gradient(180deg, rgba(${rgb},0.30), rgba(${rgb},0.13))`,
          boxShadow: `inset 0 1.5px 1.5px rgba(0,0,0,0.55), inset 0 -8px 11px -6px rgba(${rgb},0.75)`,
        }}
      />
      {segs.map((s) => (
        <div key={s.key} className="relative z-10 flex-1">
          <button
            type="button"
            tabIndex={-1}
            className={cnm(
              'pointer-events-none block h-9 w-full rounded-full text-[13px] font-black uppercase tracking-[0.08em] transition-colors',
              board === s.key ? s.ink : 'text-text-3',
            )}
          >
            {s.label}
          </button>
          <HapticOverlay
            className="absolute inset-0 rounded-full"
            preset="selection"
            onTap={() => onChange(s.key)}
          />
        </div>
      ))}
    </div>
  )
}

function BoardBody({ global, board }: { global: GlobalLeaderboard; board: Board }) {
  const entries = board === 'gainers' ? global.gainers : global.rekt
  if (entries.length === 0) return <EmptyBoard board={board} />
  const podium = entries.slice(0, 3)
  const rest = entries.slice(3)
  return (
    <div className="flex flex-col gap-3">
      {podium.map((e, i) => (
        <PodiumCard key={e.rank} e={e} board={board} tier={(i + 1) as 1 | 2 | 3} />
      ))}
      {rest.length > 0 && (
        <div className="card-neo rounded-card px-4 py-1">
          {rest.map((e, i) => (
            <FlatRow key={e.rank} e={e} board={board} first={i === 0} />
          ))}
        </div>
      )}
    </div>
  )
}

// A podium card: tier-ringed avatar with a rank medallion + sparkle, the display name over its @handle, and the
// value on the right. A tier glow rises off the bottom edge so #1 reads richer than #3 without a second layout.
function PodiumCard({ e, board, tier }: { e: LeaderboardPnlEntry; board: Board; tier: 1 | 2 | 3 }) {
  const t = TIER[tier]
  const l = label(e)
  return (
    <div className="card-neo relative overflow-hidden rounded-card">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-card"
        style={{ boxShadow: `inset 0 0 0 1px rgba(${t.rgb},0.18), inset 0 -22px 34px -24px rgba(${t.rgb},0.55)` }}
      />
      <div className="relative flex items-center gap-3.5 px-4 py-3.5">
        <PodiumAvatar name={l.seed} src={e.avatarUrl} tier={tier} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-[17px] font-black leading-tight" style={{ color: t.ink }}>
              {l.display}
            </span>
            {e.isYou && <YouPill />}
          </div>
          {e.twitterHandle && (
            <XHandle handle={e.twitterHandle} className="mt-1.5 max-w-full rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-medium" />
          )}
        </div>
        <span className="tnum shrink-0 text-[19px] font-black" style={{ color: t.ink }}>
          {money(e.netPnl, board)}
        </span>
      </div>
    </div>
  )
}

function PodiumAvatar({ name, src, tier }: { name: string; src?: string | null; tier: 1 | 2 | 3 }) {
  const t = TIER[tier]
  return (
    <div className="relative shrink-0" style={{ width: 52, height: 52 }}>
      {/* Double ring: a black gap floats the tier ring off the avatar (inner black band, then the colored ring). */}
      <div
        className="rounded-full"
        style={{ boxShadow: `0 0 0 3px #0a0a0a, 0 0 0 5.5px ${t.ring}, 0 0 18px -3px rgba(${t.rgb},0.6)` }}
      >
        <Avatar name={name} src={src} size={52} className="block" />
      </div>
      <Sparkle className="absolute -left-1.5 -top-1.5" color={t.ink} />
      <span
        className="tnum absolute -bottom-1 -right-1 flex h-[22px] w-[22px] items-center justify-center rounded-full text-[12px] font-black"
        style={{
          background: `linear-gradient(180deg, ${t.ring}, ${t.dark})`,
          color: '#1a1200',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.5), 0 2px 4px rgba(0,0,0,0.55), 0 0 0 2px #0a0a0a',
        }}
      >
        {tier}
      </span>
    </div>
  )
}

function Sparkle({ className, color }: { className?: string; color: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      className={className}
      aria-hidden="true"
      fill={color}
      style={{ filter: `drop-shadow(0 0 3px ${color})` }}
    >
      <path d="M12 1.5 13.7 10.3 22 12 13.7 13.7 12 22.5 10.3 13.7 2 12 10.3 10.3Z" />
    </svg>
  )
}

// A flat row (rank 4+): rank, small avatar, name + @handle + optional X badge, value on the right. Your own
// row keeps the brand gutter marker + "You" pill instead of a full-row wash, so the board still scans clean.
function FlatRow({ e, board, first }: { e: LeaderboardPnlEntry; board: Board; first: boolean }) {
  const l = label(e)
  return (
    <div className={cnm('relative flex items-center gap-3 py-2.5', !first && 'border-t border-white/[0.05]')}>
      {e.isYou && (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 h-0 w-0 -translate-x-[11px] -translate-y-1/2 border-y-[5px] border-l-[7px] border-y-transparent border-l-brand-500"
        />
      )}
      <span className="tnum w-6 shrink-0 text-[13px] font-black text-text-3">{e.rank}</span>
      <Avatar name={l.seed} src={e.avatarUrl} size={32} />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1.5">
          <span className={cnm('min-w-0 truncate text-[15px] font-bold leading-tight', e.isYou ? 'text-brand-400' : 'text-text')}>
            {l.display}
          </span>
          {e.isYou && <YouPill />}
        </div>
        {e.twitterHandle && <XHandle handle={e.twitterHandle} className="mt-0.5 text-[11px] font-normal" />}
      </div>
      <span className={cnm('tnum shrink-0 text-[15px] font-black', board === 'gainers' ? 'text-up' : 'text-down')}>
        {money(e.netPnl, board)}
      </span>
    </div>
  )
}

function YouPill() {
  return (
    <span className="shrink-0 rounded bg-brand-500/15 px-1 py-px text-[9px] font-black uppercase tracking-wide text-brand-400">
      You
    </span>
  )
}

// The player's linked X handle with the X mark, shown whenever they've connected X. It sits next to the real
// X handle, never the PIPS @username, so the mark never implies the @username itself is their X account.
function XHandle({ handle, className }: { handle: string; className?: string }) {
  return (
    <span className={cnm('inline-flex w-fit items-center gap-1 text-text-2', className)}>
      <XGlyph className="h-2.5 w-2.5 shrink-0 text-text" />
      <span className="truncate">@{handle}</span>
    </span>
  )
}

// Your standing on the current board, a floating console plate pinned to the bottom of the viewport even when
// you're off the top. Reads gainerRank on GAINERS / rektRank on REKT (flips with the toggle); the rank sits in
// a recessed readout screen that glows in the board accent, "#--" when you're unranked for the mode.
function YourRankFooter({ you, board }: { you: GlobalLeaderboard['you']; board: Board }) {
  const { user } = useAuth()
  const rank = board === 'gainers' ? you.gainerRank : you.rektRank
  const net = parseFloat(you.netPnl) || 0
  const ranked = you.gamesPlayed > 0 && rank != null
  const name = user?.username ?? 'You'
  const rgb = board === 'gainers' ? '52,211,153' : '255,90,77'
  return (
    <div className="sticky bottom-4 z-20">
      <div
        className="relative flex items-center gap-3 rounded-2xl px-3.5 py-3"
        style={{
          background: 'linear-gradient(180deg,#2c2b27 0%,#211f1c 52%,#171613 100%)',
          border: '1px solid #3a3730',
          boxShadow:
            'inset 0 1px 0 rgba(255,214,120,0.22), inset 0 -1px 3px rgba(0,0,0,0.6), 0 1px 0 #060606, 0 28px 46px -16px rgba(0,0,0,0.96)',
        }}
      >
        <div
          className="shrink-0 rounded-full"
          style={{ boxShadow: '0 0 0 2.5px #0a0a0a, 0 0 0 4.5px rgba(255,192,22,0.85)' }}
        >
          <Avatar name={name} src={user?.avatarUrl} size={46} className="block" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-black uppercase tracking-[0.02em] text-brand-400">Your rank</div>
          <div className="mt-0.5 truncate text-[17px] font-bold">
            {you.gamesPlayed === 0 ? (
              <span className="text-text-3">Play a round to rank</span>
            ) : ranked ? (
              <span className={net >= 0 ? 'text-up' : 'text-down'}>
                {net >= 0 ? '+' : '-'}${abs(you.netPnl)} <span className="font-normal text-text-3">PnL</span>
              </span>
            ) : (
              <span className="text-text-3">Not in {board} yet</span>
            )}
          </div>
        </div>
        <div
          className="flex h-12 min-w-[74px] items-center justify-center rounded-xl px-3"
          style={{
            background: 'linear-gradient(180deg,#0c0c0b,#050505)',
            boxShadow: `inset 0 1px 0 #242422, inset 0 3px 9px rgba(0,0,0,0.75), inset 0 0 0 1px rgba(${rgb},${ranked ? 0.18 : 0.06})`,
          }}
        >
          <span
            className="tnum text-[27px] font-black leading-none"
            style={{
              color: ranked ? `rgb(${rgb})` : '#7a7a7a',
              textShadow: ranked ? `0 0 13px rgba(${rgb},0.6)` : 'none',
            }}
          >
            {ranked ? `#${rank}` : '#--'}
          </span>
        </div>
      </div>
    </div>
  )
}

function EmptyBoard({ board }: { board: Board }) {
  return (
    <div className="card-neo rounded-card px-4 py-12 text-center">
      <div className="text-[15px] font-black">{board === 'gainers' ? 'No gainers yet' : 'No REKT yet'}</div>
      <div className="mt-1 text-[13px] text-text-3">
        {board === 'gainers' ? 'Bank a win to claim #1.' : "Nobody's down. For now."}
      </div>
    </div>
  )
}

function BoardSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="card-neo flex items-center gap-3.5 rounded-card px-4 py-3.5">
          <div className="shimmer h-[60px] w-[60px] shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="shimmer h-4 w-2/5 rounded" />
            <div className="shimmer h-3 w-1/4 rounded" />
          </div>
          <div className="shimmer h-5 w-16 rounded" />
        </div>
      ))}
      <div className="card-neo rounded-card px-4 py-1">
        {[0, 1, 2, 3].map((j) => (
          <div key={j} className="flex items-center gap-3 py-2.5">
            <div className="shimmer h-4 w-6 rounded" />
            <div className="shimmer h-8 w-8 shrink-0 rounded-full" />
            <div className="shimmer h-4 flex-1 rounded" />
            <div className="shimmer h-4 w-14 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}
