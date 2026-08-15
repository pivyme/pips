// RUSH's offer store: the security seam of the games wave.
//
// The machine deals, the player accepts. That only holds if the band and the multiple are the SERVER's:
// a client must never be able to mint a band that was never offered, or at a multiple that was never
// quoted. So a dealt offer is stored here with the exact ticks it will mint at, and a take references it
// by id. The take carries no band, no width, and no price.
//
// In memory on purpose: an offer lives ~3 seconds, so a restart simply means the next beat deals a fresh
// one. There is no schema for this and it does not want one.

import { randomUUID } from 'node:crypto';

export type RushOffer = {
  id: string;
  userId: string;
  marketId: string;
  expiryMs: number; // the market's buzzer, not the offer's
  lowerTick: bigint;
  higherTick: bigint;
  lower: string; // display bounds, so the take mints exactly what was drawn on screen
  upper: string;
  multiplier: number; // the chain's own quote at deal time
  entryProbability: number;
  stakeRaw: bigint; // the stake it was quoted at; a take at any other stake is not this deal
  dealtAt: number;
  expiresAt: number; // the offer's own countdown: past this it is gone, take or not
};

/** A dealt band is on the table for this long. Matches the ~3s rhythm the screen drains its ring over. */
export const OFFER_TTL_MS = 3500;
/** The floor between two deals for one player, so a spamming client cannot hammer the shared fullnode. */
const DEAL_MIN_GAP_MS = 900;
/** Bounded so a client that spams deals cannot grow the process heap. Oldest go first. */
const MAX_OFFERS = 2000;

const offers = new Map<string, RushOffer>();
const lastDealAt = new Map<string, number>();

function sweep(nowMs: number): void {
  for (const [id, o] of offers) if (o.expiresAt <= nowMs) offers.delete(id);
  for (const [userId, at] of lastDealAt) if (nowMs - at > OFFER_TTL_MS * 4) lastDealAt.delete(userId);
  while (offers.size > MAX_OFFERS) {
    const oldest = offers.keys().next().value;
    if (oldest == null) break;
    offers.delete(oldest);
  }
}

/** The band this player already has on the table, if any. One live offer per player is also the deal throttle. */
export function liveOffer(userId: string, nowMs = Date.now()): RushOffer | null {
  sweep(nowMs);
  for (const o of offers.values()) if (o.userId === userId) return o;
  return null;
}

/** Bin whatever this player has on the table. Used when the stake moves under a deal it was quoted at. */
export function dropOffers(userId: string): void {
  for (const [id, o] of offers) if (o.userId === userId) offers.delete(id);
}

/** A quiet beat, deliberately: the player asked again before the machine was ready to deal. */
export function dealTooSoon(userId: string, nowMs = Date.now()): boolean {
  const at = lastDealAt.get(userId);
  return at != null && nowMs - at < DEAL_MIN_GAP_MS;
}

export function noteDeal(userId: string, nowMs = Date.now()): void {
  lastDealAt.set(userId, nowMs);
}

export function putOffer(o: Omit<RushOffer, 'id' | 'dealtAt' | 'expiresAt'>, nowMs = Date.now()): RushOffer {
  sweep(nowMs);
  const offer: RushOffer = { ...o, id: randomUUID(), dealtAt: nowMs, expiresAt: nowMs + OFFER_TTL_MS };
  offers.set(offer.id, offer);
  return offer;
}

/**
 * Consume an offer for a take. Single use: an offer that mints is gone, or one fat deal could be taken
 * repeatedly. Unknown, expired, already taken, and someone else's all return null and read identically to
 * the caller, so a probe learns nothing about which of those it was.
 */
export function claimOffer(userId: string, id: string, nowMs = Date.now()): RushOffer | null {
  const o = offers.get(id);
  if (!o) return null;
  if (o.userId !== userId) return null;
  if (o.expiresAt <= nowMs) {
    offers.delete(id);
    return null;
  }
  offers.delete(id);
  return o;
}

/** Test seam only: the store is process-local and every test needs a clean one. */
export function _resetOffers(): void {
  offers.clear();
  lastDealAt.clear();
}
