// Read-only: mirror market-sync's discovery against the live chain to see the BTC oracle ladder
// health right now. Does NOT touch the operator. Run: bun scripts/diag-ladder.ts
import { graphqlClient } from '../src/lib/sui/client.ts';
import { readOracle } from '../src/lib/sui/predict.ts';
import { PACKAGE_ID } from '../src/lib/sui/config.ts';
import { EXPIRY_SAFETY_MS, ORACLE_LIFETIME_MS } from '../src/config/main-config.ts';

const EVT = `${PACKAGE_ID}::oracle::OracleActivated`;
// Historical event scan is GraphQL now (fullnode gRPC has none). newest-first via last/before.
const EVENTS_Q = `query($type: String!, $last: Int!, $before: String) {
  events(last: $last, before: $before, filter: { type: $type }) {
    pageInfo { hasPreviousPage startCursor }
    nodes { contents { json } }
  }
}`;

async function snapshot() {
  const now = Date.now();
  const cutoff = now - ORACLE_LIFETIME_MS - 60_000;
  const ids = new Set<string>();
  let before: string | null = null;
  for (let page = 0; page < 6; page++) {
    const res: { data?: unknown } = await graphqlClient.query({ query: EVENTS_Q, variables: { type: EVT, last: 50, before } });
    const conn = (res.data as any)?.events;
    if (!conn) break;
    let old = false;
    for (let i = conn.nodes.length - 1; i >= 0; i--) {
      const pj = conn.nodes[i].contents?.json;
      if (!pj?.oracle_id) continue;
      if (Number(pj.timestamp) < cutoff) { old = true; continue; }
      if (Number(pj.expiry) > now + EXPIRY_SAFETY_MS) ids.add(pj.oracle_id);
    }
    if (old || !conn.pageInfo.hasPreviousPage || !conn.pageInfo.startCursor) break;
    before = conn.pageInfo.startCursor;
  }

  const states = await Promise.all([...ids].map((id) => readOracle(id).catch(() => null)));
  const byAsset = new Map<string, number[]>();
  for (const st of states) {
    if (!st || st.settled || !st.active || st.spot1e9 <= 0n) continue;
    const remain = st.expiryMs - now;
    if (remain <= EXPIRY_SAFETY_MS) continue;
    if (!byAsset.has(st.underlying)) byAsset.set(st.underlying, []);
    byAsset.get(st.underlying)!.push(Math.round(remain / 1000));
  }
  const parts = [...byAsset.entries()].map(([a, secs]) => `${a}:${secs.length} [${secs.sort((x, y) => x - y).join(',')}s]`);
  const t = new Date(now).toISOString().slice(11, 19);
  console.log(`${t}  candidates=${ids.size}  ${parts.join('  ') || 'NO LIVE MARKETS'}`);
}

for (let i = 0; i < 10; i++) {
  await snapshot();
  await new Promise((r) => setTimeout(r, 2500));
}
