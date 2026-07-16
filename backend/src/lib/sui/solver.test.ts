// Tier -> strike solver tests (LUCKY.md §5). Chain-free: a mock preview models the live Predict price.
// Asserts the solver picks the strike matching the tier's real multiple, sizes quantity to the bet, and falls back to the closest achievable tier past the ask bounds.

import { describe, expect, it } from 'bun:test';

import { solveStrike, LUCKY_TIERS, type Grid, type BatchPreviewFn } from './solver.ts';
import { usd1e9, toDusdcRaw } from './math.ts';
import type { Side, TradeAmounts } from './predict.ts';

const TICK = usd1e9(1); // $1 tick
const SPOT = usd1e9(100); // $100 spot
const GRID: Grid = { tick: TICK, min: usd1e9(1), max: usd1e9(1) + TICK * 499n }; // 500-tick grid
const BET = toDusdcRaw(10); // $10 bet

// Models binary ITM probability as a logistic of strike distance from spot, so the per-unit multiple (1/ask) is monotonic per side: up pays more the further ABOVE spot, down the further BELOW.
// An optional ask floor makes deep-OTM strikes unmintable (null) to exercise the fallback path; batched so the solver gets aligned results in one round trip.
function mockPreview(side: Side, opts: { k?: number; mintFloorAsk?: number } = {}): BatchPreviewFn {
  const k = opts.k ?? 8;
  const floor = opts.mintFloorAsk ?? 0;
  const one = (strike1e9: bigint, quantity: bigint): TradeAmounts | null => {
    const x = Number(strike1e9 - SPOT) / Number(SPOT); // relative distance from spot
    const z = (side === 'up' ? -1 : 1) * k * x;
    const ask = 1 / (1 + Math.exp(-z)); // ITM probability in (0, 1); multiple = 1 / ask
    if (ask < floor) return null; // outside ask bounds -> unmintable
    const cost = (BigInt(Math.round(ask * 1e9)) * quantity) / 1_000_000_000n; // mulScaled(ask, qty)
    return { cost, payout: quantity };
  };
  return async (probes) => probes.map((p) => one(p.strike1e9, p.quantity));
}

describe('solveStrike: grid-strike selection', () => {
  it('snaps a 2x tier to the at-the-money strike (up)', async () => {
    const s = await solveStrike({ grid: GRID, side: 'up', tierMultiplier: 2, betRaw: BET, preview: mockPreview('up') });
    expect(s.multiplier).toBeCloseTo(2, 1);
    expect(Number(s.strike1e9 - SPOT) / Number(TICK)).toBeCloseTo(0, 0); // within a tick of spot
    expect(s.achievedTier).toBe(2);
    expect(s.clamped).toBe(false);
  });

  it('picks an out-of-the-money strike above spot for a 5x up tier', async () => {
    const s = await solveStrike({ grid: GRID, side: 'up', tierMultiplier: 5, betRaw: BET, preview: mockPreview('up') });
    expect(s.multiplier).toBeGreaterThan(4);
    expect(s.multiplier).toBeLessThan(6);
    expect(s.strike1e9).toBeGreaterThan(SPOT); // OTM call sits above spot
    expect(s.achievedTier).toBe(5);
  });

  it('picks a below-spot strike for a 5x down tier', async () => {
    const s = await solveStrike({ grid: GRID, side: 'down', tierMultiplier: 5, betRaw: BET, preview: mockPreview('down') });
    expect(s.multiplier).toBeGreaterThan(4);
    expect(s.multiplier).toBeLessThan(6);
    expect(s.strike1e9).toBeLessThan(SPOT); // OTM put sits below spot
  });

  it('keeps the strike on the OTM side of spot when a live spot is supplied (up)', async () => {
    // With atm1e9 set, the solver must never pick an in-the-money strike, even for the lowest tier,
    // so an UP target always sits at/above entry. A 2x lands at the ATM edge (>= spot).
    const s = await solveStrike({ grid: GRID, side: 'up', tierMultiplier: 2, betRaw: BET, preview: mockPreview('up'), atm1e9: SPOT });
    expect(s.strike1e9).toBeGreaterThanOrEqual(SPOT);
  });

  it('keeps the strike on the OTM side of spot when a live spot is supplied (down)', async () => {
    const s = await solveStrike({ grid: GRID, side: 'down', tierMultiplier: 2, betRaw: BET, preview: mockPreview('down'), atm1e9: SPOT });
    expect(s.strike1e9).toBeLessThanOrEqual(SPOT); // a DOWN target sits at/below entry
  });

  it('pushes the floor tier a minimum offset past spot when minOffset is set (up)', async () => {
    // With a min offset the 2x floor must clear spot by it, so the target is always a real move, never
    // an at-the-money strike sitting on the entry line.
    const minOffset1e9 = TICK;
    const s = await solveStrike({ grid: GRID, side: 'up', tierMultiplier: 2, betRaw: BET, preview: mockPreview('up'), atm1e9: SPOT, minOffset1e9 });
    expect(s.strike1e9).toBeGreaterThanOrEqual(SPOT + minOffset1e9);
    expect(s.multiplier).toBeGreaterThan(2); // a touch above 2x, since it sits OTM not at the money
  });

  it('pushes the floor tier a minimum offset below spot when minOffset is set (down)', async () => {
    const minOffset1e9 = TICK;
    const s = await solveStrike({ grid: GRID, side: 'down', tierMultiplier: 2, betRaw: BET, preview: mockPreview('down'), atm1e9: SPOT, minOffset1e9 });
    expect(s.strike1e9).toBeLessThanOrEqual(SPOT - minOffset1e9);
    expect(s.multiplier).toBeGreaterThan(2);
  });
});

describe('solveStrike: quantity inversion', () => {
  it('sizes quantity so the real cost lands just under the bet', async () => {
    const s = await solveStrike({ grid: GRID, side: 'up', tierMultiplier: 3, betRaw: BET, preview: mockPreview('up') });
    expect(s.entryCost).toBeLessThanOrEqual(BET);
    expect(Number(s.entryCost)).toBeGreaterThan(Number(BET) * 0.94); // within the 2% headroom band
  });

  it('reports the multiple as the real quantity / cost ratio', async () => {
    const s = await solveStrike({ grid: GRID, side: 'up', tierMultiplier: 5, betRaw: BET, preview: mockPreview('up') });
    expect(Number(s.quantity) / Number(s.entryCost)).toBeCloseTo(s.multiplier, 5);
  });
});

describe('solveStrike: fallback when the tier is past the ask bounds', () => {
  it('clamps a 25x request to the closest achievable tier and flags it', async () => {
    // ask floor 0.1 caps the mintable multiple near 10x, so a 25x request cannot land.
    const s = await solveStrike({
      grid: GRID,
      side: 'up',
      tierMultiplier: 25,
      betRaw: BET,
      preview: mockPreview('up', { mintFloorAsk: 0.1 }),
    });
    expect(s.clamped).toBe(true);
    expect(s.multiplier).toBeLessThanOrEqual(11);
    expect(s.requestedTier).toBe(25);
    expect(s.achievedTier).toBe(10); // nearest reachable nominal tier
    expect(s.entryCost).toBeLessThanOrEqual(BET); // still a real, mintable, bet-sized play
  });
});

describe('LUCKY_TIERS', () => {
  it('is the locked §4 tier ladder (directional, 2x floor, 10x cap)', () => {
    expect([...LUCKY_TIERS]).toEqual([2, 3, 5, 10]);
  });
});
