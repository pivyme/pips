// The Overview money aggregates and the Performance latency maths, against fixtures whose answers were
// computed by hand before the code ran.
//
// This is A6 item 10's second half, and it is the test everybody skips. A dashboard that under-reports
// looks exactly like a healthy product, and a money number that is quietly wrong gets believed for weeks.
// So the percentile edge cases that make percentiles lie (empty window, one sample, an even count) are
// pinned here alongside volume, PnL, rake, and win rate.
//
// Everything under test is pure over rows, so no database, no chain, and no play is ever looped (L-010).

import { describe, expect, it } from 'bun:test';

import {
  computePlayAggregates,
  computeRouteLatency,
  dailySeries,
  latencySeries,
  mintLatencies,
  percentile,
  settleLags,
  type LatencyRow,
  type PlayAggRow,
} from './insights.ts';

const $ = (dollars: number): bigint => BigInt(Math.round(dollars * 1_000_000));

const play = (p: Partial<PlayAggRow>): PlayAggRow => ({
  game: 'lucky',
  status: 'won',
  stake: $(1),
  entryCost: $(1),
  rake: 0n,
  pnl: null,
  multiplier: null,
  ...p,
});

// Six plays: two settled wins, one settled loss, one losing cash-out, and two that never resolved.
// Hand-computed: volume 5.50, player PnL +1.25, rake 0.11, win rate 50%, avg stake 1.67, avg multiplier 3.
const LEDGER: PlayAggRow[] = [
  play({ game: 'lucky', status: 'won', stake: $(2), entryCost: $(1.5), rake: $(0.03), pnl: $(3), multiplier: 3 }),
  play({ game: 'lucky', status: 'lost', stake: $(2), entryCost: $(2), rake: $(0.04), pnl: $(-2), multiplier: 5 }),
  play({ game: 'range', status: 'cashed_out', stake: $(1), entryCost: $(1), rake: $(0.02), pnl: $(0.5), multiplier: 2 }),
  play({ game: 'range', status: 'cashed_out', stake: $(1), entryCost: $(1), rake: $(0.02), pnl: $(-0.25), multiplier: 2 }),
  play({ game: 'moonshot', status: 'error', stake: $(3), entryCost: 0n, rake: 0n, pnl: null, multiplier: null }),
  play({ game: 'moonshot', status: 'pending', stake: $(1), entryCost: 0n, rake: 0n, pnl: null, multiplier: null }),
];

describe('computePlayAggregates', () => {
  it('counts every play but settles money only on settled ones', () => {
    const a = computePlayAggregates(LEDGER);
    expect(a.plays).toBe(6);
    expect(a.settled).toBe(4);
    // 1.50 + 2.00 + 1.00 + 1.00. The errored and pending plays cost nobody anything.
    expect(a.volume).toBe(5.5);
  });

  it('reports the house side as the negation of the players', () => {
    const a = computePlayAggregates(LEDGER);
    // +3.00 - 2.00 + 0.50 - 0.25
    expect(a.playerNetPnl).toBe(1.25);
    expect(a.netHousePnl).toBe(-1.25);
  });

  it('collects rake on every play that minted, settled or not', () => {
    expect(computePlayAggregates(LEDGER).rake).toBe(0.11);
  });

  it('counts a profitable cash-out as a win and a losing one as a loss', () => {
    // 2 wins ('won' plus the cash-out that closed up) of 4 settled.
    expect(computePlayAggregates(LEDGER).winRatePct).toBe(50);
  });

  it('averages stake over every play and multiplier only where one exists', () => {
    const a = computePlayAggregates(LEDGER);
    expect(a.avgStake).toBe(1.67); // 10.00 / 6
    expect(a.avgMultiplier).toBe(3); // (3 + 5 + 2 + 2) / 4
  });

  it('splits by game, most played first, with only settled volume', () => {
    expect(computePlayAggregates(LEDGER).byGame).toEqual([
      { game: 'lucky', plays: 2, volume: 3.5 },
      { game: 'range', plays: 2, volume: 2 },
      { game: 'moonshot', plays: 2, volume: 0 },
    ]);
  });

  it('reports nulls rather than zeros on an empty window', () => {
    const a = computePlayAggregates([]);
    expect(a.plays).toBe(0);
    expect(a.volume).toBe(0);
    expect(a.avgStake).toBeNull();
    expect(a.avgMultiplier).toBeNull();
    // A 0% win rate on no plays reads as "everyone is losing", which is a lie.
    expect(a.winRatePct).toBeNull();
  });

  it('never reports a win rate off unsettled plays alone', () => {
    const a = computePlayAggregates([play({ status: 'pending', pnl: null }), play({ status: 'open', pnl: null })]);
    expect(a.settled).toBe(0);
    expect(a.winRatePct).toBeNull();
  });
});

describe('percentile', () => {
  it('is null on an empty window', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([], 95)).toBeNull();
  });

  it('is the sample itself when there is exactly one', () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 95)).toBe(7);
  });

  it('never averages two observations into one that never happened', () => {
    // Nearest rank: p50 of an even count is the lower of the middle pair, not their mean.
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
  });

  it('catches a tail an average would bury', () => {
    const values = [...Array.from({ length: 19 }, () => 100), 9000];
    expect(percentile(values, 50)).toBe(100);
    expect(percentile(values, 95)).toBe(100);
    expect(percentile(values, 100)).toBe(9000);
  });
});

