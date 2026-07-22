// Achievement evaluation. evaluateMetrics is pure over (stats, plays, tz) so it unit-tests in isolation;
// evaluateAndUnlock runs it against the DB and persists newly crossed thresholds, idempotent via the unique (userId, slug) constraint.

import { prismaQuery } from '../lib/prisma.ts';
import { fromDusdcRaw } from '../lib/sui/math.ts';
import { computeLedgerStats } from './stats.ts';
import type { Play, UserStats } from '../../prisma/generated/client.js';

// The canonical catalog: slugs, copy, and thresholds match web/src/lib/achievements.ts exactly, so what
// the sticker says is what the code checks. Sized for the real economy (MIN/MAX_STAKE ~$1.5-3), never
// promise a stake or multiplier the protocol can't mint. Seed + migrate-achievements.ts upsert this into the DB.
export const ACHIEVEMENT_CATALOG = [
  { slug: 'first_try', name: 'First Try', description: 'Complete your first play.', illo: 'bolt', metric: 'games_played', threshold: 1 },
  { slug: 'getting_warm', name: 'Getting Warm', description: 'Play 3 times.', illo: 'flame', metric: 'games_played', threshold: 3 },
  { slug: 'high_five', name: 'High Five', description: 'Play 5 times.', illo: 'up', metric: 'games_played', threshold: 5 },
  { slug: 'ten_club', name: 'Ten Club', description: 'Win 10 plays.', illo: 'trophy', metric: 'wins', threshold: 10 },
  { slug: 'tiny_bet', name: 'Tiny Play', description: 'Make a play of $2 or less.', illo: 'coin', metric: 'tiny_stake', threshold: 1 },
  { slug: 'back_again', name: 'Back Again', description: 'Play 2 days in a row.', illo: 'medal', metric: 'day_streak', threshold: 2 },
  { slug: 'daily_play', name: 'Daily Play', description: 'Complete 5 plays in one day.', illo: 'bolt', metric: 'plays_in_day', threshold: 5 },
  { slug: 'night_shift', name: 'Night Shift', description: 'Play after 10 PM.', illo: 'gem', metric: 'night_plays', threshold: 1 },
  { slug: 'early_signal', name: 'Early Signal', description: 'Play before 9 AM.', illo: 'up', metric: 'early_plays', threshold: 1 },
  { slug: 'first_win', name: 'First Win', description: 'Win your first play.', illo: 'trophy', metric: 'wins', threshold: 1 },
  { slug: 'close_call', name: 'Close Call', description: 'Finish a play with a tiny margin.', illo: 'flame', metric: 'close_call', threshold: 1 },
  { slug: 'quick_tap', name: 'Quick Tap', description: 'Cash out within 30 seconds of opening a play.', illo: 'coin', metric: 'fast_cashout', threshold: 1 },
  { slug: 'calm_click', name: 'Calm Click', description: 'Hold 3 plays to the buzzer and win.', illo: 'medal', metric: 'settled_wins', threshold: 3 },
  { slug: 'double_play', name: 'Double Play', description: 'Complete 2 plays within 10 minutes.', illo: 'dice', metric: 'double_play', threshold: 1 },
  { slug: 'mini_streak', name: 'Mini Streak', description: 'Win 2 plays in a row.', illo: 'flame', metric: 'win_streak', threshold: 2 },
  { slug: 'market_hopper', name: 'Sampler', description: 'Play two different games.', illo: 'dice', metric: 'distinct_games', threshold: 2 },
  { slug: 'dollar_rookie', name: 'Dollar Rookie', description: 'Play a total of $25.', illo: 'gem', metric: 'volume', threshold: 25 },
  { slug: 'bigger_move', name: 'Bigger Move', description: 'Play a total of $100.', illo: 'gem', metric: 'volume', threshold: 100 },
  { slug: 'comeback', name: 'Comeback', description: 'Win after your previous play was a loss.', illo: 'medal', metric: 'comeback', threshold: 1 },
  { slug: 'pips_regular', name: 'PIPS Regular', description: 'Complete 10 total plays.', illo: 'bolt', metric: 'games_played', threshold: 10 },
].map((a, i) => ({ ...a, sortOrder: i + 1 }));

const SETTLED = new Set(['won', 'lost', 'cashed_out']);

const TINY_STAKE_MAX = 2; // Tiny Play: $2 or less on one play
const FAST_CASHOUT_MS = 30_000; // Quick Tap: cash out within 30s of opening
const DOUBLE_PLAY_GAP_MS = 10 * 60_000; // Double Play: two plays opened within 10 minutes
const CLOSE_CALL_FRAC = 1e-4; // Close Call: settle within 1bp of the deciding line (~1-sigma is 4-8bp on a short round)

// The aggregate counts a metric reads off. Both the stored UserStats row and a fresh ledger recompute
// satisfy this, so callers pass whichever they have without coupling to the full row.
type StatCounts = Pick<UserStats, 'gamesPlayed' | 'wins' | 'maxStreak' | 'totalVolume'>;

// Local wall-clock helpers. tz is JS getTimezoneOffset() minutes (UTC = local + tz), so localMs = utc - tz*60s.
const localMs = (t: number, tz: number): number => t - tz * 60_000;
const localHour = (t: number, tz: number): number => new Date(localMs(t, tz)).getUTCHours();
const localDay = (t: number, tz: number): number => Math.floor(localMs(t, tz) / 86_400_000);

