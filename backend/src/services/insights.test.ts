// Insights math (Addendum A6 item 10). This is the test everybody skips, and it is exactly how a dashboard
// ends up confidently wrong: a funnel that double-counts or a cohort that misses the anonId stitch looks
// completely healthy from the outside.
//
// Every expected number below was computed by hand from the fixture, not read off a run.

import { describe, expect, it } from 'bun:test';

import { computeCohorts, computeFunnel, computeGameConversion, computeMenuSections } from './insights.ts';

// Six visitors on the pre-auth funnel. `a_N` is the client anonId, which is the same before and after login.
//
//   a_1  landed, gated, START, signed in as u_1, onboarded, played   -> reaches all 6 steps
//   a_2  landed, gated, START, signed in as u_2, onboarded, no play  -> drops at step 6
//   a_3  landed, gated, START, signed in as u_3, never onboarded     -> drops at step 5
//   a_4  landed, gated, START, never signed in                       -> drops at step 4
//   a_5  landed, gated, never tapped START                           -> drops at step 3
//   a_6  landed only                                                 -> drops at step 2
//
// Hand-computed: 6 -> 5 -> 4 -> 3 -> 2 -> 1, so drop-offs are 0, 16.7, 20, 25, 33.3, 50.
const FUNNEL_FIXTURE = [
  ...['a_1', 'a_2', 'a_3', 'a_4', 'a_5', 'a_6'].map((anonId) => ({ name: 'door.landing_view', anonId, userId: null })),
  ...['a_1', 'a_2', 'a_3', 'a_4', 'a_5'].map((anonId) => ({ name: 'door.gate_pass', anonId, userId: null })),
  ...['a_1', 'a_2', 'a_3', 'a_4'].map((anonId) => ({ name: 'door.start_tap', anonId, userId: null })),
  { name: 'door.auth_ok', anonId: 'a_1', userId: 'u_1' },
  { name: 'door.auth_ok', anonId: 'a_2', userId: 'u_2' },
  { name: 'door.auth_ok', anonId: 'a_3', userId: 'u_3' },
  { name: 'door.onboard_done', anonId: 'a_1', userId: 'u_1' },
  { name: 'door.onboard_done', anonId: 'a_2', userId: 'u_2' },
];

describe('computeFunnel', () => {
  it('counts each step and its drop-off exactly, stitching the play step across login by anonId', () => {
    const rows = computeFunnel(FUNNEL_FIXTURE, ['u_1']);

    expect(rows.map((r) => r.subjects)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(rows.map((r) => r.dropPct)).toEqual([0, 16.7, 20, 25, 33.3, 50]);
    expect(rows.map((r) => r.skipped)).toEqual([false, false, false, false, false, false]);
    expect(rows.map((r) => r.key)).toEqual(['landing', 'gate', 'start', 'auth', 'onboard', 'play']);
  });

  it('does not credit a play to the funnel unless that user cleared the earlier steps', () => {
    // u_3 played but never onboarded, so the last step must still be 0 rather than borrowing u_3.
    const rows = computeFunnel(FUNNEL_FIXTURE, ['u_3']);
    expect(rows[4]!.subjects).toBe(2); // onboarded: a_1, a_2
    expect(rows[5]!.subjects).toBe(0);
    expect(rows[5]!.dropPct).toBe(100);
  });

  it('counts a play whose user never sent an event, keyed by userId rather than dropped', () => {
    // A user with no anonId on record still has to appear somewhere, or the play step silently undercounts.
    const rows = computeFunnel([{ name: 'door.landing_view', anonId: null, userId: 'u_9' }], ['u_9']);
    expect(rows[0]!.subjects).toBe(1);
    expect(rows[5]!.subjects).toBe(1);
  });

  it('treats a step nobody reached as pass-through, not a 100% cliff', () => {
    // The access gate is off in most deployments, so door.gate_pass never fires. Reporting a cliff there
    // would be a confident lie about where users leave.
    const noGate = FUNNEL_FIXTURE.filter((e) => e.name !== 'door.gate_pass');
    const rows = computeFunnel(noGate, ['u_1']);

    expect(rows[1]!.skipped).toBe(true);
    expect(rows[1]!.dropPct).toBe(0);
    // The cohort carries through the skipped step untouched: 6 landed, 4 tapped START.
    expect(rows[1]!.subjects).toBe(6);
    expect(rows[2]!.subjects).toBe(4);
    expect(rows[2]!.dropPct).toBe(33.3);
  });

  it('never produces a negative drop-off when a later step is observed more than an earlier one', () => {
    // Someone who arrives already signed in fires auth_ok with no landing_view. Per-step totals would give
    // auth_ok 3 against landing 1 and a negative drop; the subset rule cannot.
    const rows = computeFunnel(
      [
        { name: 'door.landing_view', anonId: 'a_1', userId: null },
        { name: 'door.auth_ok', anonId: 'a_1', userId: 'u_1' },
        { name: 'door.auth_ok', anonId: 'a_7', userId: 'u_7' },
        { name: 'door.auth_ok', anonId: 'a_8', userId: 'u_8' },
      ],
      [],
    );
    for (const row of rows) expect(row.dropPct).toBeGreaterThanOrEqual(0);
    expect(rows[3]!.subjects).toBe(1);
  });

  it('returns zeroed steps for an empty window instead of dividing by zero', () => {
    const rows = computeFunnel([], []);
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.subjects).toBe(0);
      expect(row.dropPct).toBe(0);
      expect(Number.isFinite(row.dropPct)).toBe(true);
    }
  });
});