const T0 = Date.parse('2026-07-27T12:00:00.000Z');

const row = (p: Partial<LatencyRow>): LatencyRow => ({
  createdAt: new Date(T0),
  openedAt: null,
  settledAt: null,
  expiry: BigInt(T0),
  status: 'won',
  ...p,
});

describe('mintLatencies', () => {
  it('measures request to mint and skips a play that never minted', () => {
    const samples = mintLatencies([
      row({ createdAt: new Date(T0), openedAt: new Date(T0 + 1200) }),
      row({ createdAt: new Date(T0), openedAt: new Date(T0 + 400) }),
      row({ createdAt: new Date(T0), openedAt: null, status: 'error' }),
    ]);
    expect(samples.map((s) => s.ms)).toEqual([1200, 400]);
  });

  it('drops a clock-skewed negative rather than folding it in as zero', () => {
    expect(mintLatencies([row({ createdAt: new Date(T0), openedAt: new Date(T0 - 50) })])).toEqual([]);
  });
});

describe('settleLags', () => {
  it('measures expiry to settlement on expiry-settled plays only', () => {
    const samples = settleLags([
      row({ status: 'won', expiry: BigInt(T0), settledAt: new Date(T0 + 3000) }),
      row({ status: 'lost', expiry: BigInt(T0), settledAt: new Date(T0 + 9000) }),
      // A cash-out closes BEFORE expiry, so counting it would read as a negative lag and drag p50 down.
      row({ status: 'cashed_out', expiry: BigInt(T0 + 20_000), settledAt: new Date(T0 + 5000) }),
    ]);
    expect(samples.map((s) => s.ms)).toEqual([3000, 9000]);
  });

  it('floors an early settle at zero instead of going negative', () => {
    expect(settleLags([row({ status: 'won', expiry: BigInt(T0), settledAt: new Date(T0 - 500) })])[0]!.ms).toBe(0);
  });
});

describe('latencySeries', () => {
  const BUCKET = 60_000;

  it('buckets by time and keeps an empty bucket in its slot', () => {
    const series = latencySeries(
      [
        { t: T0 + 1_000, ms: 100 },
        { t: T0 + 2_000, ms: 300 },
        // nothing in bucket 1
        { t: T0 + 125_000, ms: 900 },
      ],
      BUCKET,
      T0,
      T0 + 3 * BUCKET
    );
    expect(series.map((p) => p.n)).toEqual([2, 0, 1]);
    expect(series.map((p) => p.t)).toEqual([T0, T0 + BUCKET, T0 + 2 * BUCKET]);
    // An empty bucket is a gap in the data, not a zero-latency minute.
    expect(series[1]!.p50).toBeNull();
    expect(series[1]!.p95).toBeNull();
    expect(series[0]!.p50).toBe(100);
    expect(series[2]!.p95).toBe(900);
  });

  it('ignores a sample outside the window rather than clamping it into an edge bucket', () => {
    const series = latencySeries(
      [
        { t: T0 - 1, ms: 5000 },
        { t: T0 + 3 * BUCKET, ms: 5000 },
      ],
      BUCKET,
      T0,
      T0 + 3 * BUCKET
    );
    expect(series.every((p) => p.n === 0)).toBe(true);
  });
});

describe('computeRouteLatency', () => {
  it('ranks the slowest route first and reports its own max', () => {
    const rows = computeRouteLatency([
      { route: 'GET /markets', samples: [10, 12, 14, 900] },
      { route: 'POST /games/lucky/play', samples: [1000, 1200, 1400, 1600] },
      { route: 'GET /health', samples: [] },
    ]);
    expect(rows.map((r) => r.route)).toEqual(['POST /games/lucky/play', 'GET /markets', 'GET /health']);
    expect(rows[0]).toEqual({ route: 'POST /games/lucky/play', n: 4, p50: 1200, p95: 1600, max: 1600 });
    expect(rows[1]!.p95).toBe(900);
    expect(rows[2]).toEqual({ route: 'GET /health', n: 0, p50: null, p95: null, max: null });
  });
});

describe('dailySeries', () => {
  const NOW = Date.parse('2026-07-27T18:30:00.000Z');
  const DAY = 86_400_000;

  it('zero-fills so a quiet day is visible rather than missing', () => {
    const series = dailySeries([new Date(NOW), new Date(NOW - 2 * DAY), new Date(NOW - 2 * DAY)], 14, NOW);
    expect(series).toHaveLength(14);
    expect(series[13]!.n).toBe(1); // today
    expect(series[12]!.n).toBe(0); // yesterday, genuinely quiet
    expect(series[11]!.n).toBe(2);
    expect(series.reduce((sum, p) => sum + p.n, 0)).toBe(3);
  });

  it('drops anything older than the window instead of piling it on the first day', () => {
    const series = dailySeries([new Date(NOW - 40 * DAY)], 14, NOW);
    expect(series.every((p) => p.n === 0)).toBe(true);
  });
});
