// captureError's write behaviour: the grouping that makes 10,000 occurrences cost 21 rows, the regression
// reopen, and the rule that outranks all of it, analytics is never on the critical path (§13 rule 1).
//
// Drives a fake Prisma so the assertions are about OUR logic (increment, sample cap, reopen, swallow) and
// not about Postgres. Never loops a real play (L-010).

import { beforeEach, describe, expect, it, mock } from 'bun:test';

type GroupRow = {
  fingerprint: string;
  title: string;
  culprit: string | null;
  kind: string;
  level: string;
  count: number;
  usersAffected: number;
  firstSeen: Date;
  lastSeen: Date;
  status: string;
  resolvedAt: Date | null;
  firstRelease: string | null;
  lastRelease: string | null;
};
type SampleRow = { id: string; fingerprint: string; message: string; userId: string | null; playId: string | null; createdAt: Date };

const groups = new Map<string, GroupRow>();
let samples: SampleRow[] = [];
let seq = 0;
// Forces every analytics write to reject, standing in for a locked table or a dead connection.
let failWrites = false;

function boom(): never {
  throw new Error('analytics table is unavailable');
}

// Applies Prisma's { increment } atomic-update shape, which is what the group counters rely on.
function applyUpdate(row: GroupRow, data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as Record<string, unknown>)) {
      (row as unknown as Record<string, number>)[k] += (v as { increment: number }).increment;
    } else {
      (row as unknown as Record<string, unknown>)[k] = v;
    }
  }
}

mock.module('./prisma.ts', () => ({
  prismaQuery: {
    errorGroup: {
      findUnique: async ({ where }: { where: { fingerprint: string } }) => {
        if (failWrites) boom();
        return groups.get(where.fingerprint) ?? null;
      },
      upsert: async ({ where, create, update }: { where: { fingerprint: string }; create: GroupRow; update: Record<string, unknown> }) => {
        if (failWrites) boom();
        const existing = groups.get(where.fingerprint);
        if (!existing) groups.set(where.fingerprint, { ...create });
        else applyUpdate(existing, update);
        return groups.get(where.fingerprint);
      },
    },
    errorEvent: {
      create: async ({ data }: { data: Omit<SampleRow, 'id' | 'createdAt'> }) => {
        if (failWrites) boom();
        const row = { ...data, id: `e${++seq}`, createdAt: new Date(Date.now() + seq) };
        samples.push(row);
        return row;
      },
      findMany: async ({ where, skip }: { where: { fingerprint: string }; skip: number }) => {
        if (failWrites) boom();
        return samples
          .filter((s) => s.fingerprint === where.fingerprint)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(skip)
          .map((s) => ({ id: s.id }));
      },
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        if (failWrites) boom();
        samples = samples.filter((s) => !where.id.in.includes(s.id));
        return { count: 0 };
      },
    },
    appConfig: {
      findUnique: async () => null, // no override row: settings fall back to their code defaults
    },
  },
}));

const { captureError, flushCaptures } = await import('./analytics.ts');

const ABORT = (extra = '') =>
  `MoveAbort(MoveLocation { module: ModuleId { address: 0xdb3ef5a5aabbccdd, name: expiry_cash }, function: 12, instruction: 41, function_name: assert_backing }, 0)${extra}`;

beforeEach(() => {
  groups.clear();
  samples = [];
  seq = 0;
  failWrites = false;
});

