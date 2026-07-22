// Achievement metric tests. evaluateMetrics is pure over (stats, plays, tz), so the whole catalog's
// conditions verify here without a DB; factories build full Play/UserStats rows with sensible defaults, each test overrides only what it asserts on.

import { describe, expect, it } from 'bun:test';

import { ACHIEVEMENT_CATALOG, evaluateMetrics } from './achievements.ts';
import type { Play, UserStats } from '../../prisma/generated/client.js';

const D = (n: number): bigint => BigInt(Math.round(n * 1e6));

const stats = (p: Partial<UserStats> = {}): UserStats =>
  ({
    userId: 'u',
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    currentStreak: 0,
    maxStreak: 0,
    totalVolume: 0n,
    netPnl: 0n,
    firstPlayAt: null,
    lastPlayAt: null,
    favoriteGame: null,
    updatedAt: new Date(0),
    ...p,
  }) as UserStats;

let seq = 0;
const play = (p: Partial<Play> = {}): Play => {
  seq += 1;
  return {
    id: `p${seq}`,
    userId: 'u',
    game: 'lucky',
    status: 'won',
    asset: 'BTC',
    oracleId: '0x1',
    marketKey: '{}',
    side: 'up',
    leverage: 5,
    strike: '60000',
    lower: null,
    upper: null,
    widthPct: null,
    durationSec: 30,
    expiry: 0n,
    stake: D(10),
    entryCost: D(10),
    markValue: null,
    payout: D(20),
    pnl: D(10),
    multiplier: 2,
    settlePrice: null,
    txMint: null,
    txRedeem: null,
    rngSeed: null,
    openedAt: new Date(seq * 100_000),
    settledAt: new Date(seq * 100_000 + 30_000),
    createdAt: new Date(0),
    ...p,
  } as Play;
};

