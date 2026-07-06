// Per-hop latency profiler for the Lucky play path. The bench measures end-to-end; this isolates
// every remote round trip so we can see exactly where a play's seconds go: the solve devInspects,
// the tx.build gas-budget dry-run, the Privy SaaS sign, and the submit. It also times the same
// devInspect against the Cloudflare-proxied URL vs the node origin to quantify proxy overhead.
//
//   cd backend && bun dev                 # primary server keeps the oracle ladder live
//   cd backend && bun scripts/profile-play.ts
//
// Read-only except for ONE real play it fires to grab a currently-live oracle + a valid strike.

import '../dotenv.ts';
import jwt from 'jsonwebtoken';
import { Transaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';

import { JWT_SECRET, APP_PORT, SUI_FULLNODE_URL } from '../src/config/main-config.ts';
import { prismaQuery } from '../src/lib/prisma.ts';
import { suiClient } from '../src/lib/sui/client.ts';
import { NETWORK, PREDICT_ID, CLOCK, target } from '../src/lib/sui/config.ts';
import { getDusdcBalanceRaw } from '../src/lib/sui/dusdc.ts';
import { getManagerBalanceRaw, readOracle, previewBinaryBatch, buildMint, type Side } from '../src/lib/sui/predict.ts';
import { signSuiTxWithPrivy } from '../src/lib/sui/privy.ts';
import { operatorAddress } from '../src/lib/sui/signer.ts';

const BASE = `http://localhost:${APP_PORT}`;
const ORIGIN = process.env.PIPS_DEPLOY_RPC || 'http://95.111.237.44:9000';
const now = () => performance.now();

// Time a thunk N times, return {min, median, all}. Errors are caught and reported as the label.
async function bench(label: string, n: number, fn: () => Promise<unknown>): Promise<void> {
  const ts: number[] = [];
  let err = '';
  for (let i = 0; i < n; i++) {
    const s = now();
    try {
      await fn();
      ts.push(now() - s);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      ts.push(now() - s);
    }
  }
  ts.sort((a, b) => a - b);
  const med = ts[Math.floor(ts.length / 2)];
  const min = ts[0];
  const max = ts[ts.length - 1];
  const tag = err ? `  ⚠ ${err.slice(0, 70)}` : '';
  console.log(`${label.padEnd(34)} min ${min.toFixed(0).padStart(5)}  med ${med.toFixed(0).padStart(5)}  max ${max.toFixed(0).padStart(5)} ms${tag}`);
}

const user =
  (await prismaQuery.user.findFirst({
    where: { privyWalletId: { not: null }, suiPublicKey: { not: null }, predictManagerId: { not: null } },
    orderBy: { createdAt: 'desc' },
  })) ?? (await prismaQuery.user.findFirst({ where: { predictManagerId: { not: null } }, orderBy: { createdAt: 'asc' } }));

if (!user) {
  console.error('No provisioned user found. Sign in once first.');
  process.exit(1);
}

console.log(`Profiling as ${user.address.slice(0, 10)}…  node=${SUI_FULLNODE_URL}  privyWallet=${user.privyWalletId ? 'yes' : 'no'}\n`);

// --- One real play through HTTP to grab a live oracle + a valid strike/quantity. ---
const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '1h' });
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const t0 = now();
const r = await fetch(`${BASE}/games/lucky/play`, { method: 'POST', headers: H, body: JSON.stringify({ stake: 5 }) });
const playTotal = now() - t0;
const j = (await r.json()) as { data?: { play?: { id: string } } };
if (!j.data?.play) {
  console.error('Seed play failed:', JSON.stringify(j));
  process.exit(1);
}
console.log(`Seed play (full /games/lucky/play round trip): ${playTotal.toFixed(0)}ms\n`);

const playRow = await prismaQuery.play.findUnique({ where: { id: j.data.play.id } });
if (!playRow) { console.error('play row missing'); process.exit(1); }
const key = JSON.parse(playRow.marketKey) as { oracleId: string; expiry: string; strike1e9: string; side: Side; quantity: string };
const oracleId = key.oracleId;
const expiryMs = Number(key.expiry);
const side: Side = key.side;
const strike1e9 = BigInt(key.strike1e9);
const managerId = user.predictManagerId!;

