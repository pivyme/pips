// Pure money-math tests. No chain: math.ts is chain-free by design so the stake->quantity
// inversion, the 1e9 vs 6dp scaling, and payout/multiplier are verified in isolation.

import { describe, expect, it } from 'bun:test';

import {
  DUSDC_DECIMALS,
  FLOAT_SCALING,
  formatDusdcRaw,
  fromDusdcRaw,
  houseRake,
  mulScaled,
  multiplier,
  quantityForStake,
  toDusdcRaw,
  usd1e9,
} from './math.ts';

describe('scaling helpers', () => {
  it('uses the two protocol scales', () => {
    expect(FLOAT_SCALING).toBe(1_000_000_000n);
    expect(DUSDC_DECIMALS).toBe(1_000_000n);
  });

  it('usd1e9 scales display USD to 1e9 fixed-point', () => {
    expect(usd1e9(1)).toBe(1_000_000_000n);
    expect(usd1e9(109_000)).toBe(109_000_000_000_000n);
    expect(usd1e9(0.5)).toBe(500_000_000n);
  });

  it('toDusdcRaw / fromDusdcRaw round-trip whole and fractional amounts', () => {
    expect(toDusdcRaw(1000)).toBe(1_000_000_000n);
    expect(toDusdcRaw(25.3)).toBe(25_300_000n);
    expect(fromDusdcRaw(25_300_000n)).toBe(25.3);
    expect(fromDusdcRaw(toDusdcRaw(1000))).toBe(1000);
  });

  it('formats all six on-chain decimals without floating-point rounding', () => {
    expect(formatDusdcRaw(25_300_000n)).toBe('25.30');
    expect(formatDusdcRaw(98_562_719n)).toBe('98.562719');
    expect(formatDusdcRaw(-107n)).toBe('-0.000107');
  });
});

describe('mulScaled (deepbook math::mul, floored)', () => {
  it('prices a position: cost = ask(1e9) * quantity(6dp)', () => {
    // ask = $0.50, quantity = $40 max payout -> cost = $20.00
    expect(mulScaled(usd1e9(0.5), toDusdcRaw(40))).toBe(toDusdcRaw(20));
  });

  it('full price pays back the whole quantity', () => {
    expect(mulScaled(FLOAT_SCALING, toDusdcRaw(40))).toBe(toDusdcRaw(40));
  });

  it('floors fractional sub-units', () => {
    // ask = 1/3, quantity = 1 unit (1e-6) -> 0 after floor
    expect(mulScaled(333_333_333n, 1n)).toBe(0n);
  });
});

describe('quantityForStake (cost inversion)', () => {
  it('inverts mulScaled at first order', () => {
    const ask = usd1e9(0.5);
    const stake = toDusdcRaw(20);
    const qty = quantityForStake(ask, stake);
    expect(qty).toBe(toDusdcRaw(40));
    // round-trips back to the stake
    expect(mulScaled(ask, qty)).toBe(stake);
  });

  it('a cheaper side buys more quantity for the same stake', () => {
    const stake = toDusdcRaw(10);
    const cheap = quantityForStake(usd1e9(0.2), stake);
    const dear = quantityForStake(usd1e9(0.8), stake);
    expect(cheap).toBeGreaterThan(dear);
  });

  it('rejects a non-positive ask', () => {
    expect(() => quantityForStake(0n, toDusdcRaw(10))).toThrow();
  });
});

describe('multiplier (payout / cost)', () => {
  it('computes the gross multiple', () => {
    expect(multiplier(toDusdcRaw(20), toDusdcRaw(40))).toBe(2);
    expect(multiplier(toDusdcRaw(25), toDusdcRaw(40))).toBeCloseTo(1.6, 10);
  });

  it('is zero when there is no cost', () => {
    expect(multiplier(0n, toDusdcRaw(40))).toBe(0);
  });
});

describe('houseRake (entry vig split)', () => {
  const minNet = toDusdcRaw(1.2); // real-mode-style floor

  it('splits a stake into net + rake at the given bps', () => {
    // $10 at 1.5% (150 bps) -> $0.15 rake, $9.85 net.
    const { rake, net } = houseRake(toDusdcRaw(10), 150n, 0n);
    expect(rake).toBe(toDusdcRaw(0.15));
    expect(net).toBe(toDusdcRaw(9.85));
    expect(rake + net).toBe(toDusdcRaw(10)); // conserves the stake exactly
  });

  it('is a clean no-op at 0 bps (net == stake, rake == 0)', () => {
    const stake = toDusdcRaw(10);
    expect(houseRake(stake, 0n, 0n)).toEqual({ rake: 0n, net: stake });
    expect(houseRake(stake, -5n, 0n)).toEqual({ rake: 0n, net: stake });
  });

  it('skips the rake when net would fall below the floor, never breaking a mint', () => {
    // $1.20 at 1.5% would net $1.182 < the $1.20 floor -> skip (rake 0, full stake sizes the position).
    const stake = toDusdcRaw(1.2);
    expect(houseRake(stake, 150n, minNet)).toEqual({ rake: 0n, net: stake });
    // A comfortably-above-floor stake still rakes.
    const { rake, net } = houseRake(toDusdcRaw(3), 150n, minNet);
    expect(rake).toBe(toDusdcRaw(0.045));
    expect(net).toBe(toDusdcRaw(2.955));
    expect(net).toBeGreaterThanOrEqual(minNet);
  });

  it('handles a non-positive stake and a sub-unit rake', () => {
    expect(houseRake(0n, 150n, 0n)).toEqual({ rake: 0n, net: 0n });
    // A stake so small the rake floors to 0 raw units -> no-op (never a negative or phantom rake).
    expect(houseRake(1n, 150n, 0n)).toEqual({ rake: 0n, net: 1n });
  });
});
