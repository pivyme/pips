// Pure tests for the display pin math (cosmetic per L-015, no truthful number touched here): verifies
// the chart line eases/degrades correctly with no socket, chain, or timers. Covers the slew-limited EMA step and the re-entry hysteresis, the whole non-trivial core.

import { describe, expect, it } from 'bun:test';

import { nextPinDriver, pinnedOffsetStep } from './price-bus.ts';

describe('pinnedOffsetStep (slew-limited EMA)', () => {
  it('pulls the offset toward the target by the time-constant factor when slew does not bind', () => {
    // dt == tau => k = 1 - e^-1 ~ 0.632. A huge price makes the slew cap enormous, so the EMA is free.
    const tau = 1200;
    const next = pinnedOffsetStep(0, 100, tau, 1e12, tau, 0.004);
    expect(next).toBeCloseTo(100 * (1 - Math.exp(-1)), 6);
  });

  it('converges monotonically over repeated steps (no overshoot)', () => {
    let off = 0;
    for (let i = 0; i < 50; i++) off = pinnedOffsetStep(off, 100, 200, 1e12, 1200, 0.004);
    expect(off).toBeGreaterThan(99.9);
    expect(off).toBeLessThanOrEqual(100);
  });

  it('slew-clamps a large upward jump to slewFrac * dt * price, not the full EMA move', () => {
    // Gap is huge, so the EMA wants to leap; the slew cap holds it to maxStep = 0.004 * 0.1 * 100 = 0.04.
    const next = pinnedOffsetStep(0, 1_000_000, 100, 100, 1200, 0.004);
    expect(next).toBeCloseTo(0.04, 9);
  });

  it('slew-clamps symmetrically on a downward jump', () => {
    const next = pinnedOffsetStep(0, -1_000_000, 100, 100, 1200, 0.004);
    expect(next).toBeCloseTo(-0.04, 9);
  });

  it('never moves when already at the target', () => {
    expect(pinnedOffsetStep(5, 5, 100, 100, 1200, 0.004)).toBe(5);
  });
});

describe('nextPinDriver (re-entry hysteresis)', () => {
  const REENTRY = 1500;

  it('drops to fallback immediately on any unhealthy read, from either driver', () => {
    expect(nextPinDriver('binance', false, 0, 5000, REENTRY)).toEqual({ driver: 'fallback', healthySince: 0 });
    expect(nextPinDriver('fallback', false, 4000, 5000, REENTRY)).toEqual({ driver: 'fallback', healthySince: 0 });
  });

  it('stays on binance without resetting its clock while healthy', () => {
    expect(nextPinDriver('binance', true, 0, 9000, REENTRY)).toEqual({ driver: 'binance', healthySince: 0 });
  });

  it('starts the healthy streak clock on the first good read after an outage', () => {
    expect(nextPinDriver('fallback', true, 0, 1000, REENTRY)).toEqual({ driver: 'fallback', healthySince: 1000 });
  });

  it('holds fallback until the healthy streak reaches reentryMs', () => {
    // 1000ms of health, short of the 1500ms bar: still on fallback, clock preserved.
    expect(nextPinDriver('fallback', true, 1000, 2000, REENTRY)).toEqual({ driver: 'fallback', healthySince: 1000 });
  });

  it('switches back to binance once the healthy streak clears reentryMs', () => {
    // 1600ms of continuous health: over the bar, switch and reset the clock.
    expect(nextPinDriver('fallback', true, 1000, 2600, REENTRY)).toEqual({ driver: 'binance', healthySince: 0 });
  });

  it('a lone healthy blip inside an outage never flaps the driver', () => {
    // start streak, then an unhealthy read resets it: the next healthy read starts over, no switch.
    const started = nextPinDriver('fallback', true, 0, 1000, REENTRY);
    const dropped = nextPinDriver(started.driver, false, started.healthySince, 1100, REENTRY);
    expect(dropped).toEqual({ driver: 'fallback', healthySince: 0 });
    const restart = nextPinDriver(dropped.driver, true, dropped.healthySince, 1200, REENTRY);
    expect(restart).toEqual({ driver: 'fallback', healthySince: 1200 });
  });
});
