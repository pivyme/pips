import { describe, expect, it } from 'bun:test';

import { decodeOrderId, matchRealRedeemInPage } from './predict-real.ts';

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
