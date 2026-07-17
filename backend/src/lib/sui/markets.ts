// In-memory cache of the live market set: market-sync keeps it true (adds/drops the live 1m BTC markets it
// discovers from chain), settle and /markets read it each tick. Starts empty; market-sync populates it.

export type Market = {
  oracleId: string; // the ExpiryMarket object id.
  capId: string; // '' (permissionless real Predict, no cap).
  underlying: string;
  expiryMs: number;
  minStrike: string; // unused ('0'); the tick codec drives strikes.
  tickSize: string; // raw-price tick_size (BTC 1e7 = $0.01).
  settled: boolean;
  spot1e9?: string; // last observed spot, for /markets display
  lastPushAt?: number; // ms epoch of the last successful spot read
  // Market economics from readMarketEconomics.
  admissionTickSizeRaw?: string; // coarser mint-boundary step (BTC 1e9 = $1)
  maxLeverage1e9?: string; // max_admission_leverage (BTC 3e9 = 3.0x)
  liquidationLtv1e9?: string; // liquidation_ltv (BTC 0.85e9)
};

const markets = new Map<string, Market>();

export const allMarkets = (): Market[] => [...markets.values()];

export const upsertMarket = (m: Market): void => {
  markets.set(m.oracleId, m);
};

export const getMarket = (oracleId: string): Market | undefined => markets.get(oracleId);

export const removeMarket = (oracleId: string): void => {
  markets.delete(oracleId);
};

// Markets a play can mint against right now: unsettled and far enough from expiry to stay live inside the safety window.
export const tradeableMarkets = (now: number, safetyMs: number): Market[] =>
  allMarkets().filter((m) => !m.settled && m.expiryMs - now > safetyMs);

export const liveByAsset = (asset: string, now: number, minRemainingMs: number): Market[] =>
  allMarkets().filter((m) => m.underlying === asset && !m.settled && m.expiryMs - now > minRemainingMs);

// Freshest on-chain spot for an asset, in display units, from the live oracle set (Mysten's oracle writes it
// on chain, market-sync reads it off chain, so the chart matches what the round settles against). Picks the most recently observed live market, null if none is live yet.
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
