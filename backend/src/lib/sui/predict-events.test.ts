import { describe, expect, it } from 'bun:test';

import { mintEventAmounts, redeemEventAmounts, type TradeEvent } from './predict.ts';

const event = (name: string, parsedJson: Record<string, unknown>): TradeEvent => ({
  type: `0xabc::predict::${name}`,
  parsedJson,
});

describe('Predict accounting receipts', () => {
  it('reads the exact mint cost and quantity from a range receipt', () => {
    const receipt = mintEventAmounts(
      [
        event('RangeMinted', {
          cost: '98562719',
          quantity: '354859085',
          manager_id: '0xmanager',
          oracle_id: '0xoracle',
        }),
      ],
      'range',
    );

    expect(receipt).toEqual({
      cost: 98_562_719n,
      quantity: 354_859_085n,
      managerId: '0xmanager',
      oracleId: '0xoracle',
    });
  });

  it('reads the exact payout and settlement flag from a binary redeem receipt', () => {
    const receipt = redeemEventAmounts(
      [
        event('PositionRedeemed', {
          payout: '42000000',
          quantity: '50000000',
          manager_id: '0xmanager',
          oracle_id: '0xoracle',
          is_settled: false,
        }),
      ],
      'binary',
    );

    expect(receipt).toEqual({
      payout: 42_000_000n,
      quantity: 50_000_000n,
      managerId: '0xmanager',
      oracleId: '0xoracle',
      settled: false,
    });
  });

  it('fails closed when the expected receipt is absent', () => {
    expect(() => mintEventAmounts([], 'binary')).toThrow('Missing predict::PositionMinted event');
  });
});
