// The player card's dynamic model. Short-expiry plays have a naturally low hit rate, so leading with win rate reads
// weak; instead the card auto-features the player's most impressive stat as the hero with a persona title. One source of truth for both StatsCard and shareCard so they can never drift.
//
// The card is configurable at share time (buildCardModel takes a CardConfig): net P&L is private for some, and
// the hero + the small stat cells can each be swapped or hidden. Defaults still auto-pick the most flattering read.

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
export interface CardConfig {
  hero: Kind // the big featured number
  showNetPnl: boolean // Net P&L is private for some players
  grid: Kind[] // the small cells, in order, 0 to 3, never including the hero
}
export interface CardModel {
  title: string | null // persona chip, e.g. "SNIPER"; null before the first play
  hero: CardStat // the big featured number
  netPnl: CardStat | null // the secondary big number, null when hidden
  grid: CardStat[] // up to three lower cells, never duplicating the hero
}

// The three stats with dedicated icons. Others render icon-less, which is fine in the grid and the sheet.
export const KIND_ICON: Partial<Record<Kind, string>> = {
  plays: '/assets/icons/icon-plays.webp',
  roi: '/assets/icons/icon-return.webp',
  bestStreak: '/assets/icons/icon-streak.webp',
}

// Order used both for the hero fallback pick and the sheet's stat pool.
export const ALL_KINDS: Kind[] = ['bestHit', 'roi', 'bestStreak', 'plays', 'volume', 'winRate']

// Short friendly labels for the share sheet's toggle rows.
export const KIND_LABEL: Record<Kind, string> = {
  bestHit: 'Biggest win',
  roi: 'Return',
  bestStreak: 'Best streak',
  plays: 'Plays',
  volume: 'Volume',
  winRate: 'Win rate',
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

// Max small cells in the grid (matches the 3-column layout).
export const MAX_GRID = 3

// The auto card: the most flattering hero, Net P&L shown, the next three stats in the grid.
export function defaultCardConfig(s: UserStatsDTO): CardConfig {
  const hero = pickHeroKind(s)
  const grid = GRID_ORDER.filter((k) => k !== hero).slice(0, MAX_GRID)
  return { hero, showNetPnl: true, grid }
}

// Clamp a (possibly persisted / stale) config back into something drawable: valid hero, unique grid kinds,
// never the hero in the grid, capped at MAX_GRID.
export function sanitizeConfig(c: Partial<CardConfig> | null | undefined, s: UserStatsDTO): CardConfig {
  const base = defaultCardConfig(s)
  const hero = c?.hero && ALL_KINDS.includes(c.hero) ? c.hero : base.hero
  const seen = new Set<Kind>()
  const grid = (c?.grid ?? base.grid)
    .filter((k) => ALL_KINDS.includes(k) && k !== hero && !seen.has(k) && (seen.add(k), true))
    .slice(0, MAX_GRID)
  return { hero, showNetPnl: c?.showNetPnl ?? base.showNetPnl, grid }
}

export function buildCardModel(s: UserStatsDTO, config?: CardConfig): CardModel {
  const cfg = config ?? defaultCardConfig(s)
  return {
    title: pickTitle(s),
    hero: heroCell(cfg.hero, s),
    netPnl: cfg.showNetPnl ? netPnlStat(s) : null,
    grid: cfg.grid.map((k) => statOf(k, s)),
  }
}