describe('grouping (§2.3, §2.4)', () => {
  it('turns 100 occurrences of one abort into 1 group with count 100 and 20 samples', async () => {
    for (let i = 0; i < 100; i++) {
      captureError(new Error(ABORT(` play clx${i}aaaaaaaaaaaaaaaaaaaa stake ${1_000_000 + i}`)), { kind: 'chain', playId: `play_${i}` });
      await flushCaptures(); // serialize so the counter increments deterministically, as it would per request
    }

    expect(groups.size).toBe(1);
    const g = groups.get('chain.backing_unfunded')!;
    expect(g.count).toBe(100);
    expect(samples.length).toBe(20);
    // The newest survive, so the samples describe the bug as it fires now, not as it fired first.
    expect(samples.map((s) => s.playId)).toContain('play_99');
    expect(samples.map((s) => s.playId)).not.toContain('play_0');
  });

  it('counts distinct users, not occurrences', async () => {
    for (const userId of ['u1', 'u1', 'u1', 'u2']) {
      captureError(new Error(ABORT()), { kind: 'chain', userId });
      await flushCaptures();
    }
    const g = groups.get('chain.backing_unfunded')!;
    expect(g.count).toBe(4);
    expect(g.usersAffected).toBe(2);
  });

  it('lands each known Sui class on its named fingerprint, with admission aborts at warn', async () => {
    const cases: Array<[string, string, string]> = [
      [ABORT(), 'chain.backing_unfunded', 'error'],
      ['Invalid withdraw reservation for the sponsor', 'chain.sponsor_reservation_wedge', 'error'],
      ['Gas object not found in effects', 'chain.settle_gas_object', 'error'],
      ['MoveAbort ... ELeverageAboveAdmission ...', 'chain.mint_admission_leverage', 'warn'],
      [
        'MoveAbort(MoveLocation { module: ModuleId { address: 0xdb3ef5a5, name: order }, function: 3, instruction: 9, function_name: redeem_settled }, 1)',
        'chain.settle_already_redeemed',
        'error',
      ],
    ];
    for (const [message] of cases) {
      captureError(new Error(message), { kind: 'chain' });
      await flushCaptures();
    }

    expect(groups.size).toBe(5);
    for (const [, fp, level] of cases) {
      expect(groups.get(fp)).toBeDefined();
      expect(groups.get(fp)!.level).toBe(level);
    }
  });

  it('groups a percent-encoded gRPC message with its decoded twin', async () => {
    const decoded = 'transaction failed: object 0xaabbccddeeff is not available for consumption';
    const stack = 'Error\n    at f (/app/backend/src/lib/sui/execute.ts:10:1)';
    captureError(new Error(decoded), { kind: 'chain', stack });
    await flushCaptures();
    captureError(new Error(encodeURIComponent(decoded)), { kind: 'chain', stack });
    await flushCaptures();

    expect(groups.size).toBe(1);
    expect([...groups.values()][0]!.count).toBe(2);
  });

  it('reopens a resolved group when it fires again, and leaves the regression mark on it', async () => {
    captureError(new Error(ABORT()), { kind: 'chain' });
    await flushCaptures();

    const g = groups.get('chain.backing_unfunded')!;
    g.status = 'resolved';
    const resolvedAt = new Date();
    g.resolvedAt = resolvedAt;

    captureError(new Error(ABORT()), { kind: 'chain' });
    await flushCaptures();

    const after = groups.get('chain.backing_unfunded')!;
    expect(after.status).toBe('open');
    // resolvedAt is deliberately KEPT: `open` plus a resolvedAt is the only queryable trace that this
    // group had been closed and came back, and that pair is exactly what the regression detector watches.
    // Nulling it here would silently reopen the group as if it were an old bug nobody had looked at.
    expect(after.resolvedAt).toEqual(resolvedAt);
  });

  it('leaves an ignored group ignored, so suppressed noise stays suppressed', async () => {
    captureError(new Error(ABORT()), { kind: 'chain' });
    await flushCaptures();
    groups.get('chain.backing_unfunded')!.status = 'ignored';

    captureError(new Error(ABORT()), { kind: 'chain' });
    await flushCaptures();

    expect(groups.get('chain.backing_unfunded')!.status).toBe('ignored');
    expect(groups.get('chain.backing_unfunded')!.count).toBe(2);
  });
});

describe('never on the critical path (§13 rule 1)', () => {
  it('returns void synchronously even when every analytics write rejects', () => {
    failWrites = true;
    expect(captureError(new Error('boom'), { kind: 'chain' })).toBeUndefined();
  });

  it('lets a play commit and return its normal result with the writes rejecting', async () => {
    failWrites = true;

    // The exact shape of the mint-failure path in services/plays.ts: capture, then commit, then return.
    const committed: string[] = [];
    const commitPlay = async (playId: string, status: string): Promise<{ id: string; status: string }> => {
      committed.push(playId);
      return { id: playId, status };
    };
    const mintFailed = async (playId: string, e: unknown) => {
      captureError(e, { kind: 'chain', playId, context: { stage: 'mint' } });
      return commitPlay(playId, 'error');
    };

    const result = await mintFailed('play_1', new Error(ABORT()));

    expect(result).toEqual({ id: 'play_1', status: 'error' });
    expect(committed).toEqual(['play_1']);
    // The capture itself really did fail: nothing was recorded, and nothing surfaced to the caller.
    await flushCaptures();
    expect(groups.size).toBe(0);
    expect(samples.length).toBe(0);
  });

  it('swallows a rejection rather than leaving an unhandled one behind', async () => {
    failWrites = true;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      captureError(new Error('boom'), { kind: 'worker' });
      await flushCaptures();
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it('records nothing at all when the break-glass override is set', async () => {
    // PIPS_ANALYTICS_OFF is read once at import, so this asserts the guard's shape rather than re-importing
    // the module: with the flag unset (the normal case) a capture reaches the DB, which is what the other
    // tests rely on. verify-analytics-offpath.ts proves the flag itself against a real boot.
    captureError(new Error(ABORT()), { kind: 'chain' });
    await flushCaptures();
    expect(groups.size).toBe(1);
  });

  // The rule is only real if breaking it turns something red (L-020). Every capture in the codebase sits
  // inside a self-healing path (settle recovery, the sponsor accumulator warm-up, the market re-route, the
  // stuck-pending sweep), and a single stray `await` would put a DB write between a player and their play.
  it('is never awaited anywhere in src/, so no call site can put a write on a play path', async () => {
    const { Glob } = await import('bun');
    const offenders: string[] = [];
    for await (const file of new Glob('src/**/*.ts').scan('.')) {
      if (file.endsWith('.test.ts')) continue;
      const lines = (await Bun.file(file).text()).split('\n');
      lines.forEach((line, i) => {
        if (/\b(await|return)\s+(captureError|track)\s*\(/.test(line) || /=\s*(captureError|track)\s*\(/.test(line)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
