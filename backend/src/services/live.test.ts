// The live panel merges two sources that disagree by design: an in-memory presence set and a database
// tail over a selectable window. These cover the merge, the money unit, the cap, and the two facts that
// must not be window-gated: what someone is doing now, and what device they are on.

import { describe, expect, test } from 'bun:test';

import {
  assembleRows,
  bucketMsFor,
  describeActivity,
  fillBuckets,
  normalizeWindowMin,
  type AssembleInput,
} from './live.ts';

const NOW = Date.parse('2026-08-09T12:00:00.000Z');
const MIN = 60_000;

const user = (id: string): { id: string; username: string; displayName: string; avatarUrl: null; address: string } => ({
  id,
  username: `user_${id}`,
  displayName: `User ${id}`,
  avatarUrl: null,
  address: `0x${id}`,
});

const play = (
  userId: string,
  at: number,
  over: Partial<{ plays: number; status: string; entryCost: bigint; pnl: bigint }> = {},
) => ({
  userId,
  status: over.status ?? 'won',
  plays: over.plays ?? 1,
  entryCost: over.entryCost ?? 1_000_000n,
  pnl: over.pnl ?? 500_000n,
  lastAt: at,
});

const base = (over: Partial<AssembleInput> = {}): AssembleInput => ({
  presence: [],
  users: [],
  plays: [],
  openPlays: [],
  events: [],
  now: NOW,
  ...over,
});

describe('windows', () => {
  test('only an offered window is honoured; anything else reads as the default day', () => {
    expect(normalizeWindowMin('30')).toBe(30);
    expect(normalizeWindowMin(10_080)).toBe(10_080);
    expect(normalizeWindowMin('45')).toBe(1440);
    expect(normalizeWindowMin(undefined)).toBe(1440);
    expect(normalizeWindowMin('drop table')).toBe(1440);
  });

  test('every window lands between 30 and 170 bars, so no range draws a thousand', () => {
    for (const w of [30, 60, 1440, 10_080]) {
      const bars = (w * MIN) / bucketMsFor(w);
      expect(bars).toBeGreaterThanOrEqual(30);
      expect(bars).toBeLessThanOrEqual(170);
    }
  });
});

describe('fillBuckets', () => {
  test('zero-fills every bucket, so a quiet minute reads as 0 rather than as missing', () => {
    const out = fillBuckets([{ t: NOW - 3 * MIN, n: 1 }], NOW, 30 * MIN, MIN);
    expect(out).toHaveLength(30);
    expect(out.reduce((a, b) => a + b.n, 0)).toBe(1);
    expect(out.filter((b) => b.n === 0)).toHaveLength(29);
  });

  test('buckets align to the bucket width and end on the current one', () => {
    const out = fillBuckets([], Date.parse('2026-08-09T12:07:42.500Z'), 24 * 60 * MIN, 15 * MIN);
    expect(out).toHaveLength(96);
    expect(new Date(out[out.length - 1]!.t).toISOString()).toBe('2026-08-09T12:00:00.000Z');
  });

  test('drops anything outside the window instead of piling it into the edge bucket', () => {
    const out = fillBuckets(
      [
        { t: NOW - 90 * MIN, n: 4 },
        { t: NOW + 5 * MIN, n: 2 },
      ],
      NOW,
      30 * MIN,
      MIN,
    );
    expect(out.reduce((a, b) => a + b.n, 0)).toBe(0);
  });
});

describe('describeActivity', () => {
  test('names the game a play event carries', () => {
    expect(describeActivity('game.play_tap', { game: 'range' })).toBe('RANGE');
  });

  test('falls back when props carry no game', () => {
    expect(describeActivity('game.open', {})).toBe('PLAYING');
    expect(describeActivity('game.open', null)).toBe('PLAYING');
  });

  test('reads the menu section', () => {
    expect(describeActivity('menu.section', { section: 'history' })).toBe('MENU · HISTORY');
    expect(describeActivity('menu.section', {})).toBe('MENU');
  });

  test('an unmapped name degrades to its namespace rather than blank', () => {
    expect(describeActivity('money.withdraw_open', {})).toBe('MONEY');
    expect(describeActivity('social.share_card', {})).toBe('SOCIAL');
  });
});

