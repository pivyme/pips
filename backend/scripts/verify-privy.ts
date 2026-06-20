// Phase 12 gate: prove the Privy server-signing recipe end to end against the live localnet,
// without a browser. It is the one subtle correctness point of the Privy swap (LUCKY.md §6):
//
//   does Privy's ed25519 rawSign over our blake2b256 intent digest yield a signature Sui accepts,
//   through the exact production path the API uses (executeForUser -> signSuiTxWithPrivy)?
//
// What it proves, all signed by a real Privy embedded Sui wallet under the app's session signer:
//   1. Provision/fetch the embedded Sui wallet, its public key + walletId (the address Privy reports
//      matches the one we derive from the key, so the signature will verify against the sender).
//   2. create_manager  -> the onboarding tx (a real Predict mutation) lands.
//   3. mint            -> fund the manager from the wallet + open a binary position.
//   4. redeem          -> cash the position out at the live mark.
// A green run is the green light to wire Privy plays.
//
// It runs fully headless: with no SPIKE_PRIVY_* env it provisions a server-owned wallet via the
// authorization key (the same key that, in production, the user grants as a session signer on their
// own wallet). To pin a specific browser-created wallet instead, set SPIKE_PRIVY_WALLET_ID /
// SPIKE_PRIVY_PUBLIC_KEY / SPIKE_PRIVY_ADDRESS. The signing recipe is identical either way.
//
// Prereqs:
//   - PIPS_AUTH_MODE=privy, PRIVY_APP_ID / PRIVY_APP_SECRET / PRIVY_AUTHORIZATION_KEY_ID /
//     PRIVY_AUTHORIZATION_PRIVATE_KEY set in backend/.env
//   - the local Sui node up + operator funded (free SUI + DUSDC on localnet)
//
// Run from backend/:  PIPS_AUTH_MODE=privy bun run scripts/verify-privy.ts

import '../dotenv.ts';

import { Transaction, coinWithBalance } from '@mysten/sui/transactions';

import { AUTH_MODE } from '../src/config/main-config.ts';
import { suiClient, explorerTxUrl } from '../src/lib/sui/client.ts';
import { operatorAddress } from '../src/lib/sui/signer.ts';
import { ORACLE_CAP_IDS, DUSDC_TYPE, gridForSpot, usd1e9, toDusdcRaw } from '../src/lib/sui/config.ts';
import { fetchSpot } from '../src/lib/pyth.ts';
import { fundSui, getSuiBalanceRaw } from '../src/lib/sui/gas.ts';
import { mintDusdc, getDusdcBalance } from '../src/lib/sui/dusdc.ts';
import {
  provisionServerSuiWallet,
  suiAddressForPublicKey,
  type ProvisionedWallet,
} from '../src/lib/sui/privy.ts';
import {
  buildCreateOracle,
  buildActivateOracle,
  appendPriceUpdate,
  buildCreateManager,
  buildDeposit,
  buildMint,
  buildRedeem,
  previewMint,
  getManagerBalanceRaw,
  readOracle,
  type BinaryParams,
} from '../src/lib/sui/predict.ts';
import { executeForUser, executeAsOperator } from '../src/lib/sui/execute.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sui = (raw: bigint): string => (Number(raw) / 1e9).toFixed(4);
const usd = (raw: bigint): string => `$${(Number(raw) / 1e6).toFixed(2)}`;

let failed = false;
const pass = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failed = true;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
};
const info = (label: string, detail = ''): void => console.log(`  ${label}${detail ? `  ${detail}` : ''}`);

function die(msg: string): never {
  console.error(`\n  x ${msg}\n`);
  process.exit(1);
}

