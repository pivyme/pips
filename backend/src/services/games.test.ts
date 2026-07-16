import { describe, expect, it } from 'bun:test';

import { probit, binaryOffsetFrac, binaryOffsetFloored, otmStrike1e9 } from './games.ts';
import { REAL_STRIKE_MIN_PROB, REAL_STRIKE_MAX_OFFSET_FRAC, REAL_BTC_ANNUAL_VOL, REAL_BINARY_MIN_OFFSET_SIGMA } from '../config/main-config.ts';

// The real-mode strike sizer can't be exercised on-chain (needs a funded wrapper, L-012), so the math it
// rests on is pinned here: binaryOffsetFrac places a strike at z(p)*sigma off spot so entry probability lands inside the chain's (unreadable) admission band, instead of the fixed strike that always aborts on a 20-60s market.

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

// The 2x tier prices ATM (raw offset 0), so its target would hug the entry line even after snapping to the
// grid ($1 away). The floor lifts it to a visible directional move while staying sigma-scaled/admissible (L-013).
describe('binaryOffsetFloored (2x tier is a visible move, not ATM)', () => {
  const SECS = 25;
  const sigma = REAL_BTC_ANNUAL_VOL * Math.sqrt(SECS / (365.25 * 24 * 3600));

  it('lifts the ATM 2x tier to the sigma-scaled minimum offset', () => {
    expect(binaryOffsetFrac(2, SECS)).toBeCloseTo(0, 9); // raw 2x is a coin-flip, ATM
    expect(binaryOffsetFloored(2, SECS)).toBeCloseTo(REAL_BINARY_MIN_OFFSET_SIGMA * sigma, 9);
    expect(binaryOffsetFloored(2, SECS)).toBeGreaterThan(binaryOffsetFrac(2, SECS));
  });

  it('leaves a high tier that already clears the floor untouched', () => {
    expect(binaryOffsetFloored(10, SECS)).toBeCloseTo(binaryOffsetFrac(10, SECS), 9);
  });
});

// The 2x floor prices at p=0.5 (offset 0), so the strike snapper must move it off the entry line, else
// ENTRY == TARGET (the reported bug). Pinned here since the snap can't be exercised on-chain (L-012).
describe('otmStrike1e9 (binary strike never lands on the entry line)', () => {
  const ADM = 1_000_000_000n; // BTC admission step = $1 (1e9-scaled)
  const spot = 64_196_870_000_000n; // $64,196.87, between admission boundaries

  it('pushes a coin-flip (2x, raw offset 0) strike one admission step OTM, not onto entry', () => {
    expect(otmStrike1e9('up', spot, spot, ADM)).toBe(64_197_000_000_000n); // first $1 boundary above
    expect(otmStrike1e9('down', spot, spot, ADM)).toBe(64_196_000_000_000n); // first $1 boundary below
    expect(otmStrike1e9('up', spot, spot, ADM)).toBeGreaterThan(spot);
    expect(otmStrike1e9('down', spot, spot, ADM)).toBeLessThan(spot);
  });

  it('snaps a real offset onto the admission grid on the OTM side (up ceils, down floors)', () => {
    expect(otmStrike1e9('up', 64_207_700_000_000n, spot, ADM)).toBe(64_208_000_000_000n);
    expect(otmStrike1e9('down', 64_186_300_000_000n, spot, ADM)).toBe(64_186_000_000_000n);
  });

  it('stays strictly OTM even when spot sits exactly on an admission boundary', () => {
    const onGrid = 64_196_000_000_000n; // $64,196.00
    expect(otmStrike1e9('up', onGrid, onGrid, ADM)).toBe(64_197_000_000_000n);
    expect(otmStrike1e9('down', onGrid, onGrid, ADM)).toBe(64_195_000_000_000n);
  });

  it('steps an extra boundary out when the strike would round onto the 2dp entry line', () => {
    const nearUp = 64_196_997_000_000n; // $64,196.997 -> rounds to 64,197.00, same as the first boundary above
    expect(otmStrike1e9('up', nearUp, nearUp, ADM)).toBe(64_198_000_000_000n);
    const nearDown = 64_196_003_000_000n; // $64,196.003 -> rounds to 64,196.00, same as the first boundary below
    expect(otmStrike1e9('down', nearDown, nearDown, ADM)).toBe(64_195_000_000_000n);
  });
});

// The offset at a given target probability (mirrors binaryOffsetFrac's core, for the floor assertion).
function probitApproxOff(p: number, seconds: number): number {
  const sigma = REAL_BTC_ANNUAL_VOL * Math.sqrt(seconds / (365.25 * 24 * 3600));
  return probit(1 - p) * sigma;
}
