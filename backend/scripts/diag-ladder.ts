// Read-only: mirror market-sync's discovery against the live chain to see the BTC oracle ladder
// health right now. Does NOT touch the operator. Run: bun scripts/diag-ladder.ts
import { suiClient } from '../src/lib/sui/client.ts';
import { readOracle } from '../src/lib/sui/predict.ts';
import { PACKAGE_ID } from '../src/lib/sui/config.ts';
import { EXPIRY_SAFETY_MS, ORACLE_LIFETIME_MS } from '../src/config/main-config.ts';

const EVT = `${PACKAGE_ID}::oracle::OracleActivated`;

async function snapshot() {
  const now = Date.now();
  const cutoff = now - ORACLE_LIFETIME_MS - 60_000;
  const ids = new Set<string>();
  let cursor: any = null;
  for (let page = 0; page < 6; page++) {
    const res = await suiClient.queryEvents({ query: { MoveEventType: EVT }, cursor, limit: 50, order: 'descending' });
    let old = false;
    for (const e of res.data) {
      const pj = e.parsedJson as any;
      if (!pj?.oracle_id) continue;
      if (Number(pj.timestamp) < cutoff) { old = true; continue; }
      if (Number(pj.expiry) > now + EXPIRY_SAFETY_MS) ids.add(pj.oracle_id);
    }
    if (old || !res.hasNextPage || !res.nextCursor) break;
    cursor = res.nextCursor;
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
