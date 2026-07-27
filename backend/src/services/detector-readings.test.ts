// The detector queries themselves, driven with fixture rows that straddle each threshold.
//
// levelFor is already pinned in detectors.test.ts, so what is left to prove is the part a pure function
// cannot: that each read() turns real-shaped rows into the number the threshold expects, in the right
// unit and the right direction. A detector that measures the wrong thing grades perfectly and still lies.
//
// Prisma is mocked per case, so no database is touched and no play is ever looped (L-010).

import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { TREASURY_MIN_DUSDC } from '../config/main-config.ts';

const NOW = Date.parse('2026-07-27T12:00:00.000Z');

// One mutable fixture set the mock reads from, so a case just assigns the rows it cares about.
const db = {
  plays: [] as Array<Record<string, unknown>>,
  deposits: [] as Array<{ status: string; createdAt: Date }>,
  events: [] as Array<{ name: string; ts: Date }>,
  groups: [] as Array<Record<string, unknown>>,
  opsSnapshot: null as string | null,
};

const matches = (row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean => {
  if (!where) return true;
  for (const [field, cond] of Object.entries(where)) {
    const v = row[field];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ('gte' in c && !(toMs(v) >= toMs(c.gte))) return false;
      if ('lt' in c && !(toMs(v) < toMs(c.lt))) return false;
      if ('gt' in c && !(Number(v) > Number(c.gt))) return false;
      if ('in' in c && !(c.in as unknown[]).includes(v)) return false;
      if ('not' in c) {
        if (c.not === null && v == null) return false;
        if (c.not !== null && v === c.not) return false;
      }
    } else if (v !== cond) return false;
  }
  return true;
};

const toMs = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));

const table = (rows: () => Array<Record<string, unknown>>) => ({
  count: async ({ where }: { where?: Record<string, unknown> } = {}) => rows().filter((r) => matches(r, where)).length,
  findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => rows().filter((r) => matches(r, where)),
});

mock.module('../lib/prisma.ts', () => ({
  prismaQuery: {
    play: table(() => db.plays),
    deposit: table(() => db.deposits as unknown as Array<Record<string, unknown>>),
    event: table(() => db.events as unknown as Array<Record<string, unknown>>),
    errorGroup: table(() => db.groups),
    appConfig: { findUnique: async () => (db.opsSnapshot ? { value: db.opsSnapshot } : null), upsert: async () => ({}) },
  },
}));

// The chain-backed detectors read a live wallet or the in-memory market set, so they are driven through
// their own seams. Each mock spreads the real module first: replacing one wholesale would strip the other
// exports its siblings import, and the whole graph fails to load.
let sponsor = { enabled: true, reserveSui: 10, floorSui: 0.5, paused: false, burnSuiPerHour: 0.5 as number | null, hoursLeft: 19 as number | null, checkedAt: NOW };
const realSafety = await import('../lib/sui/play-safety.ts');
mock.module('../lib/sui/play-safety.ts', () => ({ ...realSafety, sponsorHealth: () => sponsor }));

let treasuryDusdc = 50;
const realDusdc = await import('../lib/sui/dusdc.ts');
mock.module('../lib/sui/dusdc.ts', () => ({ ...realDusdc, getDusdcBalance: async () => treasuryDusdc }));

let workers: Array<{ name: string; intervalMs: number | null; lastRunAt: number | null }> = [];
const realRegistry = await import('../lib/worker-registry.ts');
mock.module('../lib/worker-registry.ts', () => ({ ...realRegistry, allWorkerHealth: () => workers }));

let liveMarkets = 3;
const realMarkets = await import('../lib/sui/markets.ts');
mock.module('../lib/sui/markets.ts', () => ({ ...realMarkets, tradeableMarkets: () => Array.from({ length: liveMarkets }, () => ({})) }));

const { DETECTORS, levelFor } = await import('./insights.ts');

const byKey = (key: string) => DETECTORS.find((d) => d.key === key)!;

/** What the cron would record for this detector right now. */
async function grade(key: string): Promise<{ level: string; value: number | null }> {
  const d = byKey(key);
  const reading = await d.read(NOW);
  return { level: levelFor(d, reading.value), value: reading.value };
}

const minsAgo = (m: number) => new Date(NOW - m * 60_000);

beforeEach(() => {
  db.plays = [];
  db.deposits = [];
  db.events = [];
  db.groups = [];
  db.opsSnapshot = null;
  sponsor ={ enabled: true, reserveSui: 10, floorSui: 0.5, paused: false, burnSuiPerHour: 0.5, hoursLeft: 19, checkedAt: NOW };
  treasuryDusdc = 50;
  workers = [];
  liveMarkets = 3;
});

