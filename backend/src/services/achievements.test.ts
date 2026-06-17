// Achievement metric tests. evaluateMetrics is pure over (stats, plays), so the whole
// catalog's conditions verify here without a DB. Factories build full Play/UserStats rows
// with sensible defaults; each test overrides only what it asserts on.

import { describe, expect, it } from 'bun:test';

import { evaluateMetrics } from './achievements.ts';
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
    txMint: null,
    txRedeem: null,
    rngSeed: null,
    openedAt: null,
    settledAt: new Date(seq * 1000),
    createdAt: new Date(0),
    ...p,
  } as Play;
};

describe('evaluateMetrics', () => {
  it('reads the stat-derived metrics straight off UserStats', () => {
    const m = evaluateMetrics(stats({ gamesPlayed: 7, wins: 4, maxStreak: 6, totalVolume: D(1840) }), []);
    expect(m.games_played).toBe(7);
    expect(m.wins).toBe(4);
    expect(m.win_streak).toBe(6);
    expect(m.volume).toBe(1840);
  });

  it('counts distinct games only among settled plays', () => {
    const plays = [
      play({ game: 'lucky', status: 'won' }),
      play({ game: 'range', status: 'lost', payout: 0n, pnl: D(-10) }),
      play({ game: 'tap', status: 'cashed_out' }),
      play({ game: 'lucky', status: 'open', payout: null, pnl: null }), // not settled, ignored
    ];
    expect(evaluateMetrics(stats(), plays).distinct_games).toBe(3);
  });

  it('counts only winning cash-outs', () => {
    const plays = [
      play({ status: 'cashed_out', pnl: D(5) }),
      play({ status: 'cashed_out', pnl: D(3) }),
      play({ status: 'cashed_out', pnl: D(-2) }), // cashed below entry, not a winning cash-out
      play({ status: 'won', pnl: D(40) }), // a win, but not a cash-out
    ];
    expect(evaluateMetrics(stats(), plays).cashouts).toBe(2);
  });

  it('tracks the best realized multiple on a winning play', () => {
    const plays = [
      play({ status: 'won', entryCost: D(10), payout: D(20) }), // 2x
      play({ status: 'cashed_out', entryCost: D(4), payout: D(100), pnl: D(96) }), // 25x
      play({ status: 'lost', entryCost: D(50), payout: 0n, pnl: D(-50) }), // ignored
    ];
    expect(evaluateMetrics(stats(), plays).big_multiplier).toBe(25);
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
    expect(m.distinct_games).toBe(0);
    expect(m.cashouts).toBe(0);
    expect(m.big_multiplier).toBe(0);
    expect(m.comeback).toBe(0);
  });
});
