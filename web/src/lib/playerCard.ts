// The player card's model. Short-expiry plays have a naturally low hit rate, so leading with win rate reads
// weak; instead the card auto-features the player's most impressive stat as the hero. One source of truth for
// both StatsCard and shareCard so they can never drift.
//
// The card auto-builds, no picker. The only knob is showNetPnl (dollar P&L is private for some). The one
// bit of flavor is the rank chip: your standing on the global board, "#4 TOP REKT" or "#2 TOP GAINER".

import type { UserStatsDTO } from '@/lib/api'
import { formatCompactCount, formatCompactMoney } from '@/utils/format'

export type CardTone = 'gold' | 'up' | 'down' | 'neutral'

// Every stat the card can show. Net P&L is its own toggleable slot (not a Kind), so it can never be the hero
// and never double up in the grid.
export type Kind = 'bestHit' | 'roi' | 'bestStreak' | 'plays' | 'volume' | 'winRate'

export interface CardStat {
  kind: Kind
  label: string
  value: string
  tone: CardTone
  icon?: string // the small grid cells carry a skeuo icon; the hero and Net P&L don't
}

// The player's global-board standing (mirror of GlobalLeaderboard.you). At most one rank is set: net-positive
// players get gainerRank, net-negative get rektRank, flat/new get neither.
export interface RankStanding {
  gainerRank: number | null
  rektRank: number | null
}
export interface RankBadge {
  rank: number
  kind: 'gainer' | 'rekt' // TOP GAINER (green) or TOP REKT (red)
}

export interface CardModel {
  rank: RankBadge | null // the leaderboard chip by the handle; null when unranked
  hero: CardStat // the big featured number
  netPnl: CardStat | null // the secondary big number, null when hidden
  grid: CardStat[] // up to three lower cells, never duplicating the hero
}

// The three stats with dedicated icons. Others render icon-less, which is fine in the grid.
export const KIND_ICON: Partial<Record<Kind, string>> = {
  plays: '/assets/icons/icon-plays.webp',
  roi: '/assets/icons/icon-return.webp',
  bestStreak: '/assets/icons/icon-streak.webp',
}

// Return on lifetime wagered (netPnl / total volume). 0 when nothing has been staked.
function roiOf(s: UserStatsDTO): number {
  const vol = parseFloat(s.totalVolume) || 0
  if (vol <= 0) return 0
  return (parseFloat(s.netPnl) || 0) / vol
}

// "47x", "2.4x". Truncated so it never reads higher than it landed, trailing .0 dropped.
function multipleLabel(m: number): string {
  if (m <= 0) return '0x'
  const t = m >= 10 ? Math.round(m) : Math.floor(m * 10) / 10
  return `${Number.isInteger(t) ? t : t.toFixed(1)}x`
}

// Signed percent, e.g. "+182%", "-40%".
function pctLabel(frac: number): string {
  const p = Math.round(frac * 100)
  return `${p >= 0 ? '+' : ''}${p.toLocaleString('en-US')}%`
}

function statOf(kind: Kind, s: UserStatsDTO): CardStat {
  const icon = KIND_ICON[kind]
  switch (kind) {
    case 'bestHit':
      return { kind, label: 'Best hit', value: multipleLabel(s.bestMultiplier), tone: 'gold', icon }
    case 'roi': {
      const r = roiOf(s)
      return { kind, label: 'Return', value: pctLabel(r), tone: r >= 0 ? 'up' : 'down', icon }
    }
    case 'bestStreak':
      // Short grid label so the icon + label fit one cell; the hero relabels it "Best streak".
      return { kind, label: 'Streak', value: formatCompactCount(s.maxStreak), tone: 'gold', icon }
    case 'plays':
      return { kind, label: 'Plays', value: formatCompactCount(s.gamesPlayed), tone: 'neutral', icon }
    case 'volume':
      return { kind, label: 'Volume', value: `$${formatCompactMoney(s.totalVolume)}`, tone: 'neutral', icon }
    case 'winRate':
      return { kind, label: 'Win rate', value: `${Math.round(s.winRate * 100)}%`, tone: 'neutral', icon }
  }
}

function netPnlStat(s: UserStatsDTO): CardStat {
  const net = parseFloat(s.netPnl) || 0
  return {
    kind: 'roi', // unused for Net P&L; kept structural
    label: 'Net P&L',
    value: `${net >= 0 ? '+' : '-'}$${formatCompactMoney(s.netPnl)}`,
    tone: net >= 0 ? 'up' : 'down',
  }
}

// Picks the single most impressive stat to feature (never Net P&L); degrades gracefully so even a brand-new or net-down account still shows a real number.
function pickHeroKind(s: UserStatsDTO): Kind {
  if (s.bestMultiplier >= 3) return 'bestHit'
  if (roiOf(s) >= 0.15) return 'roi'
  if (s.maxStreak >= 3) return 'bestStreak'
  if (s.bestMultiplier > 1) return 'bestHit'
  return 'plays'
}

// As the hero, Best Hit reads prouder with a fuller label ("Biggest win") than the tight grid cell. The hero
// never shows an icon (the big number carries itself).
function heroCell(kind: Kind, s: UserStatsDTO): CardStat {
  const base = statOf(kind, s)
  const label = kind === 'bestHit' ? 'Biggest win' : kind === 'bestStreak' ? 'Best streak' : base.label
  return { ...base, label, icon: undefined }
}

// The lower grid, in flattering order. Auto-filled from whatever the hero didn't take.
const GRID_ORDER: Kind[] = ['plays', 'roi', 'bestStreak', 'bestHit', 'volume', 'winRate']
const MAX_GRID = 3

// Gainer takes priority (a player is only ever on one side); null when off both boards.
export function rankBadge(r?: RankStanding | null): RankBadge | null {
  if (!r) return null
  if (r.gainerRank != null) return { rank: r.gainerRank, kind: 'gainer' }
  if (r.rektRank != null) return { rank: r.rektRank, kind: 'rekt' }
  return null
}

export function buildCardModel(
  s: UserStatsDTO,
  opts?: { showNetPnl?: boolean; rank?: RankStanding | null },
): CardModel {
  const hero = pickHeroKind(s)
  const grid = GRID_ORDER.filter((k) => k !== hero).slice(0, MAX_GRID)
  return {
    rank: rankBadge(opts?.rank),
    hero: heroCell(hero, s),
    netPnl: (opts?.showNetPnl ?? true) ? netPnlStat(s) : null,
    grid: grid.map((k) => statOf(k, s)),
  }
}
