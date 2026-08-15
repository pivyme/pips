import { describe, expect, it } from 'bun:test';

import { decodeOrderId, isSettledDefiniteLoss, matchRealRedeemInPage, normalizePythSpot1e9, parseMints, parseRedeems } from './predict-real.ts';

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

// Mirrors pyth_feed::normalize_raw_spot. The chart's level rides on this, and since 7-29 it is the only
// readable live spot (the Block Scholes store has no latest lane), so a wrong shift moves every line.
describe('normalizePythSpot1e9', () => {
  it('scales a real captured BTC read (exp -8) to 1e9', () => {
    // Captured verbatim off the 7-29 PythFeed lane.latest on 2026-08-08.
    expect(normalizePythSpot1e9({ price_magnitude: '6497963076825', exponent_magnitude: 8, exponent_is_negative: true })).toBe(
      64_979_630_768_250n,
    );
  });

  it('rounds down when the source carries finer precision than 1e9', () => {
    // exp -12 is 3 decimals finer than 1e9, so the last 3 digits are truncated, never rounded up.
    expect(normalizePythSpot1e9({ price_magnitude: '123456789012', exponent_magnitude: 12, exponent_is_negative: true })).toBe(123_456_789n);
  });

  it('scales up on a positive exponent', () => {
    expect(normalizePythSpot1e9({ price_magnitude: '7', exponent_magnitude: 2, exponent_is_negative: false })).toBe(700_000_000_000n);
  });

  it('returns null for a negative, zero, or unrepresentable price rather than a bogus number', () => {
    expect(normalizePythSpot1e9({ price_magnitude: '1', price_is_negative: true, exponent_magnitude: 8, exponent_is_negative: true })).toBeNull();
    expect(normalizePythSpot1e9({ price_magnitude: '0', exponent_magnitude: 8, exponent_is_negative: true })).toBeNull();
    expect(normalizePythSpot1e9({ price_magnitude: '1', exponent_magnitude: 30, exponent_is_negative: true })).toBeNull();
    expect(normalizePythSpot1e9({ price_magnitude: '1', exponent_magnitude: 20, exponent_is_negative: false })).toBeNull();
    expect(normalizePythSpot1e9({})).toBeNull();
  });
});

// A multi-leg play (BREAKOUT) mints both legs in one PTB and closes both in one PTB, so the parsers have to
// return EVERY leg. Missing one silently loses a real payout, which reads as a normal loss.
describe('parseMints', () => {
  const minted = (orderId: string, quantity: string) => ({
    type: '0xabc::order_events::OrderMinted',
    parsedJson: {
      order_id: orderId,
      quantity,
      expiry_market_id: '0xmarket',
      leverage: '1000000000',
      entry_probability: '200000000',
      net_premium: '1200000',
      trading_fee: '100000',
      builder_fee: '0',
      penalty_fee: '0',
      lower_tick: '6298100',
      higher_tick: '1073741823',
    },
  });

  it('returns one result per leg, in emission order', () => {
    const r = parseMints([minted('11', '7340000'), { type: '0xabc::other::Thing', parsedJson: {} }, minted('22', '7520000')]);
    expect(r.map((m) => m.orderId)).toEqual([11n, 22n]);
    expect(r.map((m) => m.quantityRaw)).toEqual([7_340_000n, 7_520_000n]);
    expect(r[0].costRaw).toBe(1_300_000n); // net premium + all three fees
  });

  it('throws rather than returning an empty list when nothing minted', () => {
    expect(() => parseMints([{ type: '0xabc::other::Thing', parsedJson: {} }])).toThrow('missing OrderMinted event');
  });
});

describe('parseRedeems', () => {
  const settled = (orderId: string, payout: string) => ({
    type: '0xabc::order_events::SettledOrderRedeemed',
    parsedJson: { order_id: orderId, payout_amount: payout, quantity_closed: '7340000', settlement_price: '63000000000000' },
  });
  const liquidated = (orderId: string) => ({
    type: '0xabc::order_events::LiquidatedOrderRedeemed',
    parsedJson: { order_id: orderId, quantity_closed: '7340000' },
  });

  it('returns one result per order so a multi-leg close can sum its legs', () => {
    const r = parseRedeems([settled('11', '7340000'), settled('22', '0')]);
    expect(r.length).toBe(2);
    expect(r.reduce((sum, x) => sum + x.payoutRaw, 0n)).toBe(7_340_000n);
  });

  // Precedence, not order: a liquidated order pays nothing whichever event the chain emitted first, or a
  // knocked-out leg would be summed in as a win.
  it('collapses a liquidation tombstone onto the same order, in either emission order', () => {
    for (const events of [[settled('11', '7340000'), liquidated('11')], [liquidated('11'), settled('11', '7340000')]]) {
      const r = parseRedeems(events);
      expect(r.length).toBe(1);
      expect(r[0].liquidated).toBe(true);
      expect(r[0].payoutRaw).toBe(0n);
    }
  });

  it('throws when no redeem event fired at all', () => {
    expect(() => parseRedeems([{ type: '0xabc::other::Thing', parsedJson: {} }])).toThrow('no redeem event found');
  });
});
