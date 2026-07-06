// Real on-chain Moonshot verification, self-contained (no running server needed). Moonshot is the
// directional twin of Lucky: same binary mint/redeem path, but the player picks the side + reach. This
// drives ONE real round end to end against the live chain: sync the deployed operator's live oracles
// from chain (follower discovery, read-only), resolve + MINT a moonshot binary signed by a real user's
// embedded wallet (executeForUser, never the operator key, so it can't race the deployed ladder), wait
// for the background mint to land 'open', then REDEEM (early cash-out) at the live mark. Verifies the DB
// row at each step and prints the mint/redeem explorer links.
//
//   cd backend && bun scripts/bench-moonshot.ts [side] [reach] [stake]
//   side = long|short (default long), reach = 2|3|5|10|25 (default 5), stake in $ (default 1)
//
// It signs as a provisioned privy user (their own wallet + gas/sponsorship), so it never touches the
// operator's caps or gas coins. It does NOT settle (no executeAsOperator), so it's safe to run while the
// deployed operator is live.

import '../dotenv.ts';

import { EXPIRY_SAFETY_MS, ORACLE_LIFETIME_MS } from '../src/config/main-config.ts';
import { PACKAGE_ID } from '../src/lib/sui/config.ts';
import { graphqlClient, explorerTxUrl } from '../src/lib/sui/client.ts';
import { readOracle, readOracleGrid } from '../src/lib/sui/predict.ts';
import { allMarkets, removeMarket, upsertMarket } from '../src/lib/sui/markets.ts';
import { prismaQuery } from '../src/lib/prisma.ts';
import { createPlay, cashoutPlay, playableBalanceRaw } from '../src/services/plays.ts';
import { liveAssets } from '../src/services/games.ts';

const sideArg = (process.argv[2] ?? 'long').toLowerCase();
const SIDE: 'up' | 'down' = sideArg === 'short' || sideArg === 'down' ? 'down' : 'up';
const REACH = Number(process.argv[3]) || 5;
const STAKE = Number(process.argv[4]) || 1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (raw: bigint) => (Number(raw) / 1e6).toFixed(2);

// One-shot follower market sync (replicates workers/market-sync.ts), so resolveMoonshot can find a live
// oracle the deployed operator stood up. Read-only: queries OracleActivated, confirms each on chain.
async function syncMarketsOnce(): Promise<void> {
  const t = Date.now();
  const cutoff = t - ORACLE_LIFETIME_MS - 60_000;
  const ids = new Set<string>();
  // Historical event scan via GraphQL (fullnode gRPC has none). newest-first: last/before pagination.
  const EVENTS_Q = `query($type: String!, $last: Int!, $before: String) {
    events(last: $last, before: $before, filter: { type: $type }) {
      pageInfo { hasPreviousPage startCursor }
      nodes { contents { json } }
    }
  }`;
  let before: string | null = null;
  for (let page = 0; page < 6; page++) {
    const res: { data?: unknown } = await graphqlClient.query({
      query: EVENTS_Q,
      variables: { type: `${PACKAGE_ID}::oracle::OracleActivated`, last: 50, before },
    });
    const conn = (res.data as any)?.events;
    if (!conn) break;
    let reachedOld = false;
    for (let i = conn.nodes.length - 1; i >= 0; i--) {
      const pj = conn.nodes[i].contents?.json as { oracle_id?: string; expiry?: string; timestamp?: string } | undefined;
      if (!pj?.oracle_id) continue;
      if (Number(pj.timestamp) < cutoff) { reachedOld = true; continue; }
      if (Number(pj.expiry) > t + EXPIRY_SAFETY_MS) ids.add(pj.oracle_id);
    }
    if (reachedOld || !conn.pageInfo.hasPreviousPage || !conn.pageInfo.startCursor) break;
    before = conn.pageInfo.startCursor;
  }
  await Promise.all(
    [...ids].map(async (oracleId) => {
      try {
        const st = await readOracle(oracleId);
        if (!st || st.settled || !st.active || st.spot1e9 <= 0n) return;
        if (st.expiryMs - t <= EXPIRY_SAFETY_MS) return;
        const grid = await readOracleGrid(oracleId);
        if (!grid) return;
        upsertMarket({
          oracleId,
          capId: st.authorizedCapIds[0] ?? '',
          underlying: st.underlying,
          expiryMs: st.expiryMs,
          minStrike: String(grid.minStrike),
          tickSize: String(grid.tickSize),
          settled: false,
          spot1e9: String(st.spot1e9),
          lastPushAt: t,
        });
      } catch {
        // skip a bad oracle
      }
    }),
  );
  for (const m of allMarkets()) if (m.settled || m.expiryMs <= t) removeMarket(m.oracleId);
}

console.log(`\nMoonshot on-chain check: ${SIDE === 'up' ? 'LONG' : 'SHORT'} ${REACH}x at $${STAKE}\n`);

