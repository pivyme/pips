// User stats, derived from the Play ledger, which is the single source of truth. Every settled play
// is a final, immutable row (status + pnl SET once), so summing them is exact and can never drift.
// We deliberately do NOT trust a running { increment } tally for the displayed numbers: that kind of
// counter double-counts across settle retries, multi-writer races (operator + follower on the shared
// DB), and redeploys, and over time the card ends up showing a PnL that doesn't match the user's own
// history. computeLedgerStats recomputes from scratch instead, so the card, the history, the
// leaderboard, and the achievements all read the same honest number. O(plays) per user, trivial at
// our scale. recordSettlement keeps the denormalized UserStats row in sync as a self-healing cache.

import { prismaQuery } from '../lib/prisma.ts';
import type { Play } from '../../prisma/generated/client.js';

const SETTLED = new Set(['won', 'lost', 'cashed_out']);

// True iff a settled play counts as a win: a settled 'won', or a cash-out closed above entry. This
// is the one win rule every surface shares (history, stats, leaderboard, achievements), so they agree.
export const isWinningPlay = (p: Pick<Play, 'status' | 'pnl'>): boolean =>
  p.status === 'won' || (p.status === 'cashed_out' && (p.pnl ?? 0n) > 0n);

export type LedgerStats = {
  gamesPlayed: number;
  wins: number;
  losses: number;
  currentStreak: number; // signed: + current win run, - current loss run
  maxStreak: number; // best win run
  totalVolume: bigint; // Σ stake, base units
  netPnl: bigint; // Σ pnl (payout - entryCost), base units
  firstPlayAt: Date | null;
  lastPlayAt: Date | null;
  favoriteGame: string | null;
};

// Recompute a user's stats straight from their plays. Pass `plays` to reuse a list already fetched
// (the achievements path does), else it reads them. Settled plays drive every number; favoriteGame
// is the most-played across all plays (matches the prior behavior).
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
  for (const p of settled) {
    netPnl += p.pnl ?? 0n;
    totalVolume += p.stake;
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
    totalVolume,
    netPnl,
    firstPlayAt: settled[0]?.settledAt ?? null,
    lastPlayAt: settled[settled.length - 1]?.settledAt ?? null,
    favoriteGame,
  };
}

// Keep the denormalized UserStats row in sync after a play settles (cash-out or expiry). It is a
// recompute-and-SET, not an increment, so it is idempotent: two settle workers finalizing the same
// play (or a retry) both compute the same correct numbers instead of drifting. The displayed stats
// read the ledger directly, so this row is a convenience cache, but keeping it correct means it never
// lies and any prior drift heals the next time that user settles a play.
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
