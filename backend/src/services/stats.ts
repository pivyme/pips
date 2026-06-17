// UserStats maintenance. Called once per settled play (cash-out or expiry). Streak is signed:
// a positive run for wins, a negative run for losses, and maxStreak tracks the best win run.
// All amounts are 6dp base units; the API edge converts to display strings.

import { prismaQuery } from '../lib/prisma.ts';

export type SettlementInput = {
  game: string;
  stakeRaw: bigint;
  pnlRaw: bigint; // signed: payout - entryCost
  won: boolean; // pnl > 0
};

// The user's most-played game, recomputed from history (the settled play is already written).
async function computeFavoriteGame(userId: string, fallback: string): Promise<string> {
  const grouped = await prismaQuery.play.groupBy({ by: ['game'], where: { userId }, _count: { game: true } });
  if (grouped.length === 0) return fallback;
  return grouped.sort((a, b) => b._count.game - a._count.game)[0].game;
}

export async function recordSettlement(userId: string, s: SettlementInput): Promise<void> {
  const stats = await prismaQuery.userStats.upsert({ where: { userId }, update: {}, create: { userId } });

  let streak = stats.currentStreak;
  streak = s.won ? (streak >= 0 ? streak + 1 : 1) : streak <= 0 ? streak - 1 : -1;
  const maxStreak = Math.max(stats.maxStreak, streak);
  const favoriteGame = await computeFavoriteGame(userId, s.game);

  await prismaQuery.userStats.update({
    where: { userId },
    data: {
      gamesPlayed: { increment: 1 },
      wins: { increment: s.won ? 1 : 0 },
      losses: { increment: s.won ? 0 : 1 },
      currentStreak: streak,
      maxStreak,
      totalVolume: { increment: s.stakeRaw },
      netPnl: { increment: s.pnlRaw },
      firstPlayAt: stats.firstPlayAt ?? new Date(),
      lastPlayAt: new Date(),
      favoriteGame,
    },
  });
}
