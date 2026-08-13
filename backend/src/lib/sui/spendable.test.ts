// resolveSpendable: the balance policy behind /auth/me, the one thing on that route that can fail on a
// perfectly healthy account.
//
// The fullnode rate-limits us under load, and a throwing balance read used to 500 the whole route
// ("Could not load profile", 1.5k occurrences across 58 users). What has to hold now: a transient failure
// serves the last known number, a wrapper that is genuinely gone still reads as 0, and neither path is
// ever allowed to invent a balance out of nothing.
//
// Pure, so this touches no chain and mocks no modules. Deliberate: bun's mock.module is global to the run,
// so a suite that mocks the chain readers would otherwise decide this file's result by load order.

import { describe, expect, it, spyOn } from 'bun:test';

import { resolveSpendable, resolveSpendableSoft } from './spendable.ts';

const ok = (raw: bigint): PromiseSettledResult<bigint> => ({ status: 'fulfilled', value: raw });
const bad = (message: string): PromiseSettledResult<bigint> => ({ status: 'rejected', reason: new Error(message) });

// The 429 the fullnode actually answers with, as grpc-web surfaces it.
const RATE_LIMITED = 'Too Many Requests';
// A vanished object, captured verbatim off testnet gRPC rather than written from memory (L-028):
// getObject on an unknown id answers exactly this.
const NOT_FOUND = 'Object 0xabababababababababababababababababababababababababababababababab not found';

describe('resolveSpendable', () => {
  it('sums the wallet and the wrapper when both reads land', () => {
    expect(resolveSpendable('0xsum', ok(4_000_000n), ok(1_500_000n))).toBe(5_500_000n);
  });

  it('serves the last known total when the fullnode rate-limits us, instead of throwing', () => {
    expect(resolveSpendable('0xthrottled', ok(7_250_000n), ok(0n))).toBe(7_250_000n);
    expect(resolveSpendable('0xthrottled', bad(RATE_LIMITED), ok(0n))).toBe(7_250_000n);
  });

  it('never reports 0 when only the wrapper read is rate-limited', () => {
    expect(resolveSpendable('0xchips', ok(2_000_000n), ok(3_000_000n))).toBe(5_000_000n);
    // The old code caught every wrapper error to 0n, which read to the user as "your chips are gone".
    expect(resolveSpendable('0xchips', ok(2_000_000n), bad(RATE_LIMITED))).toBe(5_000_000n);
  });

  it('still treats a genuinely missing wrapper as 0 chips', () => {
    expect(resolveSpendable('0xno-wrapper', ok(6_000_000n), bad(NOT_FOUND))).toBe(6_000_000n);
  });

  it('throws rather than invent a balance it has never successfully read', () => {
    expect(() => resolveSpendable('0xcold', bad(RATE_LIMITED), ok(0n))).toThrow(RATE_LIMITED);
  });

  it('keeps each address on its own last-known figure', () => {
    expect(resolveSpendable('0xalice', ok(1_000_000n), ok(0n))).toBe(1_000_000n);
    expect(() => resolveSpendable('0xbob', bad(RATE_LIMITED), ok(0n))).toThrow(RATE_LIMITED);
  });

  it('stops serving a stale balance once it ages out', () => {
    expect(resolveSpendable('0xstale', ok(9_000_000n), ok(0n))).toBe(9_000_000n);

    const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 120_001);
    try {
      expect(() => resolveSpendable('0xstale', bad(RATE_LIMITED), ok(0n))).toThrow(RATE_LIMITED);
    } finally {
      clock.mockRestore();
    }
  });
});

// The sign-in variant. A 429 on the balance read used to answer AUTH_VERIFY_FAILED and lock the user out of
// an account that was fine, so this path has to survive every failure the strict one throws on.
describe('resolveSpendableSoft', () => {
  it('reads the same as the strict policy when the chain answers', () => {
    expect(resolveSpendableSoft('0xsoft-ok', ok(3_000_000n), ok(500_000n))).toBe(3_500_000n);
  });

  it('answers 0 rather than throw for an account it has never read', () => {
    expect(resolveSpendableSoft('0xsoft-cold', bad(RATE_LIMITED), bad(RATE_LIMITED))).toBe(0n);
  });

  it('serves the last known total even once it is past the freshness bound', () => {
    expect(resolveSpendableSoft('0xsoft-stale', ok(8_000_000n), ok(0n))).toBe(8_000_000n);

    const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 120_001);
    try {
      expect(resolveSpendableSoft('0xsoft-stale', bad(RATE_LIMITED), ok(0n))).toBe(8_000_000n);
    } finally {
      clock.mockRestore();
    }
  });
});
