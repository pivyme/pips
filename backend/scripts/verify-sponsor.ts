// Gas sponsorship proof. Runs directly against the chain (no backend, no Privy) so it isolates the
// one thing that must be true: a sender holding ZERO SUI can transact, with the sponsor paying gas
// from its address balance, and many such txs can run AT ONCE without ever colliding on a gas coin.
//
//   cd backend && bun scripts/verify-sponsor.ts [concurrency]   # default 8
//
// What it asserts:
//   1. Single sponsored tx: a throwaway user with 0 SUI sends a tx, it lands, the user still has 0
//      SUI afterward, and the sponsor's balance is what moved.
//   2. Concurrency: N distinct users fire a sponsored tx each, all at once, and ALL succeed. With no
//      owned gas coin in any tx, there is nothing to equivocate on, which is the whole point.

import '../dotenv.ts';

import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import { suiClient } from '../src/lib/sui/client.ts';
import { getSuiBalanceRaw, ensureSponsorFunded } from '../src/lib/sui/gas.ts';
import { SPONSOR_ENABLED, sponsorAddress, applySponsorGas, signAsSponsor } from '../src/lib/sui/sponsor.ts';

const N = Number(process.argv[2]) || 8;
const SUI = (mist: bigint) => (Number(mist) / 1e9).toFixed(4);

if (!SPONSOR_ENABLED) {
  console.error('Sponsorship is OFF. Set GAS_SPONSORSHIP_WALLET_PK in backend/.env first.');
  process.exit(1);
}

// Build + sign one sponsored tx for `user`: a trivial Clock read, so the only thing being proven is
// who pays gas. sender = user (signs, needs no SUI), gas owner = sponsor (empty payment = address
// balance). Returns the bytes + both signatures, ready to submit.
async function buildSponsored(user: Ed25519Keypair) {
  const tx = new Transaction();
  tx.moveCall({ target: '0x2::clock::timestamp_ms', arguments: [tx.object('0x6')] });
  tx.setSender(user.getPublicKey().toSuiAddress());
  tx.setGasPrice(await suiClient.getReferenceGasPrice());
  applySponsorGas(tx);
  const bytes = await tx.build({ client: suiClient });
  const userSig = (await user.signTransaction(bytes)).signature;
  const sponsorSig = await signAsSponsor(bytes);
  return { bytes, signature: [userSig, sponsorSig] as string[] };
}

async function submit(bytes: Uint8Array, signature: string[]) {
  const res = await suiClient.executeTransactionBlock({
    transactionBlock: bytes,
    signature,
    options: { showEffects: true },
  });
  return res.effects?.status?.status === 'success'
    ? { ok: true as const, digest: res.digest }
    : { ok: false as const, status: JSON.stringify(res.effects?.status ?? res) };
}

console.log(`Gas sponsor: ${sponsorAddress}`);
await ensureSponsorFunded();
const sponsorStart = await getSuiBalanceRaw(sponsorAddress);
console.log(`Sponsor balance: ${SUI(sponsorStart)} SUI\n`);
if (sponsorStart === 0n) {
  console.error('Sponsor balance is 0 and could not be funded (is the operator funded on this node?).');
  process.exit(1);
}

let failed = false;

// --- Test 1: single sponsored tx from a zero-SUI user ----------------------------------------
{
  const user = Ed25519Keypair.generate();
  const addr = user.getPublicKey().toSuiAddress();
  const before = await getSuiBalanceRaw(addr);
  console.log(`Test 1  user ${addr.slice(0, 10)}… starts with ${SUI(before)} SUI`);

  const { bytes, signature } = await buildSponsored(user);
  const r = await submit(bytes, signature);
  const after = await getSuiBalanceRaw(addr);

  if (r.ok && before === 0n && after === 0n) {
    console.log(`Test 1  ✓ landed (${r.digest.slice(0, 10)}…), user still holds 0 SUI\n`);
  } else {
    failed = true;
    console.log(`Test 1  ✗ ${r.ok ? `user SUI changed (${SUI(before)}→${SUI(after)})` : r.status}\n`);
  }
}

// --- Test 2: N sponsored txs at once, all from distinct zero-SUI users ------------------------
{
  console.log(`Test 2  firing ${N} sponsored txs concurrently from ${N} distinct users…`);
  const users = Array.from({ length: N }, () => Ed25519Keypair.generate());
  // Build + sign all first, then submit together so they genuinely hit the node at once.
  const prepared = await Promise.all(users.map(buildSponsored));
  const results = await Promise.all(prepared.map((p) => submit(p.bytes, p.signature).catch((e) => ({ ok: false as const, status: e instanceof Error ? e.message : String(e) }))));

  const okCount = results.filter((r) => r.ok).length;
  results.forEach((r, i) => {
    if (!r.ok) console.log(`        #${i + 1} ✗ ${r.status}`);
  });
  if (okCount === N) {
    console.log(`Test 2  ✓ ${okCount}/${N} landed concurrently (no gas-coin contention)\n`);
  } else {
    failed = true;
    console.log(`Test 2  ✗ only ${okCount}/${N} landed\n`);
  }
}

const sponsorEnd = await getSuiBalanceRaw(sponsorAddress);
console.log(`Sponsor balance: ${SUI(sponsorStart)} → ${SUI(sponsorEnd)} SUI (paid ${SUI(sponsorStart - sponsorEnd)} SUI net of rebates)`);

if (failed) {
  console.log('\n✗ FAILED');
  process.exit(1);
}
console.log('\n✓ PASS — zero-SUI users transact, sponsor pays, and concurrent plays never collide.');
process.exit(0);