// When the user opened the play; every settled play has openedAt, createdAt covers legacy rows.
const openedMs = (p: Play): number => (p.openedAt ?? p.createdAt).getTime();

// Settle margin as a fraction of price: distance from the settlement price to the nearest deciding line
// (binary strike, or a range bound). NaN-guarded; cash-outs have no settlePrice and never qualify.
const settleMarginFrac = (p: Play): number => {
  const settle = Number(p.settlePrice);
  if (!Number.isFinite(settle) || settle <= 0) return Infinity;
  const lines = [p.strike, p.lower, p.upper].map(Number).filter((v) => Number.isFinite(v) && v > 0);
  if (lines.length === 0) return Infinity;
  return Math.min(...lines.map((l) => Math.abs(settle - l))) / settle;
};

// Map every achievement metric to the user's current value. Keys match Achievement.metric.
// tzOffsetMin localizes the time-of-day/day-boundary metrics; null falls back to UTC until the next login stores it.
export function evaluateMetrics(stats: StatCounts, plays: Play[], tzOffsetMin?: number | null): Record<string, number> {
  const tz = tzOffsetMin ?? 0;
  const settled = plays.filter((p) => SETTLED.has(p.status));
  const chrono = [...settled].sort((a, b) => (a.settledAt?.getTime() ?? 0) - (b.settledAt?.getTime() ?? 0));

  const distinctGames = new Set(settled.map((p) => p.game)).size;
  const settledWins = settled.filter((p) => p.status === 'won').length;
  const tinyStakes = settled.filter((p) => fromDusdcRaw(p.stake) <= TINY_STAKE_MAX).length;
  const closeCalls = settled.filter((p) => settleMarginFrac(p) < CLOSE_CALL_FRAC).length;
  const fastCashouts = settled.filter(
    (p) => p.status === 'cashed_out' && p.settledAt != null && p.openedAt != null && p.settledAt.getTime() - p.openedAt.getTime() <= FAST_CASHOUT_MS,
  ).length;

  // A win immediately following a loss, in settlement order.
  let comeback = 0;
  for (let i = 1; i < chrono.length; i++) {
    if ((chrono[i - 1].pnl ?? 0n) <= 0n && (chrono[i].pnl ?? 0n) > 0n) {
      comeback = 1;
      break;
    }
  }

  // Two plays opened within the double-play window, in open order.
  const opens = settled.map(openedMs).sort((a, b) => a - b);
  let doublePlay = 0;
  for (let i = 1; i < opens.length; i++) {
    if (opens[i] - opens[i - 1] <= DOUBLE_PLAY_GAP_MS) {
      doublePlay = 1;
      break;
    }
  }

  // Time-of-day and day-boundary metrics, on the user's local clock.
  let nightPlays = 0;
  let earlyPlays = 0;
  const byDay = new Map<number, number>();
  for (const p of settled) {
    const t = openedMs(p);
    const h = localHour(t, tz);
    if (h >= 22 || h < 5) nightPlays += 1;
    else if (h < 9) earlyPlays += 1;
    const d = localDay(t, tz);
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  const playsInDay = byDay.size > 0 ? Math.max(...byDay.values()) : 0;
  const days = [...byDay.keys()].sort((a, b) => a - b);
  let dayStreak = days.length > 0 ? 1 : 0;
  let run = dayStreak;
  for (let i = 1; i < days.length; i++) {
    run = days[i] === days[i - 1] + 1 ? run + 1 : 1;
    if (run > dayStreak) dayStreak = run;
  }

  return {
    games_played: stats.gamesPlayed,
    wins: stats.wins,
    win_streak: stats.maxStreak,
    volume: fromDusdcRaw(stats.totalVolume),
    distinct_games: distinctGames,
    settled_wins: settledWins,
    tiny_stake: tinyStakes,
    close_call: closeCalls,
    fast_cashout: fastCashouts,
    double_play: doublePlay,
    night_plays: nightPlays,
    early_plays: earlyPlays,
    plays_in_day: playsInDay,
    day_streak: dayStreak,
    comeback,
  };
}

// Evaluate and persist newly unlocked achievements. Returns the slugs unlocked this call so
// the caller can fire the unlock toast.
export async function evaluateAndUnlock(userId: string): Promise<string[]> {
  const [plays, catalog, existing, user] = await Promise.all([
    prismaQuery.play.findMany({ where: { userId } }),
    prismaQuery.achievement.findMany(),
    prismaQuery.userAchievement.findMany({ where: { userId } }),
    prismaQuery.user.findUnique({ where: { id: userId }, select: { tzOffsetMin: true } }),
  ]);

  const metrics = evaluateMetrics(await computeLedgerStats(userId, plays), plays, user?.tzOffsetMin);
  const have = new Set(existing.map((e) => e.achievementSlug));
  const toUnlock = catalog.filter((a) => !have.has(a.slug) && (metrics[a.metric] ?? 0) >= a.threshold);
  if (toUnlock.length === 0) return [];

  await prismaQuery.userAchievement.createMany({
    data: toUnlock.map((a) => ({ userId, achievementSlug: a.slug })),
    skipDuplicates: true,
  });
  return toUnlock.map((a) => a.slug);
}