describe('play_failure_rate (warn 5%, critical 15%)', () => {
  const plays = (total: number, errors: number) =>
    Array.from({ length: total }, (_, i) => ({ createdAt: minsAgo(5), status: i < errors ? 'error' : 'won', openedAt: null }));

  it('abstains below the sample floor, so one bad play in an idle window is not a 100% outage', () => {
    db.plays = plays(4, 4);
    return expect(grade('play_failure_rate')).resolves.toEqual({ level: 'ok', value: null });
  });

  it('straddles both thresholds', async () => {
    db.plays = plays(100, 4);
    expect(await grade('play_failure_rate')).toEqual({ level: 'ok', value: 4 });
    db.plays = plays(100, 5);
    expect(await grade('play_failure_rate')).toEqual({ level: 'warn', value: 5 });
    db.plays = plays(100, 14);
    expect(await grade('play_failure_rate')).toEqual({ level: 'warn', value: 14 });
    db.plays = plays(100, 15);
    expect(await grade('play_failure_rate')).toEqual({ level: 'critical', value: 15 });
  });

  it('ignores plays older than the 15 minute window', async () => {
    db.plays = [...plays(20, 0), ...Array.from({ length: 20 }, () => ({ createdAt: minsAgo(60), status: 'error', openedAt: null }))];
    expect(await grade('play_failure_rate')).toEqual({ level: 'ok', value: 0 });
  });
});

describe('stuck_pending (warn 3, critical 10)', () => {
  const pending = (n: number, ageMs: number) => Array.from({ length: n }, () => ({ status: 'pending', createdAt: new Date(NOW - ageMs), openedAt: null }));

  it('only counts plays past the stuck threshold, not every pending one', async () => {
    db.plays = pending(20, 5_000); // all fresh, a normal in-flight burst
    expect(await grade('stuck_pending')).toEqual({ level: 'ok', value: 0 });
  });

  it('straddles both thresholds', async () => {
    db.plays = pending(2, 120_000);
    expect(await grade('stuck_pending')).toEqual({ level: 'ok', value: 2 });
    db.plays = pending(3, 120_000);
    expect(await grade('stuck_pending')).toEqual({ level: 'warn', value: 3 });
    db.plays = pending(10, 120_000);
    expect(await grade('stuck_pending')).toEqual({ level: 'critical', value: 10 });
  });
});

describe('mint_latency p95 (warn 4s, critical 10s)', () => {
  const mints = (latencies: number[]) =>
    latencies.map((ms) => ({ createdAt: minsAgo(5), openedAt: new Date(NOW - 5 * 60_000 + ms), status: 'open' }));

  it('is quiet with no mints at all rather than reporting zero latency', async () => {
    expect(await grade('mint_latency')).toEqual({ level: 'ok', value: null });
  });

  it('reads the p95, not the average, so a fast median cannot hide a slow tail', async () => {
    // 94 fast mints and 6 slow ones: the mean is well under a second and the median is 300ms, but the
    // slowest 5% are all 12s, which is exactly the tail an average would bury.
    db.plays = mints([...Array.from({ length: 94 }, () => 300), ...Array.from({ length: 6 }, () => 12_000)]);
    expect(await grade('mint_latency')).toEqual({ level: 'critical', value: 12_000 });
  });

  it('straddles both thresholds', async () => {
    db.plays = mints(Array.from({ length: 20 }, () => 3_900));
    expect(await grade('mint_latency')).toEqual({ level: 'ok', value: 3_900 });
    db.plays = mints(Array.from({ length: 20 }, () => 4_000));
    expect(await grade('mint_latency')).toEqual({ level: 'warn', value: 4_000 });
    db.plays = mints(Array.from({ length: 20 }, () => 10_000));
    expect(await grade('mint_latency')).toEqual({ level: 'critical', value: 10_000 });
  });
});

describe('settle_lag p95 (warn 15s, critical 60s)', () => {
  const settles = (lags: number[], status = 'won') =>
    lags.map((ms) => ({ settledAt: new Date(NOW - 60_000 + ms), expiry: BigInt(NOW - 60_000), status, createdAt: minsAgo(10), openedAt: null }));

  it('straddles both thresholds', async () => {
    db.plays = settles([14_000]);
    expect(await grade('settle_lag')).toEqual({ level: 'ok', value: 14_000 });
    db.plays = settles([15_000]);
    expect(await grade('settle_lag')).toEqual({ level: 'warn', value: 15_000 });
    db.plays = settles([60_000]);
    expect(await grade('settle_lag')).toEqual({ level: 'critical', value: 60_000 });
  });

  it('excludes cash-outs, which close before expiry and would read as a negative lag', async () => {
    db.plays = settles([-30_000], 'cashed_out');
    expect(await grade('settle_lag')).toEqual({ level: 'ok', value: null });
  });
});