console.log('1) Syncing live oracles from chain...');
await syncMarketsOnce();
const assets = liveAssets();
console.log(`   live markets: ${allMarkets().length} oracle(s), assets: ${assets.join(', ') || '(none)'}`);
if (assets.length === 0) {
  console.error('   ✗ no live markets right now (operator ladder empty / devnet wiped). Cannot mint.');
  process.exit(1);
}
const asset = assets[0];

// Pick a provisioned privy user with enough spendable chips for the stake.
let user = null;
for (const u of await prismaQuery.user.findMany({
  where: { privyWalletId: { not: null }, suiPublicKey: { not: null }, predictManagerId: { not: null } },
  orderBy: { createdAt: 'desc' },
})) {
  const bal = await playableBalanceRaw(u).catch(() => 0n);
  if (bal >= BigInt(Math.ceil(STAKE * 1e6))) { user = u; break; }
}
if (!user) {
  console.error('   ✗ no provisioned privy user has enough chips for the stake.');
  process.exit(1);
}
console.log(`   user ${user.address.slice(0, 12)}…  chips $${fmt(await playableBalanceRaw(user))}`);

console.log(`\n2) Minting a real Moonshot binary (${asset} ${SIDE === 'up' ? 'LONG' : 'SHORT'} ${REACH}x)...`);
const t0 = performance.now();
const { play } = await createPlay(user, { game: 'moonshot', stake: STAKE, asset, side: SIDE, reach: REACH });
console.log(`   dealt in ${(performance.now() - t0).toFixed(0)}ms: id=${play.id} status=${play.status} mult=${play.multiplier.toFixed(2)}x strike=${play.market.strike} entry=$${play.entryValue}`);

// Wait for the background mint to land 'open' (or 'error'). The mint runs in THIS process.
let row = await prismaQuery.play.findUnique({ where: { id: play.id } });
for (let i = 0; i < 24 && row?.status === 'pending'; i++) {
  await sleep(1000);
  row = await prismaQuery.play.findUnique({ where: { id: play.id } });
}
if (!row || row.status !== 'open') {
  console.error(`   ✗ mint did not open (status=${row?.status}). Chips are safe (atomic mint).`);
  process.exit(1);
}
console.log(`   ✓ MINTED on-chain: status=open  cost=$${fmt(row.entryCost)}  mult=${(row.multiplier ?? 0).toFixed(2)}x`);
console.log(`     mint tx: ${row.txMint}`);
console.log(`     ${row.txMint ? explorerTxUrl(row.txMint) : ''}`);

// HOLD=1: don't cash out, ride to the buzzer and let the deployed operator settle it (the on-chain
// position is a plain binary, so the operator's settle worker resolves it correctly without knowing
// "moonshot"). Proves the win/lose settlement half. Otherwise do an early cash-out (the redeem half).
const HOLD = process.env.HOLD === '1';
let final: typeof row | null = row;
if (HOLD) {
  console.log(`\n3) Holding to the buzzer; waiting for the deployed operator to settle...`);
  const expiry = Number(row.expiry);
  for (let i = 0; i < 60; i++) {
    await sleep(2500);
    final = await prismaQuery.play.findUnique({ where: { id: play.id } });
    const left = Math.max(0, Math.round((expiry - Date.now()) / 1000));
    process.stdout.write(`\r   status=${final?.status}  (expiry in ${left}s, t+${(i + 1) * 2.5}s)   `);
    if (final && final.status !== 'open') break;
  }
  console.log('');
  console.log(`   settled: status=${final?.status}  settlePrice=${final?.settlePrice}  payout=$${fmt(final?.payout ?? 0n)}  pnl=$${fmt(final?.pnl ?? 0n)}`);
  console.log(`     settle tx: ${final?.txSettle ?? '(operator)'}  redeem tx: ${final?.txRedeem ?? '(loss, none)'}`);
} else {
  console.log(`\n3) Cashing out (real redeem at the live mark)...`);
  const cash = await cashoutPlay(user, play.id);
  final = await prismaQuery.play.findUnique({ where: { id: play.id } });
  console.log(`   ✓ ${cash.play.status}: payout=$${cash.play.payout ?? '?'}  pnl=$${cash.play.pnl}`);
  console.log(`     redeem tx: ${final?.txRedeem}`);
  console.log(`     ${final?.txRedeem ? explorerTxUrl(final.txRedeem) : ''}`);
}

console.log(`\n4) DB row verification:`);
console.log(`   game=${final?.game}  status=${final?.status}  side=${final?.side}  strike=${final?.strike}`);
console.log(`   entryCost=$${fmt(final?.entryCost ?? 0n)}  payout=$${fmt(final?.payout ?? 0n)}  pnl=$${fmt(final?.pnl ?? 0n)}  txMint=${final?.txMint ? 'set' : 'MISSING'}`);

const terminal = HOLD ? final?.status === 'won' || final?.status === 'lost' : final?.status === 'cashed_out';
const ok = final?.game === 'moonshot' && !!terminal && !!final?.txMint;
console.log(ok ? `\n✓ MOONSHOT VERIFIED ON-CHAIN (real ${HOLD ? 'mint + settle' : 'mint + redeem'}, DB consistent)\n` : `\n✗ verification incomplete\n`);
process.exit(ok ? 0 : 1);
