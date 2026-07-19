import { describe, expect, it } from 'bun:test';

import { decodeOrderId, isSettledDefiniteLoss, matchRealRedeemInPage } from './predict-real.ts';

// decodeOrderId derives the full-close quantity + strike ticks straight from the packed u256 order id, so
// the settle worker needs no extra column. Fixture is a real testnet OrderMinted event (all 25 sampled live events decoded exactly), locking the offsets/masks against source drift.
describe('decodeOrderId', () => {
  it('decodes quantity + ticks from a real packed order id', () => {
    const d = decodeOrderId(100433603470183673232442518552005688471077296132715848925186n);
    expect(d.quantityRaw).toBe(10_390_000n);
    expect(d.lowerTick).toBe(6_213_400n);
    expect(d.higherTick).toBe(1_073_741_823n); // pos_inf_tick: an upper-open (binary-up) position
  });
});

// isSettledDefiniteLoss lets the settle worker skip the redeem tx for a provable loss. It must NEVER flag a
// winner (that would burn real chips), so every boundary/win/unknown case returns false and only a price a
// full tick outside the band returns true. BTC tick_size = 1e7 raw ($0.01); prices are 1e9-scaled.
describe('isSettledDefiniteLoss', () => {
  const TICK = 10_000_000n; // BTC $0.01
  const px = (dollars: number): bigint => BigInt(Math.round(dollars * 1e9)); // $ -> 1e9-scaled price
  const order = (lowerTick: bigint, higherTick: bigint) => ({ quantityRaw: 10_000_000n, lowerTick, higherTick });

  // Real fixture order: binary-up, lowerTick 6_213_400 (strike $62,134), higherTick pos_inf.
  const BINARY_UP = order(6_213_400n, 1_073_741_823n);
  const BINARY_DOWN = order(0n, 6_213_400n); // (-inf, $62,134]
  const RANGE = order(6_213_000n, 6_214_000n); // ($62,130, $62,140]

  it('binary-up: a settlement below the strike is a definite loss', () => {
    expect(isSettledDefiniteLoss(BINARY_UP, px(62_000), TICK)).toBe(true);
  });
  it('binary-up: a settlement above the strike is a win, never skipped', () => {
    expect(isSettledDefiniteLoss(BINARY_UP, px(62_200), TICK)).toBe(false);
  });
  it('binary-up: a settlement at the strike is on-boundary, never skipped', () => {
    expect(isSettledDefiniteLoss(BINARY_UP, px(62_134), TICK)).toBe(false);
  });
  it('binary-up: within one tick below the strike is not skipped (redeem decides)', () => {
    expect(isSettledDefiniteLoss(BINARY_UP, px(62_134) - TICK + 1n, TICK)).toBe(false);
    expect(isSettledDefiniteLoss(BINARY_UP, px(62_134) - TICK, TICK)).toBe(true); // a full tick below: loss
  });
  it('binary-down: above the strike is a loss, below/at is a win', () => {
    expect(isSettledDefiniteLoss(BINARY_DOWN, px(62_200), TICK)).toBe(true);
    expect(isSettledDefiniteLoss(BINARY_DOWN, px(62_100), TICK)).toBe(false);
    expect(isSettledDefiniteLoss(BINARY_DOWN, px(62_134), TICK)).toBe(false);
  });
  it('range: inside the band is a win, either side out is a loss', () => {
    expect(isSettledDefiniteLoss(RANGE, px(62_135), TICK)).toBe(false);
    expect(isSettledDefiniteLoss(RANGE, px(62_120), TICK)).toBe(true);
    expect(isSettledDefiniteLoss(RANGE, px(62_150), TICK)).toBe(true);
  });
  it('never skips on a missing/garbage price or tick size', () => {
    expect(isSettledDefiniteLoss(BINARY_UP, 0n, TICK)).toBe(false);
    expect(isSettledDefiniteLoss(BINARY_UP, px(62_000), 0n)).toBe(false);
    expect(isSettledDefiniteLoss(BINARY_UP, -1n, TICK)).toBe(false);
  });
});

// The settle backstop reconciles an already-closed real position against its on-chain redeem event.
// Fixture mirrors the live GraphQL tx shape (events under effects.events.nodes, payload at contents.json + contents.type.repr), oldest-first within a page, so the scan iterates reversed.
describe('matchRealRedeemInPage', () => {
  const ORDER = 100433603470183673232442518552005688471077296132715848925186n;
  const settledEvent = (orderId: bigint, payout: string) => ({
    contents: { json: { order_id: orderId.toString(), payout_amount: payout, quantity_closed: '10390000', settlement_price: '62000000000000' }, type: { repr: '0xpkg::order_events::SettledOrderRedeemed' } },
  });
  const tx = (digest: string, orderId: bigint, payout: string) => ({ digest, effects: { events: { nodes: [settledEvent(orderId, payout)] } } });

  it('finds a settled redeem for the order and reads its payout', () => {
    const hit = matchRealRedeemInPage([tx('0xd1', ORDER, '10390000')], ORDER);
    expect(hit).not.toBeNull();
    expect(hit!.payoutRaw).toBe(10_390_000n);
    expect(hit!.settled).toBe(true);
    expect(hit!.digest).toBe('0xd1');
  });

  it('returns null when no event matches the order id', () => {
    expect(matchRealRedeemInPage([tx('0xd1', 999n, '5')], ORDER)).toBeNull();
  });

  it('prefers the most recent matching redeem (reversed page walk)', () => {
    // Page is oldest-first: the later tx (newer) must win.
    const hit = matchRealRedeemInPage([tx('0xold', ORDER, '1'), tx('0xnew', ORDER, '2')], ORDER);
    expect(hit!.digest).toBe('0xnew');
    expect(hit!.payoutRaw).toBe(2n);
  });
});
