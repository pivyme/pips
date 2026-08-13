// The balance policy behind /auth/me, the one thing on that route that can fail on a perfectly healthy
// account.
//
// The fullnode rate-limits us under load, and a throwing balance read used to 500 the whole route
// ("Could not load profile", 1.5k occurrences across 58 users). Failing soft then swung it the other way:
// a throttled read painted a confident $0 on funded accounts. What has to hold now: a transient failure
// serves the last known number and says it is stale, a wrapper that is genuinely gone still reads as 0,
// nothing invents a balance out of nothing, and repeat polls inside the window do not touch the chain.
//
// The chain reads are injected, so this touches no chain and mocks no modules. Deliberate: bun's
// mock.module is global to the run, so a suite that mocks the chain readers would otherwise decide this
// file's result by load order.

import { describe, expect, it, spyOn } from 'bun:test';

import { invalidateSpendable, readSpendable, resolveSpendable } from './spendable.ts';

const ok = (raw: bigint): PromiseSettledResult<bigint> => ({ status: 'fulfilled', value: raw });
const bad = (message: string): PromiseSettledResult<bigint> => ({ status: 'rejected', reason: new Error(message) });

// The 429 the fullnode actually answers with, as grpc-web surfaces it.
const RATE_LIMITED = 'Too Many Requests';
// A vanished object, captured verbatim off testnet gRPC rather than written from memory (L-028):
// getObject on an unknown id answers exactly this.
const NOT_FOUND = 'Object 0xabababababababababababababababababababababababababababababababab not found';

const fresh = (raw: bigint) => ({ raw, stale: false });
const stale = (raw: bigint) => ({ raw, stale: true });

describe('resolveSpendable', () => {
  it('sums the wallet and the wrapper when both reads land', () => {
    expect(resolveSpendable('sum', ok(4_000_000n), ok(1_500_000n))).toEqual(fresh(5_500_000n));
  });

  it('serves the last known total when the fullnode rate-limits us, flagged stale', () => {
    expect(resolveSpendable('throttled', ok(7_250_000n), ok(0n))).toEqual(fresh(7_250_000n));
    expect(resolveSpendable('throttled', bad(RATE_LIMITED), ok(0n))).toEqual(stale(7_250_000n));
  });

  it('never reports 0 when only the wrapper read is rate-limited', () => {
    expect(resolveSpendable('chips', ok(2_000_000n), ok(3_000_000n))).toEqual(fresh(5_000_000n));
    // The old code caught every wrapper error to 0n, which read to the user as "your chips are gone".
    expect(resolveSpendable('chips', ok(2_000_000n), bad(RATE_LIMITED))).toEqual(stale(5_000_000n));
  });

  it('still treats a genuinely missing wrapper as 0 chips, and as a fresh read', () => {
    expect(resolveSpendable('no-wrapper', ok(6_000_000n), bad(NOT_FOUND))).toEqual(fresh(6_000_000n));
  });

  it('answers null rather than invent a balance it has never successfully read', () => {
    expect(resolveSpendable('cold', bad(RATE_LIMITED), ok(0n))).toBeNull();
  });

  it('keeps each user on their own last-known figure', () => {
    expect(resolveSpendable('alice', ok(1_000_000n), ok(0n))).toEqual(fresh(1_000_000n));
    expect(resolveSpendable('bob', bad(RATE_LIMITED), ok(0n))).toBeNull();
  });

  it('stops serving a stale balance once it ages out', () => {
    expect(resolveSpendable('aging', ok(9_000_000n), ok(0n))).toEqual(fresh(9_000_000n));

    const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 120_001);
    try {
      expect(resolveSpendable('aging', bad(RATE_LIMITED), ok(0n))).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });
});

describe('readSpendable', () => {
  const readers = (walletRaw: bigint, chipsRaw: bigint) => {
    const calls = { wallet: 0, manager: 0 };
    return {
      calls,
      wallet: async () => {
        calls.wallet++;
        return walletRaw;
      },
      manager: async () => {
        calls.manager++;
        return chipsRaw;
      },
    };
  };

  it('reads the chain once, then serves the window from memory', async () => {
    const r = readers(3_000_000n, 500_000n);
    expect(await readSpendable('cached', r.wallet, r.manager)).toEqual(fresh(3_500_000n));
    expect(await readSpendable('cached', r.wallet, r.manager)).toEqual(fresh(3_500_000n));
    expect(r.calls.wallet).toBe(1);
  });

  it('goes back to the chain once the user is invalidated', async () => {
    const r = readers(1_000_000n, 0n);
    await readSpendable('invalidated', r.wallet, r.manager);
    invalidateSpendable('invalidated');
    await readSpendable('invalidated', r.wallet, r.manager);
    expect(r.calls.wallet).toBe(2);
  });

  it('coalesces concurrent polls into one pair of reads', async () => {
    const r = readers(2_000_000n, 0n);
    const [a, b, c] = await Promise.all([
      readSpendable('concurrent', r.wallet, r.manager),
      readSpendable('concurrent', r.wallet, r.manager),
      readSpendable('concurrent', r.wallet, r.manager),
    ]);
    expect([a, b, c]).toEqual([fresh(2_000_000n), fresh(2_000_000n), fresh(2_000_000n)]);
    expect(r.calls.wallet).toBe(1);
    expect(r.calls.manager).toBe(1);
  });

  it('reports a throttled read as stale rather than as a $0 balance', async () => {
    const throttled = async (): Promise<bigint> => {
      throw new Error(RATE_LIMITED);
    };
    expect(await readSpendable('never-read', throttled, throttled)).toEqual(stale(0n));
  });

  it('holds the last known total through a throttled read', async () => {
    const r = readers(8_000_000n, 0n);
    await readSpendable('held', r.wallet, r.manager);
    invalidateSpendable('held'); // a play moved the chips, so the next call must re-read

    const throttled = async (): Promise<bigint> => {
      throw new Error(RATE_LIMITED);
    };
    // Invalidating forces the read but keeps the fallback: a slightly-behind number beats a made-up 0.
    expect(await readSpendable('held', throttled, throttled)).toEqual(stale(8_000_000n));
  });
});
