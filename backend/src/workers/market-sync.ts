// market-sync: follower-mode market discovery. When this backend is NOT the operator
// (PIPS_OPERATOR_ENABLED != true) it never creates oracles, so the in-memory market set would stay
// stuck on the (expired) bootstrap seed and every game would read "Market catching up". Instead we
// follow the chain: whoever IS the operator (the deployed backend) emits OracleActivated for every
// oracle it stands up, so we read those events, keep the ones still live (active, unsettled, far
// enough from expiry), recover each one's EXACT on-chain strike grid, and upsert them into the same
// market set the games read. The operator path (oracle-roll) maintains that set itself, so this only
// schedules as a follower.

import cron from 'node-cron';

import { EXPIRY_SAFETY_MS, MARKET_SYNC_CRON, OPERATOR_ENABLED, ORACLE_LIFETIME_MS } from '../config/main-config.ts';
import { PACKAGE_ID } from '../lib/sui/config.ts';
import { suiClient } from '../lib/sui/client.ts';
import { readOracle, readOracleGrid } from '../lib/sui/predict.ts';
import { allMarkets, removeMarket, upsertMarket } from '../lib/sui/markets.ts';

const ORACLE_ACTIVATED_EVENT = `${PACKAGE_ID}::oracle::OracleActivated`;
// Descending pages of activations to scan per tick. Live oracles are always the newest activations,
// and we stop early once a page predates any oracle that could still be live, so this is just a cap.
const SYNC_PAGE_CAP = 6;

type ActivatedEvent = { oracle_id: string; expiry: string; timestamp: string };

// Recent OracleActivated oracle ids whose expiry is still ahead. Walks events newest-first and stops
// once activations predate the max oracle lifetime (those oracles are certainly expired), so the scan
// is bounded regardless of how many oracles the operator has created over the deployment's life.
async function liveCandidateIds(now: number): Promise<string[]> {
  const cutoff = now - ORACLE_LIFETIME_MS - 60_000; // activated before this => long expired
  const ids = new Set<string>();
  let cursor: Parameters<typeof suiClient.queryEvents>[0]['cursor'] = null;
  for (let page = 0; page < SYNC_PAGE_CAP; page++) {
    const res = await suiClient.queryEvents({
      query: { MoveEventType: ORACLE_ACTIVATED_EVENT },
      cursor,
      limit: 50,
      order: 'descending',
    });
    let reachedOld = false;
    for (const e of res.data) {
      const pj = e.parsedJson as ActivatedEvent | undefined;
      if (!pj?.oracle_id) continue;
      if (Number(pj.timestamp) < cutoff) { reachedOld = true; continue; }
      if (Number(pj.expiry) > now + EXPIRY_SAFETY_MS) ids.add(pj.oracle_id);
    }
    if (reachedOld || !res.hasNextPage || !res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return [...ids];
}

let isRunning = false;

const sync = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;
  try {
    const t = Date.now();
    const ids = await liveCandidateIds(t);

    // Confirm each candidate on chain (active, unsettled, priced, room before expiry) and recover its
    // exact grid, then upsert. A single bad/gone oracle is skipped, never failing the whole tick.
    await Promise.all(
      ids.map(async (oracleId) => {
        try {
          const st = await readOracle(oracleId);
          if (!st || st.settled || !st.active || st.spot1e9 <= 0n) return;
          if (st.expiryMs - t <= EXPIRY_SAFETY_MS) return;
          const grid = await readOracleGrid(oracleId);
          if (!grid) return;
          upsertMarket({
            oracleId,
            capId: st.authorizedCapIds[0] ?? '', // followers never push/settle, so cap is informational
            underlying: st.underlying,
            expiryMs: st.expiryMs,
            minStrike: String(grid.minStrike),
            tickSize: String(grid.tickSize),
            settled: false,
            spot1e9: String(st.spot1e9),
            lastPushAt: t,
          });
        } catch {
          // transient read error on one oracle; the next tick re-reads it
        }
      }),
    );

    // Drop anything that has since expired/settled (incl. the stale bootstrap seed) so the map tracks
    // only what is live and can't grow without bound.
    for (const m of allMarkets()) {
      if (m.settled || m.expiryMs <= t) removeMarket(m.oracleId);
    }
  } catch (err) {
    console.error('[MarketSync] tick error:', err instanceof Error ? err.message : err);
  } finally {
    isRunning = false;
  }
};

export const startMarketSync = (): void => {
  if (OPERATOR_ENABLED) {
    console.log('[MarketSync] Operator enabled; oracle-roll owns the market set, follower sync not scheduled');
    return;
  }
  console.log(`[MarketSync] Follower mode: scheduled ${MARKET_SYNC_CRON}`);
  cron.schedule(MARKET_SYNC_CRON, sync);
  sync();
};
