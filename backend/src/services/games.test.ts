import { describe, expect, it } from 'bun:test';

import { probit, binaryOffsetFrac } from './games.ts';
import { REAL_STRIKE_MIN_PROB, REAL_STRIKE_MAX_OFFSET_FRAC, REAL_BTC_ANNUAL_VOL } from '../config/main-config.ts';

// The real-mode strike sizer can't be exercised on-chain (a mint needs a funded wrapper, L-012), so the
// math it rests on is pinned here. binaryOffsetFrac places a binary strike at z(p)*sigma off spot where
// p = target win probability, so a mint's entry probability lands inside the chain's (unreadable)
// admission band instead of the fixed-percentage strike that always aborts on a 20-60s market.

// Acklam's inverse-normal-CDF approximation against textbook quantiles (abs error < 1.2e-9).
describe('probit', () => {
  it('matches standard-normal quantiles', () => {
    expect(probit(0.5)).toBeCloseTo(0, 6);
    expect(probit(0.975)).toBeCloseTo(1.959964, 4);
    expect(probit(0.95)).toBeCloseTo(1.644854, 4);
    expect(probit(0.84134)).toBeCloseTo(1.0, 3); // 1 sigma
    expect(probit(0.06)).toBeCloseTo(-1.554774, 4);
  });

  it('is antisymmetric about 0.5', () => {
    for (const p of [0.01, 0.1, 0.3]) expect(probit(p)).toBeCloseTo(-probit(1 - p), 6);
  });
});

describe('binaryOffsetFrac (real strike sizing)', () => {
  const SECS = 20; // a live 1m/1s BTC round is tens of seconds out

  it('sits at ATM for a coin-flip strike (strikeTier 2 -> p 0.5)', () => {
    expect(binaryOffsetFrac(2, SECS)).toBeCloseTo(0, 9);
  });

  it('goes in-the-money (offset < 0) for a low strike tier, out for a high one', () => {
    expect(binaryOffsetFrac(1.33, SECS)).toBeLessThan(0); // p ~0.75, ITM
    expect(binaryOffsetFrac(5, SECS)).toBeGreaterThan(0); // p ~0.20, OTM
  });

  it('is monotonically increasing in strike tier (further OTM = lower win odds)', () => {
    const tiers = [1.33, 1.67, 2.5, 5, 10, 25];
    const offs = tiers.map((t) => binaryOffsetFrac(t, SECS));
    for (let i = 1; i < offs.length; i++) expect(offs[i]).toBeGreaterThanOrEqual(offs[i - 1]);
  });

  it('floors the target probability so a huge tier never lands past the admissible band', () => {
    // p is clamped to >= REAL_STRIKE_MIN_PROB, so the offset saturates rather than running to +inf.
    const capOff = binaryOffsetFrac(1e6, SECS);
    const flooredOff = probitApproxOff(REAL_STRIKE_MIN_PROB, SECS);
    expect(capOff).toBeCloseTo(flooredOff, 9);
  });

  it('respects the absolute guard cap when volatility runs hot', () => {
    // A full-year horizon makes sigma huge; the offset must clamp to the guard band on both sides.
    const YEAR = 365.25 * 24 * 3600;
    expect(binaryOffsetFrac(10, YEAR)).toBeCloseTo(REAL_STRIKE_MAX_OFFSET_FRAC, 9);
    expect(binaryOffsetFrac(1.05, YEAR)).toBeCloseTo(-REAL_STRIKE_MAX_OFFSET_FRAC, 9);
  });
});

// The offset at a given target probability (mirrors binaryOffsetFrac's core, for the floor assertion).
function probitApproxOff(p: number, seconds: number): number {
  const sigma = REAL_BTC_ANNUAL_VOL * Math.sqrt(seconds / (365.25 * 24 * 3600));
  return probit(1 - p) * sigma;
}
