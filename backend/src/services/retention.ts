// Retention: the only code in this system that deletes rows, and the guardrails around it.
//
// It lives in its own file on purpose. A knob that deletes a year of data and sits one text field away
// from an admin's fingers is the single most dangerous control here, and burying it in a 1500-line
// dashboard module makes it harder to audit than it deserves. See §9 and §9.1.
//
// Policy, all age-based. Count-based pruning is deliberately gone: capping a table by row count silently
// drops the oldest occurrence of a rare-but-critical bug the moment a noisy bug floods it, which is
// exactly backwards.
//
//   Event        retention.event_days (365 default, floor 30)
//   ErrorEvent   retention.error_days, plus newest-N-per-fingerprint which does the real work
//   ErrorGroup   forever, except `ignored` groups untouched for 2 years
//
// Deletion is chunked at 5k with a hard 50k budget per run, then it stops until the next tick. A long
// DELETE never locks a table under a live play, a bad setting bleeds slowly and visibly instead of
// vaporising a year in one statement, and a capped run SAYS what it left behind so it is never mistaken
// for a completed one.

import { getSetting, isDestructive, isSettingKey, type SettingKey } from '../config/admin-settings.ts';
import { prismaQuery } from '../lib/prisma.ts';

export const RETENTION_CHUNK = 5_000;
export const RETENTION_RUN_CAP = 50_000;
/** An ignored group is a decision, so it is kept far longer than its samples. */
export const IGNORED_GROUP_TTL_DAYS = 730;

const DAY_MS = 86_400_000;

/** The nouns the confirm string uses. They are part of the typed string, so they are pinned here. */
const NOUN: Record<string, string> = {
  'retention.event_days': 'events',
  'retention.error_days': 'error samples',
  'retention.samples_per_group': 'error samples',
};

export interface RetentionPreview {
  key: string;
  current: number;
  next: number;
  /** A larger window (or a larger sample cap) keeps more, so it deletes nothing and needs no confirm. */
  widening: boolean;
  deletes: number;
  oldest: string | null;
  newest: string | null;
  /** The exact string a narrowing PATCH must carry. Null when widening. */
  confirm: string | null;
  noun: string;
}

export function isRetentionKey(key: string): boolean {
  return isSettingKey(key) && isDestructive(key) && key in NOUN;
}

/** Exact row count, oldest, and newest for the rows a candidate value would delete. */
export async function previewRetention(key: string, next: number, now = Date.now()): Promise<RetentionPreview | null> {
  if (!isRetentionKey(key)) return null;
  const current = (await getSetting(key as SettingKey)) as number;
  const widening = next >= current;
  const noun = NOUN[key]!;

  if (widening) {
    return { key, current, next, widening, deletes: 0, oldest: null, newest: null, confirm: null, noun };
  }

  const range = key === 'retention.samples_per_group' ? await overflowRange(next) : await ageRange(key, next, now);
  return {
    key,
    current,
    next,
    widening,
    deletes: range.count,
    oldest: range.oldest,
    newest: range.newest,
    confirm: confirmString(range.count, noun),
    noun,
  };
}

export function confirmString(count: number, noun: string): string {
  return `delete ${count} ${noun}`;
}

/**
 * Checks a typed confirmation against a freshly recomputed count.
 * `shape` means the admin typed the right form; `drift` means the number they confirmed is stale.
 */
export function checkConfirm(confirm: string | undefined, actual: number, noun: string): { ok: true } | { ok: false; reason: 'absent' | 'shape' | 'drift'; expected: string } {
  const expected = confirmString(actual, noun);
  if (!confirm) return { ok: false, reason: 'absent', expected };

  const match = /^delete (\d+) (.+)$/.exec(confirm.trim());
  if (!match || match[2] !== noun) return { ok: false, reason: 'shape', expected };

  // The number is compared with tolerance rather than for equality: the count moves on its own between
  // the preview and the apply, and demanding an exact match would make a busy hour un-confirmable.
  const confirmed = Number(match[1]);
  if (Math.abs(actual - confirmed) > Math.max(1, actual, confirmed) * 0.1) return { ok: false, reason: 'drift', expected };
  return { ok: true };
}