describe('deposits_failing (warn 10%, critical 25%)', () => {
  const settled = (n: number, status: string) => Array.from({ length: n }, () => ({ status, createdAt: new Date(NOW - 6 * 3_600_000) }));

  it('abstains under three settled-age deposits', async () => {
    db.deposits = settled(2, 'FAILED');
    expect(await grade('deposits_failing')).toEqual({ level: 'ok', value: null });
  });

  it('never counts a bridge that is still inside its two hour grace window', async () => {
    db.deposits = [...settled(10, 'DONE'), ...Array.from({ length: 10 }, () => ({ status: 'PENDING', createdAt: new Date(NOW - 60_000) }))];
    expect(await grade('deposits_failing')).toEqual({ level: 'ok', value: 0 });
  });

  it('counts an old PENDING as failing, alongside FAILED', async () => {
    db.deposits = [...settled(15, 'DONE'), ...settled(3, 'FAILED'), ...settled(2, 'PENDING')];
    expect(await grade('deposits_failing')).toEqual({ level: 'critical', value: 25 });
  });
});

describe('sponsor_runway (inverted: warn 12h, critical 3h)', () => {
  it('straddles both thresholds', async () => {
    sponsor.hoursLeft = 12.1;
    expect((await grade('sponsor_runway')).level).toBe('ok');
    sponsor.hoursLeft = 12;
    expect((await grade('sponsor_runway')).level).toBe('warn');
    sponsor.hoursLeft = 3;
    expect((await grade('sponsor_runway')).level).toBe('critical');
  });

  it('is critical the moment plays are paused, whatever the burn rate implies', async () => {
    sponsor.paused = true;
    sponsor.hoursLeft = 999;
    expect(await grade('sponsor_runway')).toEqual({ level: 'critical', value: 0 });
  });

  it('abstains when burn has not been measured yet, rather than reporting infinite runway', async () => {
    sponsor.burnSuiPerHour = null;
    sponsor.hoursLeft = null;
    expect(await grade('sponsor_runway')).toEqual({ level: 'ok', value: null });
  });
});

describe('treasury_chips (inverted: warn at 2x the minimum, critical at 1x)', () => {
  it('grades against the configured minimum, not an absolute balance', async () => {
    // Read the floor rather than assuming it: this machine's .env may set its own, and a test that only
    // passes on one developer's config proves nothing about the detector.
    const min = Math.max(1, TREASURY_MIN_DUSDC);

    treasuryDusdc = min * 10;
    expect(await grade('treasury_chips')).toEqual({ level: 'ok', value: 10 });
    treasuryDusdc = min * 2.1;
    expect((await grade('treasury_chips')).level).toBe('ok');
    treasuryDusdc = min * 2;
    expect(await grade('treasury_chips')).toEqual({ level: 'warn', value: 2 });
    treasuryDusdc = min;
    expect(await grade('treasury_chips')).toEqual({ level: 'critical', value: 1 });
    treasuryDusdc = 0;
    expect(await grade('treasury_chips')).toEqual({ level: 'critical', value: 0 });
  });
});

describe('worker_staleness (warn any stale, critical a load-bearing one)', () => {
  const worker = (name: string, lastRunMinsAgo: number) => ({ name, intervalMs: 60_000, lastRunAt: NOW - lastRunMinsAgo * 60_000 });

  it('allows up to 3x a worker cadence before calling it stale', async () => {
    workers = [worker('settle', 2)];
    expect(await grade('worker_staleness')).toEqual({ level: 'ok', value: 0 });
  });

  it('warns on a non-critical worker and escalates for settle or market-sync', async () => {
    workers = [worker('price-warmer', 10)];
    expect(await grade('worker_staleness')).toEqual({ level: 'warn', value: 1 });
    workers = [worker('price-warmer', 10), worker('settle', 10)];
    expect(await grade('worker_staleness')).toEqual({ level: 'critical', value: 2 });
  });

  it('never flags a worker with no cadence or one that has never run', async () => {
    workers = [{ name: 'binance-socket', intervalMs: null, lastRunAt: null }, { name: 'analytics-digest', intervalMs: 86_400_000, lastRunAt: null }];
    expect(await grade('worker_staleness')).toEqual({ level: 'ok', value: 0 });
  });

  it('gives a sub-minute worker a full minute of silence before calling it stale', async () => {
    // market-sync runs every 2s and price-history every 500ms, and lastRunAt is stamped when a tick
    // FINISHES, so a bare 3x rule marks them stale after one slow chain read. That paged for a healthy
    // system the first time this ran against the real stack.
    workers = [{ name: 'market-sync', intervalMs: 2_000, lastRunAt: NOW - 30_000 }, { name: 'price-history', intervalMs: 500, lastRunAt: NOW - 5_000 }];
    expect(await grade('worker_staleness')).toEqual({ level: 'ok', value: 0 });

    // A full minute of silence from market-sync is a real fault, and it is a load-bearing worker.
    workers = [{ name: 'market-sync', intervalMs: 2_000, lastRunAt: NOW - 61_000 }];
    expect(await grade('worker_staleness')).toEqual({ level: 'critical', value: 2 });
  });
});