describe('evaluateMetrics', () => {
  it('reads the stat-derived metrics straight off UserStats', () => {
    const m = evaluateMetrics(stats({ gamesPlayed: 7, wins: 4, maxStreak: 6, totalVolume: D(184) }), []);
    expect(m.games_played).toBe(7);
    expect(m.wins).toBe(4);
    expect(m.win_streak).toBe(6);
    expect(m.volume).toBe(184);
  });

  it('counts distinct games only among settled plays', () => {
    const plays = [
      play({ game: 'lucky', status: 'won' }),
      play({ game: 'range', status: 'lost', payout: 0n, pnl: D(-10) }),
      play({ game: 'range', status: 'cashed_out' }),
      play({ game: 'lucky', status: 'open', payout: null, pnl: null }), // not settled, ignored
    ];
    expect(evaluateMetrics(stats(), plays).distinct_games).toBe(2);
  });

  it('counts expiry wins for calm_click, not cash-outs', () => {
    const plays = [
      play({ status: 'won' }),
      play({ status: 'won' }),
      play({ status: 'cashed_out', pnl: D(5) }), // a win, but cashed out early
      play({ status: 'lost', payout: 0n, pnl: D(-10) }),
    ];
    expect(evaluateMetrics(stats(), plays).settled_wins).toBe(2);
  });

  it('counts tiny stakes at $2 or less', () => {
    const plays = [play({ stake: D(1.5) }), play({ stake: D(2) }), play({ stake: D(2.5) })];
    expect(evaluateMetrics(stats(), plays).tiny_stake).toBe(2);
  });

  it('flags a fast cash-out only within 30s of opening', () => {
    const t0 = new Date(1_000_000);
    const fast = play({ status: 'cashed_out', openedAt: t0, settledAt: new Date(t0.getTime() + 20_000) });
    const slow = play({ status: 'cashed_out', openedAt: t0, settledAt: new Date(t0.getTime() + 45_000) });
    const settleNotCashout = play({ status: 'won', openedAt: t0, settledAt: new Date(t0.getTime() + 20_000) });
    expect(evaluateMetrics(stats(), [slow, settleNotCashout]).fast_cashout).toBe(0);
    expect(evaluateMetrics(stats(), [slow, fast]).fast_cashout).toBe(1);
  });

  it('flags a close call when the settle lands within 1bp of the deciding line', () => {
    const close = play({ status: 'lost', payout: 0n, pnl: D(-10), strike: '60000', settlePrice: '60003' }); // 0.5bp out
    const wide = play({ status: 'won', strike: '60000', settlePrice: '60100' }); // ~17bp
    const rangeClose = play({ game: 'range', strike: null, lower: '59000', upper: '60002', status: 'won', settlePrice: '60000' });
    const cashout = play({ status: 'cashed_out', strike: '60000', settlePrice: null }); // no settle price, never qualifies
    expect(evaluateMetrics(stats(), [wide, cashout]).close_call).toBe(0);
    expect(evaluateMetrics(stats(), [close]).close_call).toBe(1);
    expect(evaluateMetrics(stats(), [rangeClose]).close_call).toBe(1);
  });

  it('flags double play when two plays open within 10 minutes', () => {
    const spread = [play({ openedAt: new Date(0) }), play({ openedAt: new Date(20 * 60_000) })];
    expect(evaluateMetrics(stats(), spread).double_play).toBe(0);
    const backToBack = [play({ openedAt: new Date(0) }), play({ openedAt: new Date(5 * 60_000) })];
    expect(evaluateMetrics(stats(), backToBack).double_play).toBe(1);
  });

  it('localizes night/early plays with the tz offset', () => {
    // 15:00 UTC = 22:00 in UTC+7 (getTimezoneOffset -420).
    const p = [play({ openedAt: new Date(Date.UTC(2026, 0, 1, 15, 0)) })];
    expect(evaluateMetrics(stats(), p, 0).night_plays).toBe(0);
    expect(evaluateMetrics(stats(), p, -420).night_plays).toBe(1);
    // 01:00 UTC = 08:00 in UTC+7: early there, night at UTC.
    const e = [play({ openedAt: new Date(Date.UTC(2026, 0, 1, 1, 0)) })];
    expect(evaluateMetrics(stats(), e, -420).early_plays).toBe(1);
    expect(evaluateMetrics(stats(), e, 0).night_plays).toBe(1);
    expect(evaluateMetrics(stats(), e, 0).early_plays).toBe(0);
  });

  it('tracks plays-in-day and consecutive day streaks on local days', () => {
    const day = 86_400_000;
    const at = (d: number, h: number) => play({ openedAt: new Date(d * day + h * 3_600_000) });
    const plays = [at(10, 9), at(10, 10), at(10, 11), at(11, 9), at(13, 9)]; // 3 on day 10, then 11, gap, 13
    const m = evaluateMetrics(stats(), plays, 0);
    expect(m.plays_in_day).toBe(3);
    expect(m.day_streak).toBe(2);
  });

  it('flags a comeback only when a win follows a loss in settlement order', () => {
    const loseThenWin = [
      play({ status: 'lost', pnl: D(-10), payout: 0n, settledAt: new Date(1000) }),
      play({ status: 'won', pnl: D(30), settledAt: new Date(2000) }),
    ];
    expect(evaluateMetrics(stats(), loseThenWin).comeback).toBe(1);

    const winThenLose = [
      play({ status: 'won', pnl: D(30), settledAt: new Date(1000) }),
      play({ status: 'lost', pnl: D(-10), payout: 0n, settledAt: new Date(2000) }),
    ];
    expect(evaluateMetrics(stats(), winThenLose).comeback).toBe(0);
  });

  it('returns all-zero gameplay metrics with no plays', () => {
    const m = evaluateMetrics(stats(), []);
    for (const k of ['distinct_games', 'settled_wins', 'tiny_stake', 'close_call', 'fast_cashout', 'double_play', 'night_plays', 'early_plays', 'plays_in_day', 'day_streak', 'comeback']) {
      expect(m[k]).toBe(0);
    }
  });

  it('covers every catalog metric so no achievement can silently never unlock', () => {
    const m = evaluateMetrics(stats(), []);
    for (const a of ACHIEVEMENT_CATALOG) expect(m[a.metric]).toBeDefined();
  });
});
