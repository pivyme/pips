import { describe, expect, it } from 'bun:test';

import type { Play } from '../../prisma/generated/client.js';
import { computeLedgerStats } from './stats.ts';

const D = (value: number): bigint => BigInt(Math.round(value * 1e6));

const play = (id: string, values: Partial<Play>): Play =>
  ({
    id,
    userId: 'user',
    game: 'lucky',
    status: 'won',
    asset: 'BTC',
    oracleId: '0xoracle',
    marketKey: '{}',
    side: 'up',
    leverage: 2,
    strike: '100',
    lower: null,
    upper: null,
    widthPct: null,
    durationSec: 30,
    expiry: 0n,
    stake: D(100),
    entryCost: D(98.562719),
    markValue: D(200),
    payout: D(200),
    pnl: D(101.437281),
    multiplier: 2.029165,
    entrySpot: '99',
    settlePrice: '101',
    txMint: 'mint',
    txRedeem: 'redeem',
    txSettle: 'settle',
    rngSeed: null,
    openedAt: new Date(1000),
    settledAt: new Date(2000),
    createdAt: new Date(0),
    ...values,
  }) as Play;

describe('computeLedgerStats accounting', () => {
  it('sums exact realized PnL and actual mint cost, not requested stake', async () => {
    const plays = [
      play('win', {}),
      play('loss', {
        status: 'lost',
        stake: D(50),
        entryCost: D(49.125001),
        payout: 0n,
        markValue: 0n,
        pnl: D(-49.125001),
        settledAt: new Date(3000),
      }),
    ];

    const result = await computeLedgerStats('user', plays);

    expect(result.netPnl).toBe(D(52.31228));
    expect(result.totalVolume).toBe(D(147.68772));
    expect(result.gamesPlayed).toBe(2);
    expect(result.wins).toBe(1);
    expect(result.losses).toBe(1);
    // Best realized multiple = payout / entryCost on the winning play; the loss never counts.
    expect(result.bestMultiplier).toBeCloseTo(200 / 98.562719, 4);
  });
});
