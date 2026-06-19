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

// Route a LUCKY play to the live oracle expiring nearest to `targetMs` (now + the round
// length) among those still tradeable (life > safetyMs), so a fixed ~30s round settles at the
// oracle's expiry. Never one oracle per play (gotcha #11). Returns undefined if none are live.
export const nearestOracle = (asset: string, now: number, targetMs: number, safetyMs: number): Market | undefined => {
  const live = liveByAsset(asset, now, safetyMs);
  if (live.length === 0) return undefined;
  return live.reduce((best, m) => (Math.abs(m.expiryMs - targetMs) < Math.abs(best.expiryMs - targetMs) ? m : best));
};