describe('computeGameConversion', () => {
  it('divides play taps by opens per game, and keeps a game with opens and no plays visible', () => {
    // lucky: 4 opens, 3 plays = 75%. range: 2 opens, 1 play = 50%. moonshot: 2 opens, 0 plays = 0%.
    const events = [
      ...Array.from({ length: 4 }, () => ({ name: 'game.open', props: { game: 'lucky' } })),
      ...Array.from({ length: 3 }, () => ({ name: 'game.play_tap', props: { game: 'lucky' } })),
      ...Array.from({ length: 2 }, () => ({ name: 'game.open', props: { game: 'range' } })),
      { name: 'game.play_tap', props: { game: 'range' } },
      ...Array.from({ length: 2 }, () => ({ name: 'game.open', props: { game: 'moonshot' } })),
    ];

    expect(computeGameConversion(events)).toEqual([
      { game: 'lucky', opens: 4, plays: 3, conversionPct: 75 },
      { game: 'range', opens: 2, plays: 1, conversionPct: 50 },
      { game: 'moonshot', opens: 2, plays: 0, conversionPct: 0 },
    ]);
  });

  it('lists every trading game even with no events at all, so an unused game is visible rather than absent', () => {
    const rows = computeGameConversion([]);
    expect(rows.map((r) => r.game).sort()).toEqual(['lucky', 'moonshot', 'range']);
    for (const row of rows) expect(row.conversionPct).toBe(0);
  });

  it('ignores an event with no game prop instead of counting it under undefined', () => {
    const rows = computeGameConversion([{ name: 'game.open', props: null }, { name: 'game.open', props: { game: 'lucky' } }]);
    expect(rows.find((r) => r.game === 'lucky')!.opens).toBe(1);
    expect(rows.some((r) => !r.game)).toBe(false);
  });
});

describe('computeMenuSections', () => {
  it('ranks sections by opens, descending, with ties broken by name', () => {
    const events = [
      ...Array.from({ length: 3 }, () => ({ name: 'menu.section', props: { section: 'history' } })),
      ...Array.from({ length: 2 }, () => ({ name: 'menu.section', props: { section: 'settings' } })),
      { name: 'menu.section', props: { section: 'about' } },
      { name: 'menu.section', props: { section: 'referrals' } },
    ];
    expect(computeMenuSections(events)).toEqual([
      { section: 'history', count: 3 },
      { section: 'settings', count: 2 },
      { section: 'about', count: 1 },
      { section: 'referrals', count: 1 },
    ]);
  });
});

describe('computeCohorts', () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const at = (iso: string) => new Date(iso);

  it('counts D1 and D7 from the start of the signup day, per cohort', () => {
    // 2026-07-01 cohort: u_1, u_2, u_3.
    //   u_1 active on the 2nd (D1) and the 8th (D7)  -> both
    //   u_2 active on the 2nd only                    -> D1 only
    //   u_3 active on the 1st only                    -> neither, same-day activity is not retention
    // 2026-07-02 cohort: u_4, active on the 3rd -> D1 1/1, D7 0/1.
    const users = [
      { id: 'u_1', createdAt: at('2026-07-01T09:30:00Z') },
      { id: 'u_2', createdAt: at('2026-07-01T22:10:00Z') },
      { id: 'u_3', createdAt: at('2026-07-01T11:00:00Z') },
      { id: 'u_4', createdAt: at('2026-07-02T08:00:00Z') },
    ];
    const activity = [
      { userId: 'u_1', ts: at('2026-07-02T10:00:00Z') },
      { userId: 'u_1', ts: at('2026-07-08T04:00:00Z') },
      { userId: 'u_2', ts: at('2026-07-02T23:59:00Z') },
      { userId: 'u_3', ts: at('2026-07-01T12:00:00Z') },
      { userId: 'u_4', ts: at('2026-07-03T08:00:00Z') },
    ];

    expect(computeCohorts(users, activity)).toEqual([
      { date: '2026-07-01', signups: 3, d1: 2, d7: 1, d1Pct: 66.7, d7Pct: 33.3 },
      { date: '2026-07-02', signups: 1, d1: 1, d7: 0, d1Pct: 100, d7Pct: 0 },
    ]);
  });

  it('excludes activity one second outside the window, in both directions', () => {
    const users = [{ id: 'u_1', createdAt: at('2026-07-01T12:00:00Z') }];
    const cohortDay = day('2026-07-01').getTime();

    // The D1 window is exactly [start + 24h, start + 48h).
    const justBefore = new Date(cohortDay + 86_400_000 - 1);
    const firstMoment = new Date(cohortDay + 86_400_000);
    const justAfter = new Date(cohortDay + 2 * 86_400_000);

    expect(computeCohorts(users, [{ userId: 'u_1', ts: justBefore }])[0]!.d1).toBe(0);
    expect(computeCohorts(users, [{ userId: 'u_1', ts: firstMoment }])[0]!.d1).toBe(1);
    expect(computeCohorts(users, [{ userId: 'u_1', ts: justAfter }])[0]!.d1).toBe(0);
  });

  it('ignores anonymous activity, which has no user to retain', () => {
    const users = [{ id: 'u_1', createdAt: at('2026-07-01T12:00:00Z') }];
    const rows = computeCohorts(users, [{ userId: null, ts: at('2026-07-02T12:00:00Z') }]);
    expect(rows[0]).toEqual({ date: '2026-07-01', signups: 1, d1: 0, d7: 0, d1Pct: 0, d7Pct: 0 });
  });

  it('returns nothing for no signups rather than a row of NaN percentages', () => {
    expect(computeCohorts([], [{ userId: 'u_1', ts: at('2026-07-02T12:00:00Z') }])).toEqual([]);
  });
});
