// Seed: the machine-checkable achievement catalog (always) + staged demo data for the dev
// wallet user so Stats and history are populated on first open. Idempotent upserts, never
// deletes, safe to re-run between demo takes. It does NOT fabricate chain positions, only DB
// history for display; live plays during the demo are real. Run: `bun run prisma/seed.ts`.
// Exact values from bigdev/plans/08-DEMO-FLOW.md.

import '../dotenv.ts';

import { prismaQuery } from '../src/lib/prisma.ts';
import { operatorAddress } from '../src/lib/sui/signer.ts';
import { ORACLES } from '../src/lib/sui/config.ts';

// DUSDC display units -> 6dp base units.
const D = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

const now = Date.now();
const hoursAgo = (h: number): Date => new Date(now - h * 3_600_000);
const daysAgo = (d: number): Date => new Date(now - d * 86_400_000);

// The catalog. Conditions evaluate against UserStats / Play history in achievements.ts.
const ACHIEVEMENTS = [
  { slug: 'first_play', name: 'First Play', description: 'Make your first play.', illo: 'bolt', metric: 'games_played', threshold: 1, sortOrder: 1 },
  { slug: 'first_win', name: "Beginner's Luck", description: 'Win your first play.', illo: 'trophy', metric: 'wins', threshold: 1, sortOrder: 2 },
  { slug: 'win_streak_5', name: 'On Fire', description: 'Win 5 plays in a row.', illo: 'flame', metric: 'win_streak', threshold: 5, sortOrder: 3 },
  { slug: 'big_multiplier', name: 'Moonshot', description: 'Cash out a 25x or higher.', illo: 'up', metric: 'big_multiplier', threshold: 25, sortOrder: 4 },
  { slug: 'volume_1000', name: 'High Roller', description: 'Trade $1,000 in total volume.', illo: 'gem', metric: 'volume', threshold: 1000, sortOrder: 5 },
  { slug: 'all_games', name: 'Sampler', description: 'Play all three games.', illo: 'dice', metric: 'distinct_games', threshold: 3, sortOrder: 6 },
  { slug: 'cashout_10', name: 'Quick Hands', description: 'Cash out 10 winning plays.', illo: 'coin', metric: 'cashouts', threshold: 10, sortOrder: 7 },
  { slug: 'comeback', name: 'Comeback', description: 'Win a play right after a loss.', illo: 'medal', metric: 'comeback', threshold: 1, sortOrder: 8 },
];

interface SeedPlay {
  id: string;
  game: string;
  status: string;
  asset: string;
  side?: string;
  leverage?: number;
  strike?: string;
  lower?: string;
  upper?: string;
  widthPct?: number;
  stake: number;
  mult: number;
  pnl: number;
  dur: number;
  h: number; // hours ago opened
}

// ~8 recent plays across all three games, mixed outcomes, realistic stakes/multipliers.
const PLAYS: SeedPlay[] = [
  { id: 'seed-play-1', game: 'lucky', status: 'won', asset: 'SOL', side: 'up', leverage: 5, strike: '144', stake: 25, mult: 3.5, pnl: 37.5, dur: 30, h: 2 },
  { id: 'seed-play-2', game: 'range', status: 'cashed_out', asset: 'BTC', lower: '61000', upper: '63000', widthPct: 3.2, stake: 15, mult: 4.0, pnl: 21.0, dur: 60, h: 6 },
  { id: 'seed-play-3', game: 'tap', status: 'lost', asset: 'ETH', lower: '3380', upper: '3420', stake: 10, mult: 2.0, pnl: -10.0, dur: 30, h: 9 },
  { id: 'seed-play-4', game: 'lucky', status: 'won', asset: 'BTC', side: 'down', leverage: 10, strike: '62000', stake: 30, mult: 5.0, pnl: 90.0, dur: 60, h: 26 },
  { id: 'seed-play-5', game: 'lucky', status: 'lost', asset: 'SUI', side: 'up', leverage: 25, strike: '0.95', stake: 5, mult: 25.0, pnl: -5.0, dur: 10, h: 30 },
  { id: 'seed-play-6', game: 'range', status: 'won', asset: 'ETH', lower: '3300', upper: '3500', widthPct: 5.9, stake: 40, mult: 2.5, pnl: 60.0, dur: 60, h: 50 },
  { id: 'seed-play-7', game: 'tap', status: 'cashed_out', asset: 'SOL', lower: '142', upper: '146', stake: 12, mult: 3.0, pnl: 14.0, dur: 30, h: 73 },
  { id: 'seed-play-8', game: 'lucky', status: 'lost', asset: 'BTC', side: 'up', leverage: 2, strike: '61500', stake: 50, mult: 1.8, pnl: -50.0, dur: 60, h: 96 },
];

