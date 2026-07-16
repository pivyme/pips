// The player card's dynamic model. Short-expiry plays have a naturally low hit rate, so leading with win rate reads
// weak; instead the card auto-features the player's most impressive stat as the hero with a persona title. One source of truth for both StatsCard and shareCard so they can never drift.

import type { UserStatsDTO } from '@/lib/api'
import { formatCompactCount, formatCompactMoney } from '@/utils/format'

export type CardTone = 'gold' | 'up' | 'down' | 'neutral'
export interface CardStat {
  label: string
  value: string
  tone: CardTone
}
export interface CardModel {
  title: string | null // persona chip, e.g. "SNIPER"; null before the first play
  hero: CardStat // the big featured number (never Net P&L, that's the fixed secondary)
  netPnl: CardStat // the secondary big number, always Net P&L
  grid: [CardStat, CardStat, CardStat] // three lower cells, never duplicating the hero
}

type Kind = 'bestHit' | 'roi' | 'bestStreak' | 'plays' | 'volume' | 'winRate'

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

function cell(kind: Kind, s: UserStatsDTO): CardStat {
  switch (kind) {
    case 'bestHit':
      return { label: 'Best hit', value: multipleLabel(s.bestMultiplier), tone: 'gold' }
    case 'roi': {
      const r = roiOf(s)
      return { label: 'Return', value: pctLabel(r), tone: r >= 0 ? 'up' : 'down' }
    }
    case 'bestStreak':
      return { label: 'Best streak', value: formatCompactCount(s.maxStreak), tone: 'gold' }
    case 'plays':
      return { label: 'Plays', value: formatCompactCount(s.gamesPlayed), tone: 'neutral' }
    case 'volume':
      return { label: 'Volume', value: `$${formatCompactMoney(s.totalVolume)}`, tone: 'neutral' }
    case 'winRate':
      return { label: 'Win rate', value: `${Math.round(s.winRate * 100)}%`, tone: 'neutral' }
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

// As the hero, Best Hit reads prouder with a fuller label ("Biggest win") than the tight grid cell.
function heroCell(kind: Kind, s: UserStatsDTO): CardStat {
  const base = cell(kind, s)
  return kind === 'bestHit' ? { ...base, label: 'Biggest win' } : base
}

// A persona chip, chosen most-flattering-first. Independent of the hero.
function pickTitle(s: UserStatsDTO): string | null {
  if (s.gamesPlayed <= 0) return null
  if (s.currentStreak >= 4) return 'ON FIRE'
  if (s.bestMultiplier >= 10) return 'SNIPER'
  if (roiOf(s) >= 0.3) return 'SHARP'
  if (s.gamesPlayed >= 200) return 'GRINDER'
  if (parseFloat(s.totalVolume) >= 1000) return 'HIGH ROLLER'
  if (s.gamesPlayed < 10) return 'ROOKIE'
  return 'TRADER'
}

const GRID_ORDER: Kind[] = ['plays', 'roi', 'bestStreak', 'bestHit', 'volume', 'winRate']

export function buildCardModel(s: UserStatsDTO): CardModel {
  const heroKind = pickHeroKind(s)
  const grid = GRID_ORDER.filter((k) => k !== heroKind)
    .slice(0, 3)
    .map((k) => cell(k, s)) as [CardStat, CardStat, CardStat]
  const net = parseFloat(s.netPnl) || 0
  return {
    title: pickTitle(s),
    hero: heroCell(heroKind, s),
    netPnl: {
      label: 'Net P&L',
      value: `${net >= 0 ? '+' : '-'}$${formatCompactMoney(s.netPnl)}`,
      tone: net >= 0 ? 'up' : 'down',
    },
    grid,
  }
}
