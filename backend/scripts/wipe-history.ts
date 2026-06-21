// Optional clean slate after a chain reset: wipe play history + derived stats, keep accounts.
//
// Stats (PnL / W-L / leaderboards) are computed from the Play ledger, so clearing Play resets every
// stat. We also clear the legacy UserStats counters, per-user achievements, and minigame scores so
// the slate is truly clean. User rows, usernames, and logins are KEPT, and Achievement definitions
// are KEPT (only the per-user unlock rows go). This DELETES DATA, so it is guarded behind --confirm.
//
// Run from backend/:  bun scripts/wipe-history.ts --confirm
import { prismaQuery } from '../src/lib/prisma.ts';

if (!process.argv.includes('--confirm')) {
  console.error('refusing to wipe without --confirm. This deletes all play history, stats, achievements, and scores.');
  console.error('usage: bun scripts/wipe-history.ts --confirm');
  process.exit(1);
}

// Leaf tables first (all reference User by userId, nothing references them), then the counters.
const scores = await prismaQuery.minigameScore.deleteMany({});
const unlocks = await prismaQuery.userAchievement.deleteMany({});
const plays = await prismaQuery.play.deleteMany({});
const stats = await prismaQuery.userStats.deleteMany({});

console.log(
  `wiped: ${plays.count} plays, ${stats.count} stats rows, ${unlocks.count} achievement unlocks, ${scores.count} minigame scores. accounts kept.`,
);
process.exit(0);
