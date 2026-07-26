// The destructive guardrails (A6 item 6) and the batched prune.
//
// Six of these are one `if` each, which is exactly why they are worth pinning: they are the difference
// between a typo and a year of data. A guard nobody has watched fail is not known to work, so every case
// here fails first and then passes on the corrected input.
//
// Prisma is mocked, so nothing is deleted and no play is ever looped (L-010).

import { beforeEach, describe, expect, it, mock } from 'bun:test';

const NOW = Date.parse('2026-07-27T12:00:00.000Z');
const DAY = 86_400_000;

// One mutable fixture set. `deleted` records what the prune actually removed, which is the only way to
// tell a capped run from a completed one.
const db = {
  events: [] as Array<{ id: string; ts: Date }>,
  errorEvents: [] as Array<{ id: string; fingerprint: string; createdAt: Date }>,
  errorLogs: [] as Array<{ id: string; createdAt: Date }>,
  groups: [] as Array<{ fingerprint: string; status: string; lastSeen: Date }>,
  settings: new Map<string, string>(),
};

const olderThan = (v: Date, where: Record<string, unknown> | undefined, field: string): boolean => {
  const cond = (where?.[field] ?? {}) as { lt?: Date };
  return cond.lt ? v.getTime() < cond.lt.getTime() : true;
};

const rowTable = <T extends { id: string }>(rows: () => T[], field: 'ts' | 'createdAt') => {
  const at = (r: T): Date => (r as unknown as Record<string, Date>)[field]!;
  return {
    count: async ({ where }: { where?: Record<string, unknown> } = {}) => rows().filter((r) => olderThan(at(r), where, field)).length,
    findMany: async ({ where, take }: { where?: Record<string, unknown>; take?: number } = {}) =>
      rows()
        .filter((r) => olderThan(at(r), where, field))
        .slice(0, take ?? undefined),
    findFirst: async ({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: Record<string, string> } = {}) => {
      const hits = rows()
        .filter((r) => olderThan(at(r), where, field))
        .sort((a, b) => at(a).getTime() - at(b).getTime());
      return (orderBy?.[field] === 'desc' ? hits[hits.length - 1] : hits[0]) ?? null;
    },
    deleteMany: async ({ where }: { where?: { id?: { in: string[] }; fingerprint?: string } } = {}) => {
      const ids = new Set(where?.id?.in ?? []);
      const before = rows().length;
      const kept = rows().filter((r) => !ids.has(r.id));
      rows().length = 0;
      rows().push(...kept);
      return { count: before - kept.length };
    },
  };
};

mock.module('../lib/prisma.ts', () => ({
  prismaQuery: {
    event: rowTable(() => db.events, 'ts'),
    errorEvent: {
      ...rowTable(() => db.errorEvents, 'createdAt'),
      deleteMany: async ({ where }: { where?: { id?: { in: string[] }; fingerprint?: string } } = {}) => {
        const before = db.errorEvents.length;
        const kept = where?.fingerprint
          ? db.errorEvents.filter((r) => r.fingerprint !== where.fingerprint)
          : db.errorEvents.filter((r) => !new Set(where?.id?.in ?? []).has(r.id));
        db.errorEvents.length = 0;
        db.errorEvents.push(...kept);
        return { count: before - kept.length };
      },
      count: async ({ where }: { where?: { fingerprint?: string; createdAt?: { lt?: Date } } } = {}) =>
        db.errorEvents.filter((r) => (where?.fingerprint ? r.fingerprint === where.fingerprint : true) && olderThan(r.createdAt, where, 'createdAt')).length,
    },
    errorLog: rowTable(() => db.errorLogs, 'createdAt'),
    errorGroup: {
      findMany: async ({ where, take }: { where?: { status?: string; lastSeen?: { lt?: Date } }; take?: number } = {}) =>
        db.groups.filter((g) => (where?.status ? g.status === where.status : true) && olderThan(g.lastSeen, where, 'lastSeen')).slice(0, take ?? undefined),
      deleteMany: async ({ where }: { where?: { fingerprint?: { in: string[] } } } = {}) => {
        const ids = new Set(where?.fingerprint?.in ?? []);
        const before = db.groups.length;
        const kept = db.groups.filter((g) => !ids.has(g.fingerprint));
        db.groups.length = 0;
        db.groups.push(...kept);
        return { count: before - kept.length };
      },
    },
    appConfig: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = db.settings.get(where.key);
        return value === undefined ? null : { key: where.key, value };
      },
      upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        db.settings.set(where.key, create.value);
        return {};
      },
    },
    // The newest-N-per-fingerprint window function, evaluated in JS against the same fixture.
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join(' ');
      const keep = Number(values[0]);
      const overflow = [...groupByFingerprint(keep)].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      if (sql.includes('count(*)')) {
        return [{ n: BigInt(overflow.length), oldest: overflow[0]?.createdAt ?? null, newest: overflow[overflow.length - 1]?.createdAt ?? null }];
      }
      return overflow.slice(0, Number(values[1] ?? overflow.length)).map((r) => ({ id: r.id, createdAt: r.createdAt }));
    },
  },
}));