async function main(): Promise<void> {
  // Catalog first, always.
  for (const a of ACHIEVEMENTS) {
    await prismaQuery.achievement.upsert({ where: { slug: a.slug }, update: a, create: a });
  }
  console.log(`[seed] ${ACHIEVEMENTS.length} achievements upserted`);

  // The dev wallet user. Mark funded so /auth/dev does not re-mint the starting balance
  // (the operator already holds bootstrap DUSDC). Leave predictManagerId untouched.
  const user = await prismaQuery.user.upsert({
    where: { address: operatorAddress },
    update: { dusdcFunded: true },
    create: { address: operatorAddress, provider: 'dev', displayName: 'Lucky Otter', dusdcFunded: true },
  });

  // The shareable stats card numbers (denormalized).
  const stats = {
    gamesPlayed: 23,
    wins: 14,
    losses: 9,
    currentStreak: 3,
    maxStreak: 6,
    totalVolume: D(1840),
    netPnl: D(180),
    favoriteGame: 'lucky',
    firstPlayAt: daysAgo(30),
    lastPlayAt: hoursAgo(2),
  };
  await prismaQuery.userStats.upsert({ where: { userId: user.id }, update: stats, create: { userId: user.id, ...stats } });

  // Recent play history. oracleId is display-only here; no fake tx digests (explorer links
  // only render for real on-chain plays).
  const oracleId = ORACLES[0]?.oracleId ?? '0xseed';
  for (const p of PLAYS) {
    const openedAt = hoursAgo(p.h);
    const settledAt = new Date(openedAt.getTime() + p.dur * 1000);
    const won = p.status === 'won' || p.status === 'cashed_out';
    await prismaQuery.play.upsert({
      where: { id: p.id },
      update: {},
      create: {
        id: p.id,
        userId: user.id,
        game: p.game,
        status: p.status,
        asset: p.asset,
        oracleId,
        marketKey: 'seed',
        side: p.side ?? null,
        leverage: p.leverage ?? null,
        strike: p.strike ?? null,
        lower: p.lower ?? null,
        upper: p.upper ?? null,
        widthPct: p.widthPct ?? null,
        durationSec: p.dur,
        expiry: BigInt(settledAt.getTime()),
        stake: D(p.stake),
        entryCost: D(p.stake),
        payout: won ? D(p.stake + p.pnl) : null,
        pnl: D(p.pnl),
        multiplier: p.mult,
        openedAt,
        settledAt,
        createdAt: openedAt,
      },
    });
  }
  console.log(`[seed] ${PLAYS.length} demo plays upserted for ${user.displayName} (${operatorAddress})`);

  // Unlocked achievements so the grid shows progress, not a blank wall.
  for (const slug of ['first_play', 'first_win', 'win_streak_5']) {
    await prismaQuery.userAchievement.upsert({
      where: { userId_achievementSlug: { userId: user.id, achievementSlug: slug } },
      update: {},
      create: { userId: user.id, achievementSlug: slug },
    });
  }
  console.log('[seed] 3 achievements unlocked for the dev user');
}

main()
  .then(() => prismaQuery.$disconnect())
  .catch(async (e) => {
    console.error('[seed] failed:', e);
    await prismaQuery.$disconnect();
    process.exit(1);
  });