const oracle = await readOracle(oracleId);
console.log(`Live oracle ${oracleId.slice(0, 10)}…  asset=${oracle?.underlying}  side=${side}  expiry in ${((expiryMs - Date.now()) / 1000).toFixed(0)}s\n`);

// 128 dense scan probes + 6 sizing probes (mirrors the solver's two devInspects). Strikes near the
// play's strike; mintability is irrelevant to the latency we measure.
const scanProbes = Array.from({ length: 128 }, (_, i) => ({ strike1e9: strike1e9 + BigInt(i - 64) * 200_000_000n, quantity: 1_000_000n }));
const sizeProbes = Array.from({ length: 6 }, (_, i) => ({ strike1e9, quantity: BigInt(900 + i * 30) * 1000n }));

// An origin-pointed client (bypasses Cloudflare) to measure proxy overhead on the same devInspect.
const originClient = new SuiGrpcClient({ network: NETWORK, baseUrl: ORIGIN });

// Build a representative mint tx (tiny qty so it always prices) the way executeForUser does.
function freshMintTx(): Transaction {
  const tx = new Transaction();
  buildMint(tx, managerId, { oracleId, expiryMs, strike1e9, side, quantity: 1000n });
  tx.setSender(user!.address);
  return tx;
}

console.log('--- per-hop latency (privy play path) ---');
await bench('getDusdcBalanceRaw (getBalance)', 5, () => getDusdcBalanceRaw(user.address));
await bench('getManagerBalanceRaw (devInspect)', 5, () => getManagerBalanceRaw(managerId));
await bench('readOracle (getObject)', 5, () => readOracle(oracleId));
await bench('scan 128 probes (devInspect)', 5, () => previewBinaryBatch(oracleId, expiryMs, side, scanProbes));
await bench('size 6 probes (devInspect)', 5, () => previewBinaryBatch(oracleId, expiryMs, side, sizeProbes));
await bench('scan 128 @ ORIGIN (no cloudflare)', 5, async () => {
  const tx = new Transaction();
  for (const p of scanProbes) {
    const k = tx.moveCall({ target: target('market_key', side === 'up' ? 'up' : 'down'), arguments: [tx.pure.id(oracleId), tx.pure.u64(BigInt(expiryMs)), tx.pure.u64(p.strike1e9)] });
    tx.moveCall({ target: target('predict', 'get_trade_amounts'), arguments: [tx.object(PREDICT_ID), tx.object(oracleId), k, tx.pure.u64(p.quantity), tx.object(CLOCK)] });
  }
  tx.setSender(operatorAddress);
  await originClient.simulateTransaction({ transaction: tx, checksEnabled: false });
});

const gasPrice = BigInt((await suiClient.getReferenceGasPrice()).referenceGasPrice);
await bench('tx.build NO budget (dry-run)', 3, async () => {
  const tx = freshMintTx();
  tx.setGasPrice(gasPrice);
  await tx.build({ client: suiClient });
});
await bench('tx.build PINNED budget (no dry-run)', 3, async () => {
  const tx = freshMintTx();
  tx.setGasPrice(gasPrice);
  tx.setGasBudget(1_000_000_000n);
  await tx.build({ client: suiClient });
});

// Privy sign on real built bytes (read-only, signs but never submits).
if (user.privyWalletId && user.suiPublicKey) {
  const tx = freshMintTx();
  tx.setGasPrice(gasPrice);
  tx.setGasBudget(1_000_000_000n);
  const txBytes = await tx.build({ client: suiClient });
  await bench('signSuiTxWithPrivy (Privy SaaS)', 3, () => signSuiTxWithPrivy({ walletId: user.privyWalletId!, publicKey: user.suiPublicKey!, txBytes }));
}

console.log('\nDone.');
process.exit(0);