describe('assembleRows', () => {
  test('a live user with no plays still gets a row', () => {
    const { rows } = assembleRows(
      base({ presence: [{ userId: 'a', sessions: 1, since: NOW - 5 * MIN, platform: null }], users: [user('a')] }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'a', live: true, sessions: 1, plays: 0, staked: 0, pnl: 0, doing: 'IDLE' });
    expect(rows[0]!.lastSeenAt).toBe(NOW);
    expect(rows[0]!.lastActiveAt).toBeNull();
  });

  test('a recent player with no presence is merged in as not-live, dated by their last play', () => {
    const at = NOW - 8 * MIN;
    const { rows } = assembleRows(base({ users: [user('b')], plays: [play('b', at)] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'b', live: false, sessions: 0, since: null, plays: 1 });
    expect(rows[0]!.lastSeenAt).toBe(at);
    expect(rows[0]!.lastActiveAt).toBe(at);
  });

  test('live sorts above recent, and recent sorts by last seen', () => {
    const input = base({
      presence: [{ userId: 'live', sessions: 2, since: NOW - MIN, platform: null }],
      users: [user('live'), user('old'), user('new')],
      plays: [play('old', NOW - 20 * MIN), play('new', NOW - 2 * MIN)],
    });
    expect(assembleRows(input).rows.map((r) => r.id)).toEqual(['live', 'new', 'old']);
  });

  test('staked is DUSDC 6dp over every play, pnl only over settled ones', () => {
    const { rows } = assembleRows(
      base({
        users: [user('c')],
        plays: [
          play('c', NOW - MIN, { entryCost: 2_500_000n, pnl: 1_000_000n, status: 'won' }),
          play('c', NOW - 2 * MIN, { entryCost: 1_000_000n, pnl: -1_000_000n, status: 'lost' }),
          // Pending: it cost nothing yet and has no realized PnL, so it must move neither number.
          play('c', NOW - 3 * MIN, { entryCost: 0n, pnl: 0n, status: 'pending' }),
        ],
      }),
    );
    expect(rows[0]).toMatchObject({ plays: 3, staked: 3.5, pnl: 0 });
  });

  test('an open play outranks the last event for what they are doing', () => {
    const { rows } = assembleRows(
      base({
        presence: [{ userId: 'd', sessions: 1, since: NOW - MIN, platform: 'desktop' }],
        users: [user('d')],
        openPlays: [{ userId: 'd', game: 'moonshot', expiry: BigInt(NOW + 30_000) }],
        events: [{ userId: 'd', name: 'hub.view', props: {}, ts: new Date(NOW - MIN), platform: 'ios' }],
      }),
    );
    expect(rows[0]!.doing).toBe('IN PLAY · MOONSHOT');
    expect(rows[0]!.platform).toBe('ios');
  });

  test('an event older than the activity TTL names the device but is not what they are doing', () => {
    const at = NOW - 3 * 60 * MIN;
    const { rows } = assembleRows(
      base({
        presence: [{ userId: 'e', sessions: 1, since: NOW - 3 * 60 * MIN, platform: null }],
        users: [user('e')],
        events: [{ userId: 'e', name: 'game.play_tap', props: { game: 'range' }, ts: new Date(at), platform: 'pwa' }],
      }),
    );
    expect(rows[0]!.doing).toBe('IDLE');
    expect(rows[0]!.platform).toBe('pwa');
    expect(rows[0]!.lastActiveAt).toBe(at);
  });

  test('a live session names the device even when the player has no events at all', () => {
    const { rows } = assembleRows(
      base({ presence: [{ userId: 'f', sessions: 1, since: NOW - MIN, platform: 'desktop' }], users: [user('f')] }),
    );
    expect(rows[0]!.platform).toBe('desktop');
  });

  test('a second tab bumps sessions without resetting the arrival time', () => {
    const since = NOW - 42 * MIN;
    const { rows } = assembleRows(base({ presence: [{ userId: 'g', sessions: 3, since, platform: null }], users: [user('g')] }));
    expect(rows[0]).toMatchObject({ sessions: 3, since });
  });

  test('a presence entry whose user row is gone is skipped, not rendered blank', () => {
    const { rows } = assembleRows(base({ presence: [{ userId: 'ghost', sessions: 1, since: NOW, platform: null }], users: [] }));
    expect(rows).toHaveLength(0);
  });

  test('caps at 100 rows and reports the remainder rather than truncating silently', () => {
    const ids = Array.from({ length: 130 }, (_, i) => `u${String(i).padStart(3, '0')}`);
    const { rows, truncated } = assembleRows(
      base({
        users: ids.map(user),
        plays: ids.map((id, i) => play(id, NOW - i * 10_000)),
      }),
    );
    expect(rows).toHaveLength(100);
    expect(truncated).toBe(30);
  });
});