// Resolve the Privy Sui wallet to sign with: a pinned browser wallet if provided, else a
// server-provisioned one owned by the authorization key (headless path).
async function resolveWallet(): Promise<ProvisionedWallet> {
  const walletId = process.env.SPIKE_PRIVY_WALLET_ID;
  const publicKey = process.env.SPIKE_PRIVY_PUBLIC_KEY;
  const address = process.env.SPIKE_PRIVY_ADDRESS;
  if (walletId && publicKey && address) {
    info('wallet', 'using SPIKE_PRIVY_* (browser-created)');
    return { walletId, publicKey, address };
  }
  info('wallet', 'no SPIKE_PRIVY_* set, provisioning a server-owned wallet via the authorization key');
  return provisionServerSuiWallet('pips-privy-spike');
}

// Stand up one fresh, live oracle for an asset (mirrors oracle-roll: create -> activate -> first
// push), then wait for the pushed price to be readable. Returns its id, expiry, and grid.
async function standUpOracle(
  asset: string,
  spot: number,
  expiryMs: number,
): Promise<{ oracleId: string; capId: string; minStrike: bigint; tickSize: bigint }> {
  const capId = ORACLE_CAP_IDS[0];
  if (!capId) die('no oracle cap in config; run the bootstrap first');
  const { minStrike, tickSize } = gridForSpot(asset, spot);

  const createTx = new Transaction();
  buildCreateOracle(createTx, capId, asset, expiryMs, minStrike, tickSize);
  const oracleId = (await executeAsOperator(createTx, `create ${asset} oracle`)).objectChanges.find(
    (c) => c.type === 'created' && c.objectType?.endsWith('::oracle::OracleSVI'),
  )?.objectId;
  if (!oracleId) die('create_oracle returned no OracleSVI object');

  const liveTx = new Transaction();
  buildActivateOracle(liveTx, oracleId, capId, spot);
  const { digest } = await executeAsOperator(liveTx, `activate ${asset} oracle`);
  await suiClient.waitForTransaction({ digest });
  for (let i = 0; i < 8; i++) {
    const st = await readOracle(oracleId);
    if (st && st.spot1e9 > 0n && Date.now() - st.timestampMs < 30_000) break;
    await sleep(600);
  }
  return { oracleId, capId, minStrike, tickSize };
}

