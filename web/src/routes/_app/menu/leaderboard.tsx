import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { MenuScreen, ScreenError } from '@/components/menu/shared'
import { api, type Game, type GlobalLeaderboard, type LeaderboardGameEntry, type Minigame, type MinigameLeaderboard } from '@/lib/api'
import { haptic } from '@/lib/haptics'
import { HapticOverlay } from '@/components/HapticOverlay'
import { cnm } from '@/utils/style'
import { displayHandle, formatExactDecimal } from '@/utils/format'

// The menu leaderboard. App Surface language (rounded cards, docs/DESIGN.md), distinct from the
// in-device TE board. One fetch pulls every board (global Gainers/REKT, the two games' winners, the
// two arcade boards); the pill selector then switches tabs from cached data, so it's instant with no
// refetch. Every row shows a username (or the generated handle), never an address.
export const Route = createFileRoute('/_app/menu/leaderboard')({ component: LeaderboardScreen })

type Tab = 'traders' | Game | Minigame
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'traders', label: 'Traders' },
  { key: 'lucky', label: 'Lucky' },
  { key: 'range', label: 'Range' },
  { key: 'moonshot', label: 'Moonshot' },
  { key: 'line-rider', label: 'Line Rider' },
  { key: 'candle-hop', label: 'Flappy Piper' },
]

const fmtMoney = (s: string): string => {
  const n = parseFloat(s) || 0
  return `${n < 0 ? '-' : '+'}$${formatExactDecimal(s, { absolute: true })}`
}
const fmtScore = (n: number): string => Math.round(n).toLocaleString('en-US')

function LeaderboardScreen() {
  const [tab, setTab] = useState<Tab>('traders')
  // One query for the whole board; tabs read slices of it, so switching never refetches.
  const q = useQuery({ queryKey: ['leaderboard'], queryFn: () => api.leaderboard() })
  const lb = q.data?.leaderboard

  return (
    <MenuScreen title="Leaderboard">
      <div className="flex flex-col gap-4">
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TABS.map((t) => (
            <div key={t.key} className="relative shrink-0">
              <button
                type="button"
                onClick={() => {
                  haptic('selection')
                  setTab(t.key)
                }}
                className={cnm(
                  'pointer-events-none rounded-full px-4 py-2 text-[13px] font-bold uppercase tracking-wide transition-colors',
                  tab === t.key ? 'bg-brand-500 text-black' : 'bg-white/[0.06] text-text-2',
                )}
              >
                {t.label}
              </button>
              <HapticOverlay
                className="absolute inset-0 rounded-full"
                preset="selection"
                silent
                onTap={() => setTab(t.key)}
              />
            </div>
          ))}
        </div>

        {q.isError ? (
          <ScreenError message="Couldn't load the leaderboard." onRetry={() => void q.refetch()} />
        ) : !lb ? (
          <BoardSkeleton count={tab === 'traders' ? 2 : 1} />
        ) : tab === 'traders' ? (
          <TradersView data={lb.global} />
        ) : tab === 'lucky' || tab === 'range' || tab === 'moonshot' ? (
          <GameView entries={lb.games[tab]} />
        ) : (
          <MinigameView data={lb.minigames[tab]} />
        )}
      </div>
    </MenuScreen>
  )
}

// The headline board: Top Gainers and Top REKT, plus a persistent "your rank" card.
function TradersView({ data }: { data: GlobalLeaderboard }) {
  return (
    <div className="flex flex-col gap-3">
      <BoardCard title="Top Gainers" sub="Most profit" empty="No gainers yet. Bank a win." count={data.gainers.length} tone="up">
        {data.gainers.map((e, i) => (
          <LeaderRow key={e.rank} rank={e.rank} name={displayHandle(e)} isYou={e.isYou} value={fmtMoney(e.netPnl)} valueClass="text-up" sub={`${e.gamesPlayed} plays`} first={i === 0} />
        ))}
      </BoardCard>
      <BoardCard title="Top REKT" sub="Deepest in the red" empty="Nobody's down. For now." count={data.rekt.length} tone="down">
        {data.rekt.map((e, i) => (
          <LeaderRow key={e.rank} rank={e.rank} name={displayHandle(e)} isYou={e.isYou} value={fmtMoney(e.netPnl)} valueClass="text-down" sub={`${e.gamesPlayed} plays`} first={i === 0} />
        ))}
      </BoardCard>
      <YouRank you={data.you} />
    </div>
  )
}

// Per-game winners (Lucky / Range), ranked by banked profit.
function GameView({ entries }: { entries: Array<LeaderboardGameEntry> }) {
  return (
    <BoardCard title="Top Winners" sub="Most profit in this game" empty="No winners yet. Bank a profit to claim #1." count={entries.length} tone="up">
      {entries.map((e, i) => (
        <LeaderRow key={e.rank} rank={e.rank} name={displayHandle(e)} isYou={e.isYou} value={fmtMoney(e.pnl)} valueClass="text-up" sub={`${e.plays} plays`} first={i === 0} />
      ))}
    </BoardCard>
  )
}

