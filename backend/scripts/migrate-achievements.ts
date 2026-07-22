// One-shot catalog migration: swap the legacy 8-achievement catalog (first_play, volume_1000, ...) for
// the canonical 20 in services/achievements.ts, whose copy matches what the code actually checks.
//
// Steps: upsert the new catalog, delete legacy per-user unlock rows + legacy Achievement rows, then
// re-run evaluateAndUnlock for every user with plays so everything their ledger already earns under the
// new (mostly easier) conditions is granted immediately, no one waits for their next settle.
//
// Deletes the legacy unlock rows (re-derived where the new catalog covers them), so guarded: --confirm.
// Run from backend/:  bun scripts/migrate-achievements.ts --confirm

import '../dotenv.ts';

import { prismaQuery } from '../src/lib/prisma.ts';
import { ACHIEVEMENT_CATALOG, evaluateAndUnlock } from '../src/services/achievements.ts';

if (!process.argv.includes('--confirm')) {
  console.error('refusing to migrate without --confirm. This replaces the achievement catalog and re-derives per-user unlocks.');
  console.error('usage: bun scripts/migrate-achievements.ts --confirm');
  process.exit(1);
}

const slugs = ACHIEVEMENT_CATALOG.map((a) => a.slug);

for (const a of ACHIEVEMENT_CATALOG) {
  await prismaQuery.achievement.upsert({ where: { slug: a.slug }, update: a, create: a });
}
console.log(`[migrate] ${ACHIEVEMENT_CATALOG.length} achievements upserted`);

const oldUnlocks = await prismaQuery.userAchievement.deleteMany({ where: { achievementSlug: { notIn: slugs } } });
const oldRows = await prismaQuery.achievement.deleteMany({ where: { slug: { notIn: slugs } } });
console.log(`[migrate] removed ${oldRows.count} legacy achievements (${oldUnlocks.count} per-user unlock rows)`);

// Re-derive every player's unlocks from their ledger under the new conditions.
const users = await prismaQuery.play.groupBy({ by: ['userId'] });
let granted = 0;
for (const { userId } of users) {
  granted += (await evaluateAndUnlock(userId)).length;
}
console.log(`[migrate] re-evaluated ${users.length} users, ${granted} unlocks granted`);

await prismaQuery.$disconnect();