async function ageRange(key: string, days: number, now: number): Promise<{ count: number; oldest: string | null; newest: string | null }> {
  const cutoff = new Date(now - days * DAY_MS);
  if (key === 'retention.event_days') {
    const [count, first, last] = await Promise.all([
      prismaQuery.event.count({ where: { ts: { lt: cutoff } } }),
      prismaQuery.event.findFirst({ where: { ts: { lt: cutoff } }, orderBy: { ts: 'asc' }, select: { ts: true } }),
      prismaQuery.event.findFirst({ where: { ts: { lt: cutoff } }, orderBy: { ts: 'desc' }, select: { ts: true } }),
    ]);
    return { count, oldest: first?.ts.toISOString() ?? null, newest: last?.ts.toISOString() ?? null };
  }
  const [count, first, last] = await Promise.all([
    prismaQuery.errorEvent.count({ where: { createdAt: { lt: cutoff } } }),
    prismaQuery.errorEvent.findFirst({ where: { createdAt: { lt: cutoff } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    prismaQuery.errorEvent.findFirst({ where: { createdAt: { lt: cutoff } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ]);
  return { count, oldest: first?.createdAt.toISOString() ?? null, newest: last?.createdAt.toISOString() ?? null };
}

type OverflowRow = { id: string; createdAt: Date };

// Rows past the newest N of their fingerprint. A window function is the only way to get this exactly, and
// an approximation is not good enough for a number someone is about to type into a confirmation box.
async function overflowIds(keep: number, limit: number): Promise<OverflowRow[]> {
  return prismaQuery.$queryRaw<OverflowRow[]>`
    SELECT id, "createdAt" FROM (
      SELECT id, "createdAt", row_number() OVER (PARTITION BY fingerprint ORDER BY "createdAt" DESC) AS rn
      FROM "ErrorEvent"
    ) ranked
    WHERE rn > ${keep}
    ORDER BY "createdAt" ASC
    LIMIT ${limit}
  `;
}

async function overflowRange(keep: number): Promise<{ count: number; oldest: string | null; newest: string | null }> {
  const rows = await prismaQuery.$queryRaw<Array<{ n: bigint; oldest: Date | null; newest: Date | null }>>`
    SELECT count(*) AS n, min("createdAt") AS oldest, max("createdAt") AS newest FROM (
      SELECT "createdAt", row_number() OVER (PARTITION BY fingerprint ORDER BY "createdAt" DESC) AS rn
      FROM "ErrorEvent"
    ) ranked
    WHERE rn > ${keep}
  `;
  const r = rows[0];
  return { count: Number(r?.n ?? 0), oldest: r?.oldest?.toISOString() ?? null, newest: r?.newest?.toISOString() ?? null };
}

export interface RetentionReport {
  deleted: { events: number; errorEvents: number; samples: number; groups: number; errorLogs: number };
  total: number;
  /** True when the run hit RETENTION_RUN_CAP and stopped early. */
  capped: boolean;
  /** What a capped run walked away from, so it is never read as "nothing left to do". */
  remaining: number;
  ranMs: number;
}

/**
 * One pass. Deletes in 5k chunks up to a 50k budget shared across every policy, then stops.
 * Never throws: retention failing must not take the analytics worker down with it.
 */
export async function runRetention(now = Date.now()): Promise<RetentionReport> {
  const startedAt = Date.now();
  const deleted = { events: 0, errorEvents: 0, samples: 0, groups: 0, errorLogs: 0 };
  let budget = RETENTION_RUN_CAP;

  const [eventDays, errorDays, keep] = await Promise.all([
    getSetting('retention.event_days'),
    getSetting('retention.error_days'),
    getSetting('retention.samples_per_group'),
  ]);

  // Age-based first, then the per-group cap, then the group tombstones. Order matters only in that the
  // cheap bounded work should not be starved by the unbounded work.
  deleted.events = await chunkDelete(budget, (take) =>
    prismaQuery.event.findMany({ where: { ts: { lt: new Date(now - eventDays * DAY_MS) } }, select: { id: true }, take }).then((rows) => rows.map((r) => r.id)),
    (ids) => prismaQuery.event.deleteMany({ where: { id: { in: ids } } })
  );
  budget -= deleted.events;

  deleted.errorEvents = await chunkDelete(budget, (take) =>
    prismaQuery.errorEvent
      .findMany({ where: { createdAt: { lt: new Date(now - errorDays * DAY_MS) } }, select: { id: true }, take })
      .then((rows) => rows.map((r) => r.id)),
    (ids) => prismaQuery.errorEvent.deleteMany({ where: { id: { in: ids } } })
  );
  budget -= deleted.errorEvents;

  deleted.samples = await chunkDelete(budget, (take) => overflowIds(keep, take).then((rows) => rows.map((r) => r.id)), (ids) =>
    prismaQuery.errorEvent.deleteMany({ where: { id: { in: ids } } })
  );
  budget -= deleted.samples;

  // The legacy table, folded in here so there is one cron rather than two (§9).
  deleted.errorLogs = await chunkDelete(budget, (take) =>
    prismaQuery.errorLog
      .findMany({ where: { createdAt: { lt: new Date(now - errorDays * DAY_MS) } }, select: { id: true }, take })
      .then((rows) => rows.map((r) => r.id)),
    (ids) => prismaQuery.errorLog.deleteMany({ where: { id: { in: ids } } })
  );
  budget -= deleted.errorLogs;

  // Groups are kept forever. The one exception is an `ignored` group nobody has touched in two years,
  // which is a decision that has outlived the code it was about.
  if (budget > 0) {
    const stale = await prismaQuery.errorGroup.findMany({
      where: { status: 'ignored', lastSeen: { lt: new Date(now - IGNORED_GROUP_TTL_DAYS * DAY_MS) } },
      select: { fingerprint: true },
      take: Math.min(budget, RETENTION_CHUNK),
    });
    if (stale.length) {
      const { count } = await prismaQuery.errorGroup.deleteMany({ where: { fingerprint: { in: stale.map((g) => g.fingerprint) } } });
      deleted.groups = count; // last policy in the run, so the budget is not decremented again
    }
  }

  const total = Object.values(deleted).reduce((a, b) => a + b, 0);
  const capped = total >= RETENTION_RUN_CAP;
  const remaining = capped ? await remainingRows(now, eventDays, errorDays, keep) : 0;

  if (total) {
    const parts = Object.entries(deleted)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`)
      .join(', ');
    console.log(`[Retention] deleted ${parts}${capped ? `, CAPPED at ${RETENTION_RUN_CAP} with ~${remaining} still to go` : ''}`);
  }

  return { deleted, total, capped, remaining, ranMs: Date.now() - startedAt };
}

async function remainingRows(now: number, eventDays: number, errorDays: number, keep: number): Promise<number> {
  const [events, errors, overflow] = await Promise.all([
    prismaQuery.event.count({ where: { ts: { lt: new Date(now - eventDays * DAY_MS) } } }),
    prismaQuery.errorEvent.count({ where: { createdAt: { lt: new Date(now - errorDays * DAY_MS) } } }),
    overflowRange(keep).then((r) => r.count),
  ]);
  return events + errors + overflow;
}

/** Deletes in RETENTION_CHUNK batches until the source is dry or the budget runs out. */
async function chunkDelete(budget: number, ids: (take: number) => Promise<string[]>, remove: (ids: string[]) => Promise<{ count: number }>): Promise<number> {
  let done = 0;
  while (done < budget) {
    const take = Math.min(RETENTION_CHUNK, budget - done);
    const batch = await ids(take);
    if (!batch.length) break;
    const { count } = await remove(batch);
    done += count;
    if (batch.length < take) break; // source is dry
  }
  return done;
}

/** The one per-object destructive action in the dashboard, and it needs the typed confirm too. */
export async function purgeGroupSamples(fingerprint: string): Promise<number> {
  const { count } = await prismaQuery.errorEvent.deleteMany({ where: { fingerprint } });
  return count;
}

export async function countGroupSamples(fingerprint: string): Promise<number> {
  return prismaQuery.errorEvent.count({ where: { fingerprint } });
}