// Minigame high scores (Line Rider / Flappy Piper).
function MinigameView({ data }: { data: MinigameLeaderboard }) {
  return (
    <div className="flex flex-col gap-3">
      <BoardCard title="High Scores" sub="Best run wins" empty="No scores yet. Set the first." count={data.entries.length}>
        {data.entries.map((e, i) => (
          <LeaderRow key={e.rank} rank={e.rank} name={displayHandle(e)} isYou={e.isYou} value={fmtScore(e.score)} valueClass={e.rank === 1 ? 'text-brand-500' : 'text-text'} first={i === 0} />
        ))}
      </BoardCard>
      {data.best > 0 && (
        <div className="surface-skeuo flex items-center justify-between rounded-card px-4 py-3">
          <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-text-3">Your best</span>
          <span className="tnum text-[18px] font-black">{fmtScore(data.best)}</span>
        </div>
      )}
    </div>
  )
}

function BoardCard({ title, sub, empty, count, tone, children }: { title: string; sub: string; empty: string; count: number; tone?: 'up' | 'down'; children: ReactNode }) {
  return (
    <div className="card-neo rounded-card px-4 py-3">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {tone && <span className={cnm('h-2 w-2 rounded-full', tone === 'up' ? 'bg-up' : 'bg-down')} />}
          <span className="text-[17px] font-black leading-none">{title}</span>
        </div>
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-text-3">{sub}</span>
      </div>
      {count === 0 ? <div className="py-5 text-center text-[13px] text-text-3">{empty}</div> : <div className="flex flex-col">{children}</div>}
    </div>
  )
}

// One ranked row: rank (gold for #1), name, a value on the right. Your own row is flagged by a small
// brand triangle in the left gutter plus a brand-tinted name, instead of a full-row wash (which read
// heavy and never inset cleanly on the right). Rows stay tight so the board scans in one glance.
function LeaderRow({
  rank,
  name,
  isYou,
  value,
  valueClass,
  sub,
  first,
}: {
  rank: number
  name: string
  isYou: boolean
  value: string
  valueClass?: string
  sub?: string
  first?: boolean
}) {
  return (
    <div className={cnm('relative flex items-center gap-3 py-2', !first && 'border-t border-white/[0.05]')}>
      {isYou && (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 h-0 w-0 -translate-x-[11px] -translate-y-1/2 border-y-[5px] border-l-[7px] border-y-transparent border-l-brand-500"
        />
      )}
      <span className={cnm('tnum w-5 shrink-0 text-[13px] font-black', rank === 1 ? 'text-brand-500' : 'text-text-3')}>{rank}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={cnm('truncate text-[16px] font-bold leading-tight', isYou ? 'text-brand-500' : 'text-text')}>{name}</span>
          {isYou && <span className="shrink-0 rounded bg-brand-500/15 px-1 py-px text-[9px] font-black uppercase tracking-wide text-brand-500">You</span>}
        </div>
        {sub && <div className="mt-0.5 text-[11px] leading-none text-text-3">{sub}</div>}
      </div>
      <span className={cnm('tnum shrink-0 text-[16px] font-black', valueClass ?? 'text-text')}>{value}</span>
    </div>
  )
}

// Your standing on the global board, shown even when you're off the visible top 10.
function YouRank({ you }: { you: GlobalLeaderboard['you'] }) {
  const net = parseFloat(you.netPnl) || 0
  const rank = net > 0 ? you.gainerRank : net < 0 ? you.rektRank : null
  const board = net > 0 ? 'gainers' : net < 0 ? 'rekt' : null
  if (you.gamesPlayed === 0 || rank == null) return null
  return (
    <div className="surface-skeuo flex items-center justify-between rounded-card px-4 py-3">
      <div>
        <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-text-3">Your rank</div>
        <div className="text-[15px] font-bold">
          #{rank} <span className="font-normal text-text-3">in {board}</span>
        </div>
      </div>
      <span className={cnm('tnum text-[18px] font-black', net >= 0 ? 'text-up' : 'text-down')}>{fmtMoney(you.netPnl)}</span>
    </div>
  )
}

function BoardSkeleton({ count }: { count: number }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card-neo rounded-card px-4 py-3">
          <div className="shimmer mb-2 h-4 w-1/3 rounded" />
          {[0, 1, 2, 3, 4].map((j) => (
            <div key={j} className="flex items-center gap-3 py-2">
              <div className="shimmer h-4 w-7 rounded" />
              <div className="shimmer h-4 flex-1 rounded" />
              <div className="shimmer h-4 w-16 rounded" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