async function main(): Promise<void> {
  console.log('\n=== Privy server-signing spike (Phase 12 gate) ===\n');
  if (AUTH_MODE !== 'privy') {
    die('Set PIPS_AUTH_MODE=privy first (this spike exercises the privy signing branch).');
  }

  // === 1) The embedded Sui wallet ===
  console.log('1) Embedded Sui wallet');
  const wallet = await resolveWallet();
  const derived = suiAddressForPublicKey(wallet.publicKey);
  pass('Privy address matches the key-derived Sui address', wallet.address === derived, wallet.address);
  if (wallet.address !== derived) die(`address mismatch: privy ${wallet.address} vs derived ${derived} (signatures would be rejected)`);
  info('walletId', wallet.walletId);
  // The signing context executeForUser expects (privy branch).
  const walletCtx = { provider: 'privy' as const, address: wallet.address, walletId: wallet.walletId, publicKey: wallet.publicKey };

  // === Fund the wallet (operator): SUI for its own gas + DUSDC chips to play with ===
  await fundSui(wallet.address, 2);
  if ((await getDusdcBalance(wallet.address)) < 100) await mintDusdc(wallet.address, 1000);
  const gas = await getSuiBalanceRaw(wallet.address);
  pass('wallet funded with gas SUI', gas > 0n, `${sui(gas)} SUI (operator ${operatorAddress.slice(0, 10)}...)`);
  info('wallet chips', `$${(await getDusdcBalance(wallet.address)).toFixed(2)} USDC`);

  // === 2) create_manager, signed by Privy (the onboarding tx + the core signing proof) ===
  console.log('\n2) create_manager (Privy-signed)');
  const mgrTx = new Transaction();
  buildCreateManager(mgrTx);
  let managerId: string | undefined;
  try {
    const res = await executeForUser(mgrTx, walletCtx);
    pass('create_manager accepted by Sui', true, explorerTxUrl(res.digest));
    managerId = res.objectChanges.find(
      (c) => c.type === 'created' && c.objectType?.includes('::predict_manager::PredictManager'),
    )?.objectId;
  } catch (e) {
    pass('create_manager accepted by Sui', false, e instanceof Error ? e.message : String(e));
    die('Privy signing did not produce a Sui-acceptable signature. The recipe is wrong; do not wire plays.');
  }
  if (!managerId) die('create_manager landed but no PredictManager was created (check the Predict ids).');
  info('PredictManager', managerId);

  // === 3) mint a binary position, signed by Privy ===
  console.log('\n3) mint (Privy-signed)');
  const asset = 'BTC';
  const spot = await fetchSpot(asset);
  const { oracleId, minStrike, tickSize } = await standUpOracle(asset, spot, Date.now() + 600_000);
  const st = await readOracle(oracleId);
  if (!st) die('oracle not readable after stand-up');
  info('oracle', `${oracleId.slice(0, 12)} spot $${(Number(st.spot1e9) / 1e9).toFixed(2)}`);

  // Pick the grid strike one tick below spot so an UP binary opens in the money (a positive mark to
  // cash out). Strike sits on the oracle grid with key.expiry == oracle.expiry (the protocol rule).
  const idx = (st.spot1e9 - minStrike) / tickSize;
  const strike1e9 = minStrike + (idx > 1n ? idx - 1n : 1n) * tickSize;
  const params: BinaryParams = { oracleId, expiryMs: st.expiryMs, strike1e9, side: 'up', quantity: toDusdcRaw(10) };

  const preview = await previewMint(params);
  pass('live preview returns a real cost', preview.cost > 0n && preview.cost <= toDusdcRaw(10), `cost ${usd(preview.cost)} for ${usd(params.quantity)} max payout`);

  const mintTx = new Transaction();
  const coin = coinWithBalance({ type: DUSDC_TYPE, balance: preview.cost })(mintTx);
  buildDeposit(mintTx, managerId, coin);
  buildMint(mintTx, managerId, params);
  let mintOk = false;
  try {
    const res = await executeForUser(mintTx, walletCtx);
    mintOk = true;
    pass('mint accepted by Sui', true, explorerTxUrl(res.digest));
  } catch (e) {
    pass('mint accepted by Sui', false, e instanceof Error ? e.message : String(e));
  }
  const mgrAfterMint = await getManagerBalanceRaw(managerId);
  info('manager balance after mint', usd(mgrAfterMint));

  // === 4) redeem (cash out at the live mark), signed by Privy ===
  console.log('\n4) redeem / cash out (Privy-signed)');
  if (mintOk) {
    const mark = await previewMint(params); // redeem bid == preview payout at the current mark
    const redeemTx = new Transaction();
    buildRedeem(redeemTx, managerId, params);
    try {
      const res = await executeForUser(redeemTx, walletCtx);
      pass('redeem accepted by Sui', true, explorerTxUrl(res.digest));
      info('cashed out', `mark ${usd(mark.payout)} back into the manager`);
    } catch (e) {
      pass('redeem accepted by Sui', false, e instanceof Error ? e.message : String(e));
    }
    const mgrAfterRedeem = await getManagerBalanceRaw(managerId);
    pass('manager balance grew on cash-out', mgrAfterRedeem > mgrAfterMint, `${usd(mgrAfterMint)} -> ${usd(mgrAfterRedeem)}`);
  } else {
    pass('redeem accepted by Sui', false, 'skipped: mint did not land');
  }

  console.log(
    `\n${failed ? 'PRIVY SIGNING SPIKE HAD FAILURES, see above. Do not wire Privy plays.' : 'PRIVY SIGNING SPIKE GREEN: create_manager + mint + redeem all signed via Privy rawSign and accepted by Sui. Privy plays are cleared to wire.'}\n`,
  );
}

main()
  .then(() => process.exit(failed ? 1 : 0))
  .catch((e) => die(e instanceof Error ? e.stack || e.message : String(e)));
