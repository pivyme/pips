import { describe, expect, it, beforeEach } from 'bun:test';

import { OFFER_TTL_MS, _resetOffers, claimOffer, dealTooSoon, dropOffers, liveOffer, noteDeal, putOffer } from './rush-offers.ts';
import { RUSH_APPETITES, resolveReal, rushDealChance } from './games.ts';

// RUSH's offer store is the security seam of the games wave: the band and the multiple are the SERVER's, and
// a take names an offer id, nothing else. Everything below is about what a client must NOT be able to mint.

const AT = 1_770_000_000_000; // a fixed clock, so nothing here depends on wall time
const band = (userId: string) => ({
  userId,
  marketId: '0xmarket',
  expiryMs: AT + 40_000,
  lowerTick: 6_300_000n,
  higherTick: 6_310_000n,
  lower: '62990',
  upper: '63010',
  multiplier: 3.2,
  entryProbability: 0.3,
  stakeRaw: 1_500_000n,
});

describe('claimOffer (a take can only ever mint what was dealt)', () => {
  beforeEach(() => _resetOffers());

  it('claims a live offer exactly once', () => {
    const o = putOffer(band('u1'), AT);
    expect(claimOffer('u1', o.id, AT + 100)?.id).toBe(o.id);
    // The second take of the same deal is the interesting one: one fat band, minted twice, for one premium.
    expect(claimOffer('u1', o.id, AT + 200)).toBeNull();
  });

  it('rejects an unknown offer id', () => {
    expect(claimOffer('u1', 'not-an-offer', AT)).toBeNull();
  });

  it('rejects an expired offer', () => {
    const o = putOffer(band('u1'), AT);
    expect(claimOffer('u1', o.id, AT + OFFER_TTL_MS)).toBeNull();
    expect(claimOffer('u1', o.id, AT + 100)).toBeNull(); // and it is gone, not merely late
  });

  it("rejects another player's offer", () => {
    const o = putOffer(band('u1'), AT);
    expect(claimOffer('u2', o.id, AT + 100)).toBeNull();
    // Someone else's failed take must not consume it either, or a probe becomes a denial of service.
    expect(claimOffer('u1', o.id, AT + 100)?.id).toBe(o.id);
  });

  it('carries the ticks and the quoted multiple, so the take mints what was drawn', () => {
    const o = putOffer(band('u1'), AT);
    const claimed = claimOffer('u1', o.id, AT + 100)!;
    expect(claimed.lowerTick).toBe(6_300_000n);
    expect(claimed.higherTick).toBe(6_310_000n);
    expect(claimed.multiplier).toBe(3.2);
    expect(claimed.stakeRaw).toBe(1_500_000n);
  });
});

describe('the deal beat', () => {
  beforeEach(() => _resetOffers());

  it('keeps one band on the table per player', () => {
    const o = putOffer(band('u1'), AT);
    expect(liveOffer('u1', AT + 100)?.id).toBe(o.id);
    expect(liveOffer('u2', AT + 100)).toBeNull();
    expect(liveOffer('u1', AT + OFFER_TTL_MS)).toBeNull(); // swept once its countdown runs out
  });

  it('drops a deal whose stake moved under it', () => {
    putOffer(band('u1'), AT);
    dropOffers('u1');
    expect(liveOffer('u1', AT + 100)).toBeNull();
  });

  it('throttles a client that asks faster than the machine deals', () => {
    noteDeal('u1', AT);
    expect(dealTooSoon('u1', AT + 100)).toBe(true);
    expect(dealTooSoon('u1', AT + 1000)).toBe(false);
    expect(dealTooSoon('u2', AT + 100)).toBe(false);
  });
});

// The knob has to be felt as a risk dial, not a payout picker: the stream thins as the appetite climbs.
describe('rushDealChance', () => {
  it('thins monotonically as the appetite climbs, and never stops dealing entirely', () => {
    const chances = RUSH_APPETITES.map(rushDealChance);
    for (let i = 1; i < chances.length; i++) expect(chances[i]).toBeLessThan(chances[i - 1]);
    expect(chances[0]).toBeGreaterThan(0.8); // the lazy end deals nearly every beat
    expect(chances[chances.length - 1]).toBeGreaterThan(0.1); // the greedy end goes quiet, never dead
    expect(Math.max(...chances)).toBeLessThanOrEqual(0.95);
  });
});

// The other half of the seam: a take that reaches the resolver without a claimed offer must die there,
// before anything is sized or minted. Nothing about the band is derivable from the body.
describe('resolveReal (rush)', () => {
  it('refuses a take carrying no server-claimed offer', async () => {
    await expect(resolveReal({ game: 'rush', stake: 1.5, asset: 'BTC', offerId: 'whatever' }, 1_500_000n, 1_500_000n)).rejects.toThrow(
      'That offer is gone',
    );
  });
});
