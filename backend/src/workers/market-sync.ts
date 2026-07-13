// market-sync: follower-mode market discovery. When this backend is NOT the operator
// (PIPS_OPERATOR_ENABLED != true) it never creates oracles, so the in-memory market set would stay
// stuck on the (expired) bootstrap seed and every game would read "Market catching up". Instead we
// follow the chain: whoever IS the operator (the deployed backend) emits OracleActivated for every
// oracle it stands up, so we read those events, keep the ones still live (active, unsettled, far
// enough from expiry), recover each one's EXACT on-chain strike grid, and upsert them into the same
// market set the games read. The operator path (oracle-roll) maintains that set itself, so this only
// schedules as a follower.

import cron from 'node-cron';

import { EXPIRY_SAFETY_MS, IS_REAL_PREDICT, MARKET_SYNC_CRON, OPERATOR_ENABLED, ORACLE_LIFETIME_MS } from '../config/main-config.ts';
import { PACKAGE_ID } from '../lib/sui/config.ts';
import { REAL_BTC_ASSET } from '../lib/sui/config-real.ts';
import { graphqlClient } from '../lib/sui/client.ts';
import { readOracle, readOracleGrid } from '../lib/sui/predict.ts';
import {
  isMinuteExpiry,
  readActiveMarketIds,
  readBtcSpot,
  readMarketCoarse,
  readMarketEconomics,
} from '../lib/sui/predict-real.ts';
import { allMarkets, getMarket, removeMarket, upsertMarket } from '../lib/sui/markets.ts';

// Game asset symbol for the only underlying live on Mysten's testnet Predict (propbook id 1). The
// games route every selected asset to this BTC market in real mode; discovery tags it with the symbol
// the asset picker + assetSpot key on.
const REAL_BTC_GAME_ASSET = 'BTC';

const ORACLE_ACTIVATED_EVENT = `${PACKAGE_ID}::oracle::OracleActivated`;
// Descending pages of activations to scan per tick. Live oracles are always the newest activations,
// and we stop early once a page predates any oracle that could still be live, so this is just a cap.
const SYNC_PAGE_CAP = 6;

// Fullnode gRPC v2 has no event scan, so historical event discovery goes through GraphQL. `last`
// returns the newest N (ascending within the page); we walk pages backwards with `before`.
const ACTIVATED_EVENTS_QUERY = `query($type: String!, $last: Int!, $before: String) {
  events(last: $last, before: $before, filter: { type: $type }) {
    pageInfo { hasPreviousPage startCursor }
    nodes { contents { json } }
  }
}`;

type ActivatedEvent = { oracle_id: string; expiry: string; timestamp: string };
type ActivatedNode = { contents: { json: ActivatedEvent | null } | null };
type ActivatedEventsResult = {
  events: {
    pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
    nodes: ActivatedNode[];
  };
};

// Pick still-live oracle ids from one GraphQL page (oldest-first, iterated reversed for newest-first).
// `reachedOld` flags that this page reached activations older than any live oracle, so the caller stops
// paging. Pure so the migrated GraphQL parse is unit-testable against a captured response.
export function selectLiveOraclesFromPage(
  nodes: ActivatedNode[],
  now: number,
  cutoff: number,
): { ids: string[]; reachedOld: boolean } {
  const ids: string[] = [];
  let reachedOld = false;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const pj = nodes[i].contents?.json ?? undefined;
    if (!pj?.oracle_id) continue;
    if (Number(pj.timestamp) < cutoff) { reachedOld = true; continue; }
    if (Number(pj.expiry) > now + EXPIRY_SAFETY_MS) ids.push(pj.oracle_id);
  }
  return { ids, reachedOld };
}

