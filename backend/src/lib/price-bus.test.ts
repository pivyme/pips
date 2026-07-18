// Pure tests for the display feed's re-entry hysteresis (cosmetic per L-015, no truthful number touched
// here): the driver flap logic that decides when Binance texture is trusted vs the on-chain fallback. The
// level/texture math in displaySpot pulls a live chain/socket read, so it is covered by the manual QA in the plan.

import { describe, expect, it } from 'bun:test';

import { nextPinDriver } from './price-bus.ts';

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