function groupByFingerprint(keep: number): Array<{ id: string; createdAt: Date }> {
  const byFp = new Map<string, Array<{ id: string; createdAt: Date }>>();
  for (const r of db.errorEvents) {
    if (!byFp.has(r.fingerprint)) byFp.set(r.fingerprint, []);
    byFp.get(r.fingerprint)!.push(r);
  }
  const out: Array<{ id: string; createdAt: Date }> = [];
  for (const rows of byFp.values()) {
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    out.push(...rows.slice(keep));
  }
  return out;
}

const { checkConfirm, confirmString, previewRetention, runRetention, RETENTION_RUN_CAP } = await import('./retention.ts');
const { clearSettingsCache, setSetting } = await import('../config/admin-settings.ts');
const { validateSetting } = await import('../config/admin-settings.ts');

beforeEach(() => {
  db.events = [];
  db.errorEvents = [];
  db.errorLogs = [];
  db.groups = [];
  db.settings.clear();
  clearSettingsCache();
});

function seedEvents(n: number, ageDays: number, offset = 0): void {
  for (let i = 0; i < n; i += 1) db.events.push({ id: `ev_${offset + i}`, ts: new Date(NOW - ageDays * DAY) });
}

describe('hard floors (§9.1 layer 1)', () => {
  it('rejects a below-floor retention outright rather than offering it to confirm', () => {
    // Typing 1 into the retention field is not "confirm carefully", it is refused.
    expect(validateSetting('retention.event_days', 1)).toEqual({ ok: false, reason: 'must be between 30 and 1095' });
    expect(validateSetting('retention.samples_per_group', 4)).toEqual({ ok: false, reason: 'must be between 5 and 100' });
  });

  it('accepts the floor itself, so the bound is inclusive and not off by one', () => {
    expect(validateSetting('retention.event_days', 30)).toEqual({ ok: true, value: 30 });
    expect(validateSetting('retention.samples_per_group', 5)).toEqual({ ok: true, value: 5 });
  });
});

describe('preview (§9.1 layer 2)', () => {
  it('reports the exact count and the range it spans for a narrowing change', async () => {
    seedEvents(4, 200); // inside 365, outside 90
    seedEvents(3, 40, 100); // inside both
    const p = await previewRetention('retention.event_days', 90, NOW);
    expect(p).not.toBeNull();
    expect(p!.widening).toBe(false);
    expect(p!.deletes).toBe(4);
    expect(p!.oldest).toBe(new Date(NOW - 200 * DAY).toISOString());
    expect(p!.confirm).toBe('delete 4 events');
  });

  it('treats a widening change as free: nothing deleted, no confirm', async () => {
    seedEvents(9, 500);
    const p = await previewRetention('retention.event_days', 500, NOW);
    expect(p!.widening).toBe(true);
    expect(p!.deletes).toBe(0);
    expect(p!.confirm).toBeNull();
  });

  it('counts rows past the newest N of their fingerprint, not rows past N overall', async () => {
    for (let i = 0; i < 30; i += 1) db.errorEvents.push({ id: `a${i}`, fingerprint: 'bug.a', createdAt: new Date(NOW - i * 1000) });
    for (let i = 0; i < 4; i += 1) db.errorEvents.push({ id: `b${i}`, fingerprint: 'bug.b', createdAt: new Date(NOW - i * 1000) });
    // Narrowing 20 -> 10: bug.a loses 20, bug.b (only 4 samples) loses none, so it is not "34 minus 10".
    const p = await previewRetention('retention.samples_per_group', 10, NOW);
    expect(p!.deletes).toBe(20);
    expect(p!.confirm).toBe('delete 20 error samples');
  });

  it('has no preview for a setting that deletes nothing', async () => {
    expect(await previewRetention('rate.admin_max', 10, NOW)).toBeNull();
    expect(await previewRetention('analytics.enabled', 0, NOW)).toBeNull();
  });
});

