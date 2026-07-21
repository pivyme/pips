import { describe, expect, it } from 'bun:test';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { buildLogPlayForPackage } from './logger.ts';

const PACKAGE = '0xabc';
const ATTRIBUTION = {
  player: '0xa11ce',
  game: 'range',
  playId: 'play_enabled',
  market: '0xb0b',
  referrerId: 'opaque-referrer-token',
};

const moveCalls = (tx: Transaction) => tx.getData().commands.filter((command) => command.$kind === 'MoveCall');

describe('PIPS logger command composition', () => {
  it('adds one exact record call with five ordered pure arguments', () => {
    const tx = new Transaction();
    buildLogPlayForPackage(tx, PACKAGE, ATTRIBUTION);
    const command = moveCalls(tx)[0]!;
    expect(command.MoveCall.package).toBe(normalizeSuiAddress(PACKAGE));
    expect(command.MoveCall.module).toBe('activity');
    expect(command.MoveCall.function).toBe('record');
    expect(command.MoveCall.arguments).toHaveLength(5);
    expect(tx.getData().inputs).toHaveLength(5);
  });

  it('appends from the actual buildMintPlay seam after mint and before first-wrapper share', () => {
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        '--eval',
        `import { Transaction } from '@mysten/sui/transactions';
         import { buildMintPlay } from './src/lib/sui/predict-real.ts';
         const params = { marketId: '0x1', wrapperId: '0x2', wrapperExists: false, depositRaw: 0n, amountRaw: 1000000n, minQuantityRaw: 10000n, leverage1e9: 1000000000n, lowerTick: 1n, higherTick: 2n, rakeRaw: 0n };
         const baseline = new Transaction(); buildMintPlay(baseline, params);
         const tagged = new Transaction(); buildMintPlay(tagged, { ...params, attribution: ${JSON.stringify(ATTRIBUTION)} });
         console.log(JSON.stringify({ baseline: baseline.getData(), tagged: tagged.getData() }, (_key, value) => typeof value === 'bigint' ? value.toString() : value));`,
      ],
      cwd: process.cwd(),
      env: { ...process.env, PIPS_LOGGER_PACKAGE_ID: PACKAGE },
    });
    expect(child.exitCode).toBe(0);
    const built = JSON.parse(new TextDecoder().decode(child.stdout)) as { baseline: ReturnType<Transaction['getData']>; tagged: ReturnType<Transaction['getData']> };
    expect(built.tagged.commands).toHaveLength(built.baseline.commands.length + 1);
    const commands = built.tagged.commands;
    const loggerIndex = commands.findIndex((command) => command.$kind === 'MoveCall' && command.MoveCall.module === 'activity' && command.MoveCall.function === 'record');
    const mintIndex = commands.findIndex((command) => command.$kind === 'MoveCall' && command.MoveCall.function === 'mint_exact_amount');
    const shareIndex = commands.findIndex((command) => command.$kind === 'MoveCall' && command.MoveCall.module === 'account' && command.MoveCall.function === 'share');
    expect(loggerIndex).toBeGreaterThan(mintIndex);
    expect(loggerIndex).toBeLessThan(shareIndex);
    const call = commands[loggerIndex]!.MoveCall;
    expect(`${call.package}::${call.module}::${call.function}`).toBe(`${normalizeSuiAddress(PACKAGE)}::activity::record`);
  });
});