// Recent OracleActivated oracle ids whose expiry is still ahead. Walks events newest-first and stops
// once activations predate the max oracle lifetime (those oracles are certainly expired), so the scan
// is bounded regardless of how many oracles the operator has created over the deployment's life.
async function liveCandidateIds(now: number): Promise<string[]> {
  const cutoff = now - ORACLE_LIFETIME_MS - 60_000; // activated before this => long expired
  const ids = new Set<string>();
  let before: string | null = null;
  for (let page = 0; page < SYNC_PAGE_CAP; page++) {
    const res: { data?: unknown } = await graphqlClient.query({
      query: ACTIVATED_EVENTS_QUERY,
      variables: { type: ORACLE_ACTIVATED_EVENT, last: 50, before },
    });
    const conn = (res.data as ActivatedEventsResult | undefined)?.events;
    if (!conn) break;
    const { ids: pageIds, reachedOld } = selectLiveOraclesFromPage(conn.nodes, now, cutoff);
    for (const id of pageIds) ids.add(id);
    if (reachedOld || !conn.pageInfo.hasPreviousPage || !conn.pageInfo.startCursor) break;
    before = conn.pageInfo.startCursor;
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

// Real-mode discovery (IS_REAL_PREDICT): Mysten owns the roll schedule and there is no operator role,
// so we always read the chain. Read the PoolVault's live market ids, keep the unsettled, unpaused, 1m
// BTC ones with room before expiry, read each one's economics, and upsert into the same market set the
// games read. No GraphQL event scan, no predict-server, no per-market cap.
let realRunning = false;

const realSync = async (): Promise<void> => {
  if (realRunning) return;
  realRunning = true;
  try {
    const t = Date.now();
    const underlyingId = REAL_BTC_ASSET?.propbookUnderlyingId ?? 1;
    // One live BS spot read per tick, stamped on every discovered BTC market so assetSpot('BTC') and
    // the eased chart feed track the price the round is marked against. Kept if a tick can't read it.
    const spot = await readBtcSpot();
    const ids = await readActiveMarketIds();

    await Promise.all(
      ids.map(async (marketId) => {
        try {
          const c = await readMarketCoarse(marketId);
          if (!c || c.settled || c.mintPaused) return;
          if (c.underlyingId !== underlyingId) return;
          if (!isMinuteExpiry(c.expiryMs)) return;
          if (c.expiryMs - t <= EXPIRY_SAFETY_MS) return;
          const e = await readMarketEconomics(marketId);
          const prev = getMarket(marketId);
          upsertMarket({
            oracleId: marketId,
            capId: '', // permissionless in real mode, no per-market cap
            underlying: REAL_BTC_GAME_ASSET,
            expiryMs: c.expiryMs,
            minStrike: '0', // unused in real mode; the tick codec drives strikes
            tickSize: e.tickSizeRaw.toString(),
            settled: false,
            spot1e9: spot ? spot.spot1e9.toString() : prev?.spot1e9,
            lastPushAt: spot ? t : prev?.lastPushAt,
            admissionTickSizeRaw: e.admissionTickSizeRaw.toString(),
            maxLeverage1e9: e.maxLeverage1e9.toString(),
            liquidationLtv1e9: e.liquidationLtv1e9.toString(),
          });
        } catch {
          // transient read error on one market; the next tick re-reads it
        }
      }),
    );

    for (const m of allMarkets()) {
      if (m.settled || m.expiryMs <= t) removeMarket(m.oracleId);
    }
  } catch (err) {
    console.error('[MarketSync] real tick error:', err instanceof Error ? err.message : err);
  } finally {
    realRunning = false;
  }
};

export const startMarketSync = (): void => {
  if (IS_REAL_PREDICT) {
    // No operator role in real mode: discovery always runs, regardless of OPERATOR_ENABLED.
    console.log(`[MarketSync] Real-Predict discovery: scheduled ${MARKET_SYNC_CRON}`);
    cron.schedule(MARKET_SYNC_CRON, realSync);
    realSync();
    return;
  }
  if (OPERATOR_ENABLED) {
    console.log('[MarketSync] Operator enabled; oracle-roll owns the market set, follower sync not scheduled');
    return;
  }
  console.log(`[MarketSync] Follower mode: scheduled ${MARKET_SYNC_CRON}`);
  cron.schedule(MARKET_SYNC_CRON, sync);
  sync();
};
