// User stats derive from the Play ledger (single source of truth), never a running increment tally that
// double-counts across settle retries, multi-writer races, and redeploys; computeLedgerStats recomputes from scratch each time so every surface reads the same honest number.

import { prismaQuery } from '../lib/prisma.ts';
import type { Play } from '../../prisma/generated/client.js';

const SETTLED = new Set(['won', 'lost', 'cashed_out']);

// True iff a settled play counts as a win ('won', or a cash-out closed above entry); the one win rule every surface shares, so they all agree.
export const isWinningPlay = (p: Pick<Play, 'status' | 'pnl'>): boolean =>
  p.status === 'won' || (p.status === 'cashed_out' && (p.pnl ?? 0n) > 0n);

export type LedgerStats = {
  gamesPlayed: number;
  wins: number;
  losses: number;
  currentStreak: number; // signed: + current win run, - current loss run
  maxStreak: number; // best win run
  bestMultiplier: number; // biggest realized payout multiple on a winning play (payout/entryCost), 0 if none
  totalVolume: bigint; // Σ all-in entry cost (on-chain mint cost + house rake), base units
  netPnl: bigint; // Σ pnl (payout - entryCost), base units
  firstPlayAt: Date | null;
  lastPlayAt: Date | null;
  favoriteGame: string | null;
};

// Recomputes a user's stats straight from their plays; pass `plays` to reuse an already-fetched list (the
// achievements path does), else it reads them. Settled plays drive every number; favoriteGame is the most-played across all plays.
export async function computeLedgerStats(userId: string, plays?: Play[]): Promise<LedgerStats> {
  const all = plays ?? (await prismaQuery.play.findMany({ where: { userId } }));
  const settled = all
    .filter((p) => SETTLED.has(p.status))
    .sort((a, b) => (a.settledAt?.getTime() ?? 0) - (b.settledAt?.getTime() ?? 0) || a.createdAt.getTime() - b.createdAt.getTime());

  let wins = 0;
  let losses = 0;
  let netPnl = 0n;
  let totalVolume = 0n;
  let streak = 0;
  let maxStreak = 0;
  let bestMultiplier = 0;
  for (const p of settled) {
    netPnl += p.pnl ?? 0n;
    totalVolume += p.entryCost;
    // Best realized multiple (payout / entry cost = 1/ask), matching the displayed multiplier and achievements.
    if ((p.pnl ?? 0n) > 0n && p.entryCost > 0n && p.payout != null) {
      bestMultiplier = Math.max(bestMultiplier, Number(p.payout) / Number(p.entryCost));
    }
    if (isWinningPlay(p)) {
      wins += 1;
      streak = streak >= 0 ? streak + 1 : 1;
      if (streak > maxStreak) maxStreak = streak;
    } else {
      losses += 1;
      streak = streak <= 0 ? streak - 1 : -1;
    }
  }

  const counts = new Map<string, number>();
  for (const p of all) counts.set(p.game, (counts.get(p.game) ?? 0) + 1);
  let favoriteGame: string | null = null;
  let best = 0;
  for (const [game, c] of counts) if (c > best) { best = c; favoriteGame = game; }

  return {
    gamesPlayed: settled.length,
    wins,
    losses,
    currentStreak: streak,
    maxStreak,
    bestMultiplier,
    totalVolume,
    netPnl,
    firstPlayAt: settled[0]?.settledAt ?? null,
    lastPlayAt: settled[settled.length - 1]?.settledAt ?? null,
    favoriteGame,
  };
}

// Keeps the denormalized UserStats row in sync after a play settles; it's a recompute-and-SET (not an
// increment), so it's idempotent across concurrent settle workers or retries. Displayed stats read the ledger directly, so this row is just a convenience cache that self-heals any prior drift.
export async function recordSettlement(userId: string): Promise<void> {
  const s = await computeLedgerStats(userId);
  const row = {
    gamesPlayed: s.gamesPlayed,
    wins: s.wins,
    losses: s.losses,
    currentStreak: s.currentStreak,
    maxStreak: s.maxStreak,
    totalVolume: s.totalVolume,
    netPnl: s.netPnl,
    firstPlayAt: s.firstPlayAt,
    lastPlayAt: s.lastPlayAt,
    favoriteGame: s.favoriteGame,
  };
  await prismaQuery.userStats.upsert({ where: { userId }, create: { userId, ...row }, update: row });
}
