// In-memory cache of the live oracle set. oracle-roll keeps it true (adds the oracles it
// creates, drops settled ones), price-pusher and settle read it each tick, and /markets
// will read it to tell the games what is tradeable right now. Seeded from deployed.json so
// the set is non-empty the moment the server boots; oracle-roll reconciles against chain.

import { ORACLES, ORACLE_CAP_IDS } from './config.ts';

export type Market = {
  oracleId: string;
  capId: string; // the authorized cap a worker uses to push/settle this oracle
  underlying: string;
  expiryMs: number;
  minStrike: string; // 1e9-scaled u64
  tickSize: string; // 1e9-scaled u64
  settled: boolean;
  spot1e9?: string; // last observed spot, for /markets display
  lastPushAt?: number; // ms epoch of the last successful price push
};

const markets = new Map<string, Market>();

// Seed from the bootstrap deployment. These may already be expired; oracle-roll retires
// them and rolls fresh ones. The cap defaults to the first bootstrapped oracle cap.
for (const o of ORACLES) {
  markets.set(o.oracleId, {
    oracleId: o.oracleId,
    capId: ORACLE_CAP_IDS[0] ?? '',
    underlying: o.underlying,
    expiryMs: o.expiryMs,
    minStrike: o.minStrike,
    tickSize: o.tickSize,
    settled: false,
  });
}

export const allMarkets = (): Market[] => [...markets.values()];

export const upsertMarket = (m: Market): void => {
  markets.set(m.oracleId, m);
};

export const getMarket = (oracleId: string): Market | undefined => markets.get(oracleId);

export const removeMarket = (oracleId: string): void => {
  markets.delete(oracleId);
};

// Markets a play can mint against right now: unsettled and far enough from expiry that the
// price-pusher is still keeping them fresh inside the safety window.
export const tradeableMarkets = (now: number, safetyMs: number): Market[] =>
  allMarkets().filter((m) => !m.settled && m.expiryMs - now > safetyMs);

export const liveByAsset = (asset: string, now: number, minRemainingMs: number): Market[] =>
  allMarkets().filter((m) => m.underlying === asset && !m.settled && m.expiryMs - now > minRemainingMs);

// The freshest on-chain spot for an asset, in display units, from the live oracle set. The
// price-pusher writes spot1e9 each tick (operator), market-sync reads it off chain every few seconds
// (follower). The follower chart serves this so the line the player watches is the price the round
// settles against. Picks the most recently observed live market; null if none is live yet.
export const assetSpot = (asset: string): number | null => {
  let best: Market | undefined;
  for (const m of markets.values()) {
    if (m.underlying !== asset || m.settled || !m.spot1e9) continue;
    const mp = m.lastPushAt ?? 0;
    const bp = best?.lastPushAt ?? 0;
    // Most recently observed; on a tie (market-sync stamps a whole tick with one timestamp) prefer the
    // nearest-expiry oracle, the one actually being traded, so the pick is deterministic across restarts.
    if (!best || mp > bp || (mp === bp && m.expiryMs < best.expiryMs)) best = m;
  }
  return best?.spot1e9 ? Number(best.spot1e9) / 1e9 : null;
};
