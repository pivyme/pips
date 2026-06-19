// Achievement evaluation. evaluateMetrics is pure over (stats, plays) so it unit-tests in
// isolation; evaluateAndUnlock runs it against the DB after each settle and persists any
// newly crossed thresholds. The unique (userId, slug) constraint makes unlocks idempotent.

import { prismaQuery } from '../lib/prisma.ts';
import { fromDusdcRaw } from '../lib/sui/math.ts';
import type { Play, UserStats } from '../../prisma/generated/client.js';

const SETTLED = new Set(['won', 'lost', 'cashed_out']);

// Map every achievement metric to the user's current value. Keys match Achievement.metric.
export function evaluateMetrics(stats: UserStats, plays: Play[]): Record<string, number> {
  const settled = plays.filter((p) => SETTLED.has(p.status));
  const chrono = [...settled].sort((a, b) => (a.settledAt?.getTime() ?? 0) - (b.settledAt?.getTime() ?? 0));

  const distinctGames = new Set(settled.map((p) => p.game)).size;
  const cashouts = settled.filter((p) => p.status === 'cashed_out' && (p.pnl ?? 0n) > 0n).length;

  // Best realized multiple on a winning play (payout / entry cost = 1/ask), matching the displayed multiplier.
  const bigMultiplier = settled.reduce((mx, p) => {
    if ((p.pnl ?? 0n) <= 0n || p.entryCost <= 0n || p.payout == null) return mx;
    return Math.max(mx, Number(p.payout) / Number(p.entryCost));
  }, 0);

  // A win immediately following a loss, in settlement order.
  let comeback = 0;
  for (let i = 1; i < chrono.length; i++) {
    if ((chrono[i - 1].pnl ?? 0n) <= 0n && (chrono[i].pnl ?? 0n) > 0n) {
      comeback = 1;
      break;
    }
  }

  return {
    games_played: stats.gamesPlayed,
    wins: stats.wins,
    win_streak: stats.maxStreak,
    volume: fromDusdcRaw(stats.totalVolume),
    distinct_games: distinctGames,
    cashouts,
    big_multiplier: bigMultiplier,
    comeback,
  };
}

// Evaluate and persist newly unlocked achievements. Returns the slugs unlocked this call so
// the caller can fire the unlock toast.
export async function evaluateAndUnlock(userId: string): Promise<string[]> {
  const [stats, plays, catalog, existing] = await Promise.all([
    prismaQuery.userStats.findUnique({ where: { userId } }),
    prismaQuery.play.findMany({ where: { userId } }),
    prismaQuery.achievement.findMany(),
    prismaQuery.userAchievement.findMany({ where: { userId } }),
  ]);
  if (!stats) return [];

  const metrics = evaluateMetrics(stats, plays);
  const have = new Set(existing.map((e) => e.achievementSlug));
  const toUnlock = catalog.filter((a) => !have.has(a.slug) && (metrics[a.metric] ?? 0) >= a.threshold);
  if (toUnlock.length === 0) return [];

  await prismaQuery.userAchievement.createMany({
    data: toUnlock.map((a) => ({ userId, achievementSlug: a.slug })),
    skipDuplicates: true,
  });
  return toUnlock.map((a) => a.slug);
}
