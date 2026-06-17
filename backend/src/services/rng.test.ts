// RNG fairness tests. Pure and chain-free: the draws are deterministic from a seed, so we
// assert reproducibility (audit), uniformity of the [0,1) stream, and that the weighted
// leverage picker matches its declared weights over a large sample.

import { describe, expect, it } from 'bun:test';

import { newSeed, seedFloat, pickWeighted, pickLeverage, BUCKET_WEIGHTS, LEVERAGE_BUCKETS } from './rng.ts';

describe('seedFloat', () => {
  it('is deterministic per (seed, index) for audit replay', () => {
    expect(seedFloat('abc', 0)).toBe(seedFloat('abc', 0));
    expect(seedFloat('abc', 0)).not.toBe(seedFloat('abc', 1));
    expect(seedFloat('abc', 0)).not.toBe(seedFloat('xyz', 0));
  });

  it('stays within [0,1)', () => {
    for (let i = 0; i < 1000; i++) {
      const v = seedFloat('seed', i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is roughly uniform (mean near 0.5 over a large sample)', () => {
    let sum = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) sum += seedFloat('uniform', i);
    expect(sum / n).toBeCloseTo(0.5, 1);
  });
});

describe('newSeed', () => {
  it('produces unique 32-hex-char seeds', () => {
    const a = newSeed();
    const b = newSeed();
    expect(a).toHaveLength(32);
    expect(a).not.toBe(b);
  });
});

describe('pickWeighted', () => {
  it('lands in the lowest bucket at the start of the range', () => {
    expect(pickWeighted(0, BUCKET_WEIGHTS)).toBe(2);
  });

  it('lands in the highest bucket at the end of the range', () => {
    expect(pickWeighted(0.999999, BUCKET_WEIGHTS)).toBe(100);
  });

  it('always returns a declared bucket', () => {
    for (let i = 0; i < 500; i++) {
      const b = pickWeighted(seedFloat('buckets', i), BUCKET_WEIGHTS);
      expect(LEVERAGE_BUCKETS).toContain(b as (typeof LEVERAGE_BUCKETS)[number]);
    }
  });
});

describe('pickLeverage distribution', () => {
  it('matches the declared weights within tolerance and keeps 100x rare', () => {
    const counts: Record<number, number> = { 2: 0, 5: 0, 10: 0, 25: 0, 100: 0 };
    const n = 50_000;
    for (let i = 0; i < n; i++) counts[pickLeverage(seedFloat('lev', i))] += 1;

    const total = Object.values(BUCKET_WEIGHTS).reduce((a, b) => a + b, 0);
    for (const bucket of LEVERAGE_BUCKETS) {
      const expected = BUCKET_WEIGHTS[bucket] / total;
      expect(counts[bucket] / n).toBeCloseTo(expected, 1);
    }
    // 100x is the lotto: distinctly the rarest outcome.
    expect(counts[100]).toBeLessThan(counts[2]);
    expect(counts[100]).toBeLessThan(counts[25]);
  });
});
