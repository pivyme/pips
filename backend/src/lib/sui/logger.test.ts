import { describe, expect, it } from 'bun:test';
import { Transaction } from '@mysten/sui/transactions';

import { LOGGER_ENABLED, buildLogPlay, buildLogPlayForPackage } from './logger.ts';
import { buildMintPlay } from './predict-real.ts';

const ATTRIBUTION = {
  player: '0xa11ce',
  game: 'lucky',
  playId: 'play_test',
  market: '0xb0b',
};

describe('PIPS logger off-path', () => {
  // Driven with an explicit empty package id so the assertion holds whatever the local .env sets.
  it('appends no command for an empty package id', () => {
    const tx = new Transaction();
    const before = tx.getData().commands.length;
    buildLogPlayForPackage(tx, '', ATTRIBUTION);
    expect(tx.getData().commands.length).toBe(before);
  });

  it('keeps buildLogPlay in step with LOGGER_ENABLED', () => {
    const tx = new Transaction();
    const before = tx.getData().commands.length;
    buildLogPlay(tx, ATTRIBUTION);
    expect(tx.getData().commands.length).toBe(before + (LOGGER_ENABLED ? 1 : 0));
  });

  it('keeps a mint PTB byte-for-byte unchanged when no attribution is supplied', () => {
    const params = {
      marketId: '0x1',
      wrapperId: '0x2',
      wrapperExists: true,
      depositRaw: 0n,
      amountRaw: 1_000_000n,
      minQuantityRaw: 10_000n,
      leverage1e9: 1_000_000_000n,
      lowerTick: 1n,
      higherTick: 2n,
      rakeRaw: 0n,
    };
    const before = new Transaction();
    buildMintPlay(before, params);
    const after = new Transaction();
    buildMintPlay(after, { ...params, attribution: undefined });
    expect(after.getData()).toEqual(before.getData());
  });
});
