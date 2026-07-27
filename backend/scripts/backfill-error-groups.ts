// Replay the legacy ErrorLog table through the live fingerprint() so the dashboard's Errors page opens
// onto real grouped history instead of a blank slate. This is not seeding: it is the same grouping the
// capture path does, applied to rows we already had.
//
//   cd backend && bun scripts/backfill-error-groups.ts [--dry] [--force]
//
// --dry   print the plan, write nothing
// --force run even when ErrorGroup already has rows (counts are absolute, so a second run overwrites
//         whatever live capture has since recorded; that is why it is guarded)

import '../dotenv.ts';

import type { Prisma } from '../prisma/generated/client.js';
import { capMessage, capProps, capStack, fingerprint, redact, type ErrorLevel } from '../src/lib/analytics.ts';
import { getSetting } from '../src/config/admin-settings.ts';
import { SUI_NETWORK } from '../src/config/main-config.ts';
import { prismaQuery } from '../src/lib/prisma.ts';

const dry = process.argv.includes('--dry');
const force = process.argv.includes('--force');

// Everything in ErrorLog came from handleError, so the kind is knowable rather than guessed.
const KIND = 'http' as const;

interface Group {
  fingerprint: string;
  title: string;
  culprit: string | null;
  level: ErrorLevel;
  count: number;
  users: Set<string>;
  firstSeen: Date;
  lastSeen: Date;
  samples: Array<{
    message: string;
    stack: string | null;
    context: Prisma.InputJsonValue | undefined;
    userId: string | null;
    method: string | null;
    path: string | null;
    createdAt: Date;
  }>;
}

// A 4xx is the user hitting a wall we already handle (no auth header, name taken, faucet cooldown). It
// belongs on the page for volume, not at `error`, or 312 expected 401s outrank every real bug.
function levelFor(statusCode: number): ErrorLevel {
  return statusCode >= 500 ? 'error' : 'warn';
}

function parseContext(raw: string | null, method: string | null, path: string | null): Prisma.InputJsonValue | undefined {
  const base: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) Object.assign(base, parsed);
      else base.context = parsed;
    } catch {
      base.context = raw;
    }
  }
  if (method) base.method = method;
  if (path) base.path = path;
  base.backfilled = true; // so a row's provenance is readable on the page, not inferred
  if (!Object.keys(base).length) return undefined;
  const capped = capProps(redact(base));
  return capped.ok ? (capped.props as Prisma.InputJsonValue) : undefined;
}

const existing = await prismaQuery.errorGroup.count();
if (existing > 0 && !force) {
  console.error(`ErrorGroup already has ${existing} rows. Re-running would overwrite live counts with backfill-only totals.`);
  console.error('Re-run with --force if that is what you want.');
  process.exit(1);
}

const keep = await getSetting('retention.samples_per_group');
const logs = await prismaQuery.errorLog.findMany({
  orderBy: { createdAt: 'asc' },
  select: { errorCode: true, message: true, statusCode: true, stack: true, context: true, userId: true, method: true, path: true, createdAt: true },
});

console.log(`read ${logs.length} ErrorLog rows, keeping <=${keep} samples per group`);

const groups = new Map<string, Group>();

for (const row of logs) {
  const level = levelFor(row.statusCode);
  const cls = fingerprint({ kind: KIND, message: row.message, code: row.errorCode, stack: row.stack, level });

  let g = groups.get(cls.fingerprint);
  if (!g) {
    g = {
      fingerprint: cls.fingerprint,
      title: cls.title,
      culprit: cls.culprit || null,
      level: cls.level,
      count: 0,
      users: new Set(),
      firstSeen: row.createdAt,
      lastSeen: row.createdAt,
      samples: [],
    };
    groups.set(cls.fingerprint, g);
  }

  g.count += 1;
  if (row.userId) g.users.add(row.userId);
  if (row.createdAt < g.firstSeen) g.firstSeen = row.createdAt;
  if (row.createdAt > g.lastSeen) g.lastSeen = row.createdAt;
  // A group whose every sample is `error` should not read `warn` because the first one was.
  if (g.level !== 'error' && cls.level === 'error') g.level = 'error';

  g.samples.push({
    message: capMessage(row.message),
    stack: capStack(row.stack),
    context: parseContext(row.context, row.method, row.path),
    userId: row.userId,
    method: row.method,
    path: row.path,
    createdAt: row.createdAt,
  });
}

const ordered = [...groups.values()].sort((a, b) => b.count - a.count);
console.log(`\n${ordered.length} distinct groups:\n`);
for (const g of ordered) {
  console.log(`  ${String(g.count).padStart(4)}x  ${g.level.padEnd(5)}  ${g.title.slice(0, 68)}`);
}

if (dry) {
  console.log('\n--dry, nothing written');
  process.exit(0);
}

let groupsWritten = 0;
let samplesWritten = 0;

for (const g of ordered) {
  // Absolute values, not increments: this rebuilds the group from the full log rather than adding to it.
  const data = {
    title: g.title,
    culprit: g.culprit,
    kind: KIND,
    level: g.level,
    count: g.count,
    usersAffected: g.users.size,
    firstSeen: g.firstSeen,
    lastSeen: g.lastSeen,
    firstRelease: 'backfill',
    lastRelease: 'backfill',
  };
  await prismaQuery.errorGroup.upsert({ where: { fingerprint: g.fingerprint }, create: { fingerprint: g.fingerprint, ...data }, update: data });
  groupsWritten += 1;

  // Newest N only, same trick as the live path: the group holds the true count, samples are evidence.
  const newest = g.samples.slice(-keep);
  await prismaQuery.errorEvent.deleteMany({ where: { fingerprint: g.fingerprint, release: 'backfill' } });
  await prismaQuery.errorEvent.createMany({
    data: newest.map((s) => ({
      fingerprint: g.fingerprint,
      message: s.message,
      stack: s.stack,
      context: s.context,
      userId: s.userId,
      method: s.method,
      path: s.path,
      release: 'backfill',
      network: SUI_NETWORK,
      createdAt: s.createdAt,
    })),
  });
  samplesWritten += newest.length;
}

console.log(`\nwrote ${groupsWritten} groups, ${samplesWritten} samples`);
process.exit(0);