describe('auth_failures (warn 10%, critical 30%)', () => {
  const attempts = (ok: number, fail: number) => [
    ...Array.from({ length: ok }, () => ({ name: 'door.auth_ok', ts: minsAgo(5) })),
    ...Array.from({ length: fail }, () => ({ name: 'door.auth_fail', ts: minsAgo(5) })),
  ];

  it('abstains below the sample floor', async () => {
    db.events = attempts(1, 2);
    expect(await grade('auth_failures')).toEqual({ level: 'ok', value: null });
  });

  it('straddles both thresholds', async () => {
    db.events = attempts(91, 9);
    expect(await grade('auth_failures')).toEqual({ level: 'ok', value: 9 });
    db.events = attempts(90, 10);
    expect(await grade('auth_failures')).toEqual({ level: 'warn', value: 10 });
    db.events = attempts(70, 30);
    expect(await grade('auth_failures')).toEqual({ level: 'critical', value: 30 });
  });
});

describe('new_bug_shipped and regression', () => {
  const group = (over: Record<string, unknown>) => ({
    title: 'boom',
    level: 'error',
    count: 100,
    status: 'open',
    firstSeen: minsAgo(2),
    resolvedAt: null,
    ...over,
  });

  it('ignores a new group that is not loud yet, and an old loud one', async () => {
    db.groups = [group({ count: 20 }), group({ firstSeen: minsAgo(60), count: 5000 })];
    expect(await grade('new_bug_shipped')).toEqual({ level: 'ok', value: 0 });
  });

  it('warns on a loud new group and escalates when it is fatal', async () => {
    db.groups = [group({ count: 21 })];
    expect(await grade('new_bug_shipped')).toEqual({ level: 'warn', value: 1 });
    db.groups = [group({ count: 21, level: 'fatal' })];
    expect(await grade('new_bug_shipped')).toEqual({ level: 'critical', value: 2 });
  });

  it('never counts an ignored group, which is how an expected abort stays quiet', async () => {
    db.groups = [group({ count: 5000, status: 'ignored' })];
    expect(await grade('new_bug_shipped')).toEqual({ level: 'ok', value: 0 });
  });

  it('calls a reopened group a regression, and only until someone triages it', async () => {
    db.groups = [group({ status: 'open', resolvedAt: minsAgo(600) })];
    expect(await grade('regression')).toEqual({ level: 'critical', value: 1 });
    // Acking it clears resolvedAt (setErrorStatus), so the banner stops shouting about a known regression.
    db.groups = [group({ status: 'ack', resolvedAt: null })];
    expect(await grade('regression')).toEqual({ level: 'ok', value: 0 });
  });
});

describe('live_markets (minutes at zero: warn 2, critical 10)', () => {
  it('reports zero minutes while markets exist', async () => {
    expect(await grade('live_markets')).toEqual({ level: 'ok', value: 0 });
  });

  it('measures how long the set has been empty, not merely that it is', async () => {
    const d = byKey('live_markets');
    liveMarkets = 0;
    expect(levelFor(d, (await d.read(NOW)).value)).toBe('ok'); // first empty tick starts the clock
    expect(levelFor(d, (await d.read(NOW + 3 * 60_000)).value)).toBe('warn');
    expect(levelFor(d, (await d.read(NOW + 11 * 60_000)).value)).toBe('critical');

    // One market coming back resets the clock, so a recovery does not stay red.
    liveMarkets = 1;
    expect(await grade('live_markets')).toEqual({ level: 'ok', value: 0 });
  });

  it('resumes the clock from the persisted snapshot, so a restart cannot rewind a real outage', async () => {
    liveMarkets = 1;
    await grade('live_markets'); // clear the in-memory counter, standing in for a fresh process
    db.opsSnapshot = JSON.stringify({
      checkedAt: new Date(NOW).toISOString(),
      worst: 'critical',
      detectors: [{ key: 'live_markets', level: 'critical', value: 620 }],
    });

    liveMarkets = 0;
    // Without the resume this reads 0 minutes and the banner goes green through a 10-hour outage.
    expect(await grade('live_markets')).toEqual({ level: 'critical', value: 620 });
  });
});