describe('type-to-confirm (§9.1 layer 3)', () => {
  it('refuses an absent confirmation', () => {
    expect(checkConfirm(undefined, 128_431, 'events')).toEqual({ ok: false, reason: 'absent', expected: 'delete 128431 events' });
  });

  it('refuses a mismatched string, and there is no force flag to get around it', () => {
    expect(checkConfirm('yes', 42, 'events').ok).toBe(false);
    expect(checkConfirm('DELETE 42 events', 42, 'events').ok).toBe(false);
    // Right number, wrong noun: this is someone pasting the confirmation from a different key.
    expect(checkConfirm('delete 42 error samples', 42, 'events')).toMatchObject({ ok: false, reason: 'shape' });
  });

  it('accepts the exact string the preview issued', () => {
    expect(checkConfirm(confirmString(128_431, 'events'), 128_431, 'events')).toEqual({ ok: true });
  });

  it('accepts a count that drifted under 10%, because the table moves while you read', () => {
    expect(checkConfirm('delete 1000 events', 1_050, 'events')).toEqual({ ok: true });
    expect(checkConfirm('delete 1000 events', 950, 'events')).toEqual({ ok: true });
  });

  it('refuses a count that drifted over 10% as a stale preview, not a typo', () => {
    expect(checkConfirm('delete 1000 events', 1_200, 'events')).toMatchObject({ ok: false, reason: 'drift' });
    expect(checkConfirm('delete 1000 events', 800, 'events')).toMatchObject({ ok: false, reason: 'drift' });
  });

  it('never lets a zero-count confirmation authorise a real deletion', () => {
    // The 10% tolerance is relative, so 0 confirmed against 5000 actual must still be drift.
    expect(checkConfirm('delete 0 events', 5_000, 'events')).toMatchObject({ ok: false, reason: 'drift' });
  });
});

describe('batched, capped deletion (§9.1 layer 4)', () => {
  it('prunes only what is past the window and leaves the rest alone', async () => {
    seedEvents(6, 400);
    seedEvents(4, 10, 100);
    db.errorLogs.push({ id: 'el_1', createdAt: new Date(NOW - 400 * DAY) });

    const report = await runRetention(NOW);
    expect(report.deleted.events).toBe(6);
    expect(report.deleted.errorLogs).toBe(1);
    expect(db.events).toHaveLength(4);
    expect(report.capped).toBe(false);
  });

  it('stops at the per-run cap and reports what it left behind', async () => {
    seedEvents(RETENTION_RUN_CAP + 2_500, 400);

    const report = await runRetention(NOW);
    expect(report.total).toBe(RETENTION_RUN_CAP);
    expect(report.capped).toBe(true);
    // A capped run that reported "done" would read as a completed prune, which is the mistake.
    expect(report.remaining).toBe(2_500);
    expect(db.events).toHaveLength(2_500);
  });

  it('keeps the newest N samples per fingerprint and drops the rest', async () => {
    for (let i = 0; i < 25; i += 1) db.errorEvents.push({ id: `s${i}`, fingerprint: 'bug.a', createdAt: new Date(NOW - i * 1000) });

    await runRetention(NOW);
    expect(db.errorEvents).toHaveLength(20);
    // The newest survive, so the most recent occurrence of a bug is always the one you can still read.
    expect(db.errorEvents.map((r) => r.id)).toContain('s0');
    expect(db.errorEvents.map((r) => r.id)).not.toContain('s24');
  });

  it('keeps error groups forever and only drops an ignored one untouched for two years', async () => {
    db.groups.push({ fingerprint: 'old.ignored', status: 'ignored', lastSeen: new Date(NOW - 800 * DAY) });
    db.groups.push({ fingerprint: 'recent.ignored', status: 'ignored', lastSeen: new Date(NOW - 100 * DAY) });
    db.groups.push({ fingerprint: 'ancient.resolved', status: 'resolved', lastSeen: new Date(NOW - 3000 * DAY) });

    const report = await runRetention(NOW);
    expect(report.deleted.groups).toBe(1);
    expect(db.groups.map((g) => g.fingerprint).sort()).toEqual(['ancient.resolved', 'recent.ignored']);
  });

  it('honours a narrowed retention setting on the very next run', async () => {
    seedEvents(5, 200);
    expect((await runRetention(NOW)).deleted.events).toBe(0); // inside the 365-day default

    await setSetting('retention.event_days', 90);
    expect((await runRetention(NOW)).deleted.events).toBe(5);
  });
});
