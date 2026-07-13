// Client for a third-party Predict discovery/pricing API (verified against Mysten's own
// predict-server on their official testnet deployment: https://predict-server.testnet.mystenlabs.com).
// Used instead of our GraphQL event scan + chain reads (market-sync.ts) when we don't own the
// deployment's AdminCap/oracle caps, so we can't assume its internal object layout for the strike
// grid. The server already returns min_strike/tick_size/expiry/status per oracle directly.

import { PREDICT_SERVER_URL } from '../../config/main-config.ts';

export type PredictServerOracle = {
  predict_id: string;
  oracle_id: string;
  oracle_cap_id: string;
  underlying_asset: string;
  expiry: number;
  min_strike: number;
  tick_size: number;
  status: 'active' | 'settled';
  activated_at: number | null;
  settlement_price: number | null;
  settled_at: number | null;
};

export type PredictServerOracleState = {
  oracle: PredictServerOracle;
  latest_price: { spot: number; forward: number; onchain_timestamp: number } | null;
};

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${PREDICT_SERVER_URL}${path}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`predict-server ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

// Every oracle the server knows about for this predict id (settled + active). Callers filter.
export const listOracles = (predictId: string): Promise<PredictServerOracle[]> =>
  getJson(`/predicts/${predictId}/oracles`);

// Only the currently tradeable ones.
export async function listActiveOracles(predictId: string): Promise<PredictServerOracle[]> {
  const all = await listOracles(predictId);
  return all.filter((o) => o.status === 'active');
}

// Live spot/forward for one oracle. Returns null if the server has no price event for it yet.
export async function getOracleSpot(oracleId: string): Promise<number | null> {
  const state = await getJson<PredictServerOracleState>(`/oracles/${oracleId}/state`);
  return state.latest_price?.spot ?? null;
}
