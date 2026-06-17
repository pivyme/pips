// Pips Predict bootstrap (the Phase 2 spike, and the production bootstrap).
//
// Publishes our OWN DeepBook Predict instance to testnet and proves it end to end:
//   1. publish our own DUSDC (so we own a freely mintable treasury for free chips)
//   2. publish packages/predict (+ deepbook + token, as unpublished deps)
//   3. create_predict -> seed the vault -> stand up one live short-expiry BTC oracle
//   4. one real mint + redeem round trip, asserting DUSDC moved in the manager
//   5. persist every id to src/lib/sui/deployed.json + the headline ids to .env
//
// Why we publish our own: Mysten's Predict instance is admin gated (oracle creation
// needs an AdminCap only they hold) and the public DUSDC treasury is owned, not shared,
// so we cannot mint from it. Self publishing mints us our own AdminCap + PLP treasury +
// Registry, and our own DUSDC treasury we can mint freely. All ids are unstable
// pre-mainnet and live in config, never inline. Every signature here is mirrored from
// Mysten's reference scripts on branch predict-testnet-4-16.
//
// Requires (PAUSE_FOR_USER if missing): the `sui` CLI on testnet, its active address
// equal to TESTING_WALLET_PK's address (the CLI signs the publish), and that address
// funded with testnet SUI. Run from the backend dir: `bun scripts/bootstrap.ts`.

import '../dotenv.ts';

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromBase64 } from '@mysten/sui/utils';
import { getFaucetHost, requestSuiFromFaucetV2 } from '@mysten/sui/faucet';

import { TESTING_WALLET_PK } from '../src/config/main-config.ts';

const NETWORK = 'testnet';
const CLOCK = '0x6';
const COIN_REGISTRY = '0xc';
const FLOAT_SCALING = 1_000_000_000n; // on-chain prices/strikes are 1e9 scaled
const DUSDC_DECIMALS = 1_000_000n; // DUSDC is 6dp
const PUBLISH_GAS = 1_000_000_000n; // per-publish gas ceiling; real cost ~0.35 SUI, must fit available balance
const MIN_SUI = 1_200_000_000n; // floor for two publishes (~0.4 SUI) + the bootstrap txs, with headroom

const CONTRACTS = path.resolve(import.meta.dir, '../../contracts');
const DEPLOYED_PATH = path.resolve(import.meta.dir, '../src/lib/sui/deployed.json');
const ENV_PATH = path.resolve(import.meta.dir, '../.env');

const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl(NETWORK), network: NETWORK });

// usd (display) -> 1e9-scaled u64 for prices and strikes
const usd1e9 = (n: number): bigint => BigInt(Math.round(n * 1e9));
// dusdc (display) -> 6dp raw u64
const dusdc = (n: number): bigint => BigInt(Math.round(n)) * DUSDC_DECIMALS;

// ---------------------------------------------------------------------------
// signer + sui CLI helpers
// ---------------------------------------------------------------------------

function loadKeypair(): Ed25519Keypair {
  const pk = TESTING_WALLET_PK.trim();
  if (!pk) throw new Error('TESTING_WALLET_PK is empty. Paste a funded testnet key into backend/.env.');
  if (pk.startsWith('suiprivkey')) {
    const { secretKey } = decodeSuiPrivateKey(pk);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  // base64: accept a 32-byte secret or a 33-byte flagged keystore entry.
  const raw = fromBase64(pk);
  const secret = raw.length === 33 ? raw.slice(1) : raw;
  return Ed25519Keypair.fromSecretKey(secret);
}

function sui(args: string[]): string {
  return execFileSync('sui', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

// Strip the `[published.<NETWORK>]` table from a package's Published.toml so the CLI
// will publish it again. Leaves other environments (e.g. mainnet) untouched.
function clearTestnetPublication(pkgDir: string): void {
  const file = path.join(CONTRACTS, pkgDir, 'Published.toml');
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.startsWith('[')) skipping = line.trim() === `[published.${NETWORK}]`;
    if (!skipping) out.push(line);
  }
  fs.writeFileSync(file, out.join('\n'));
}

type ObjectChange = {
  type: string;
  objectId?: string;
  objectType?: string;
  packageId?: string;
  modules?: string[];
  owner?: unknown;
};

// publish a vendored package via the CLI (it owns framework caching + multi-package
// publish of unpublished deps) and return its objectChanges. The CLI signs with the
// active address, which must equal our keypair address. `sui client publish` always
// builds for the active client env (testnet), so do NOT pass --build-env here, it is
// rejected. --skip-dependency-verification avoids a false dep-mismatch when the CLI
// protocol version lags the network's; we publish our own source so there is nothing
// third-party to verify.
function publish(pkgDir: string, withUnpublishedDeps: boolean): ObjectChange[] {
  // The CLI records each publish in the package's Published.toml and refuses to
  // republish while a testnet entry exists. We always want a fresh publish here, so
  // drop our own package's testnet entry first. Only touches the package we publish,
  // never its deps (deepbook keeps its canonical testnet publication).
  clearTestnetPublication(pkgDir);
  const args = ['client', 'publish', '--json', '--skip-dependency-verification', '--gas-budget', String(PUBLISH_GAS)];
  if (withUnpublishedDeps) args.push('--with-unpublished-dependencies');
  args.push(path.join(CONTRACTS, pkgDir));
  const out = sui(args);
  const parsed = JSON.parse(out) as { objectChanges?: ObjectChange[]; effects?: { status?: { status?: string } } };
  const status = parsed.effects?.status?.status;
  if (status && status !== 'success') throw new Error(`publish ${pkgDir} failed: ${JSON.stringify(parsed.effects?.status)}`);
  return parsed.objectChanges ?? [];
}

const findCreated = (changes: ObjectChange[], match: (t: string) => boolean): string => {
  const c = changes.find((x) => x.type === 'created' && x.objectType && match(x.objectType));
  if (!c?.objectId) throw new Error('could not find a created object matching the predicate');
  return c.objectId;
};

const findPublished = (changes: ObjectChange[], moduleName: string): string => {
  const p = changes.find((x) => x.type === 'published' && x.modules?.includes(moduleName));
  if (!p?.packageId) throw new Error(`could not find published package containing module ${moduleName}`);
  return p.packageId;
};

// ---------------------------------------------------------------------------
// tx execution + reads
// ---------------------------------------------------------------------------

const keypair = loadKeypair();
const address = keypair.getPublicKey().toSuiAddress();

async function run(tx: Transaction, label: string): Promise<ObjectChange[]> {
  tx.setSender(address);
  tx.setGasBudget(800_000_000n); // headroom for create_oracle (matrix-page storage)
  const res = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true, showObjectChanges: true },
  });
  if (res.effects?.status.status !== 'success') {
    throw new Error(`${label} failed: ${JSON.stringify(res.effects?.status)}`);
  }
  await client.waitForTransaction({ digest: res.digest });
  console.log(`  ${label} ok (${res.digest})`);
  return (res.objectChanges as ObjectChange[]) ?? [];
}

// devInspect a u64 getter and decode its little-endian return bytes.
async function readU64(tx: Transaction): Promise<bigint> {
  const res = await client.devInspectTransactionBlock({ sender: address, transactionBlock: tx });
  const ret = res.results?.[res.results.length - 1]?.returnValues?.[0];
  if (!ret) throw new Error('devInspect returned no value');
  const bytes = ret[0] as number[];
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

// ---------------------------------------------------------------------------
// preflight: env, active address, funding
// ---------------------------------------------------------------------------

async function preflight(): Promise<void> {
  const activeEnv = sui(['client', 'active-env']);
  if (activeEnv !== NETWORK) {
    throw new Error(`sui CLI active env is "${activeEnv}", expected "${NETWORK}". Run: sui client switch --env ${NETWORK}`);
  }
  const activeAddr = sui(['client', 'active-address']);
  if (activeAddr !== address) {
    throw new Error(
      `sui CLI active address (${activeAddr}) does not match TESTING_WALLET_PK (${address}). ` +
        `The CLI signs the publish, so import this key and switch to it: sui keytool import <key> ed25519 && sui client switch --address ${address}`,
    );
  }

  let bal = BigInt((await client.getBalance({ owner: address })).totalBalance);
  if (bal < MIN_SUI) {
    console.log(`Balance ${bal} MIST < ${MIN_SUI}. Requesting testnet faucet...`);
    try {
      await requestSuiFromFaucetV2({ host: getFaucetHost(NETWORK), recipient: address });
      await new Promise((r) => setTimeout(r, 5000));
      bal = BigInt((await client.getBalance({ owner: address })).totalBalance);
    } catch (e) {
      console.log(`Faucet request failed: ${String(e)}`);
    }
  }
  if (bal < MIN_SUI) {
    throw new Error(
      `Insufficient testnet SUI (${bal} MIST). Fund ${address} (e.g. https://faucet.sui.io or \`sui client faucet\`) to at least ${MIN_SUI} MIST and re-run.`,
    );
  }
  console.log(`Preflight ok. Address ${address}, balance ${bal} MIST.`);
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== Pips Predict bootstrap (testnet) ===');
  await preflight();

  // --- 1. publish our own DUSDC, then promote its Currency to shared ---
  console.log('\n[1/6] Publishing DUSDC...');
  const dusdcChanges = publish('dusdc', false);
  const dusdcPackageId = findPublished(dusdcChanges, 'dusdc');
  const dusdcTreasuryCapId = findCreated(dusdcChanges, (t) => t.includes('TreasuryCap'));
  const initialCurrencyId = findCreated(
    dusdcChanges,
    (t) => t.includes('::coin_registry::Currency<') && t.includes('::dusdc::DUSDC'),
  );
  const DUSDC_TYPE = `${dusdcPackageId}::dusdc::DUSDC`;
  console.log(`  pkg=${dusdcPackageId}`);

  // finalize_registration promotes the TTO-owned Currency into a shared object with a
  // NEW id, which is the one create_predict needs.
  const finalizeTx = new Transaction();
  finalizeTx.moveCall({
    target: '0x2::coin_registry::finalize_registration',
    typeArguments: [DUSDC_TYPE],
    arguments: [finalizeTx.object(COIN_REGISTRY), finalizeTx.object(initialCurrencyId)],
  });
  const finalizeChanges = await run(finalizeTx, 'finalize DUSDC currency');
  const dusdcCurrencyId = findCreated(
    finalizeChanges,
    (t) => t.includes('::coin_registry::Currency<') && t.includes('::dusdc::DUSDC>'),
  );

  // --- 2. publish predict (+ deepbook + token as unpublished deps) ---
  console.log('\n[2/6] Publishing predict (with deepbook + token)...');
  const predictChanges = publish('predict', true);
  const packageId = findPublished(predictChanges, 'registry');
  const adminCapId = findCreated(predictChanges, (t) => t.includes('::registry::AdminCap'));
  const plpTreasuryCapId = findCreated(predictChanges, (t) => t.includes('TreasuryCap') && t.includes('::plp::PLP'));
  const registryId = findCreated(predictChanges, (t) => t.includes('::registry::Registry'));
  const upgradeCapId = findCreated(predictChanges, (t) => t.includes('0x2::package::UpgradeCap'));
  console.log(`  pkg=${packageId}`);

  // --- 3. create_predict + seed the vault ---
  console.log('\n[3/6] create_predict + seeding vault...');
  const createTx = new Transaction();
  createTx.moveCall({
    target: `${packageId}::registry::create_predict`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      createTx.object(registryId),
      createTx.object(adminCapId),
      createTx.object(dusdcCurrencyId),
      createTx.object(plpTreasuryCapId),
      createTx.object(CLOCK),
    ],
  });
  const predictId = findCreated(await run(createTx, 'create_predict'), (t) => t.includes('::predict::Predict'));

  // seed the vault with 100k free DUSDC (must cover max payouts before any mint)
  const seedTx = new Transaction();
  const seedCoin = seedTx.moveCall({
    target: '0x2::coin::mint',
    typeArguments: [DUSDC_TYPE],
    arguments: [seedTx.object(dusdcTreasuryCapId), seedTx.pure.u64(dusdc(100_000))],
  });
  const lp = seedTx.moveCall({
    target: `${packageId}::predict::supply`,
    typeArguments: [DUSDC_TYPE],
    arguments: [seedTx.object(predictId), seedCoin, seedTx.object(CLOCK)],
  });
  seedTx.transferObjects([lp], seedTx.pure.address(address));
  await run(seedTx, 'supply (seed vault)');

  // --- 4. stand up one live short-expiry BTC oracle ---
  console.log('\n[4/6] Standing up a live BTC oracle...');
  const minStrike = usd1e9(50_000); // grid floor $50k
  const tickSize = usd1e9(200); // $200 tick, 500 ticks -> covers $50k..$150k (single matrix page)
  const expiryMs = Date.now() + 5 * 60 * 1000; // 5 min out, ample for the round trip

  const capId = findCreated(
    await run(
      (() => {
        const tx = new Transaction();
        const cap = tx.moveCall({ target: `${packageId}::registry::create_oracle_cap`, arguments: [tx.object(adminCapId)] });
        tx.transferObjects([cap], tx.pure.address(address));
        return tx;
      })(),
      'create_oracle_cap',
    ),
    (t) => t.includes('::oracle::OracleSVICap'),
  );

  const oracleId = findCreated(
    await run(
      (() => {
        const tx = new Transaction();
        tx.moveCall({
          target: `${packageId}::registry::create_oracle`,
          arguments: [
            tx.object(registryId),
            tx.object(predictId),
            tx.object(adminCapId),
            tx.object(capId),
            tx.pure.string('BTC'),
            tx.pure.u64(BigInt(expiryMs)),
            tx.pure.u64(minStrike),
            tx.pure.u64(tickSize),
          ],
        });
        return tx;
      })(),
      'create_oracle',
    ),
    (t) => t.includes('::oracle::OracleSVI'),
  );

  // register the cap (create_oracle does NOT authorize it), activate, seed SVI, push price
  const regTx = new Transaction();
  regTx.moveCall({
    target: `${packageId}::registry::register_oracle_cap`,
    arguments: [regTx.object(oracleId), regTx.object(adminCapId), regTx.object(capId)],
  });
  await run(regTx, 'register_oracle_cap');

  const actTx = new Transaction();
  actTx.moveCall({ target: `${packageId}::oracle::activate`, arguments: [actTx.object(oracleId), actTx.object(capId), actTx.object(CLOCK)] });
  await run(actTx, 'activate');

  // smooth near-flat surface: small positive a, sigma>0, rho=0, m=0 (avoids EZeroVariance)
  const sviTx = new Transaction();
  const rho = sviTx.moveCall({ target: `${packageId}::i64::from_parts`, arguments: [sviTx.pure.u64(0n), sviTx.pure.bool(false)] });
  const m = sviTx.moveCall({ target: `${packageId}::i64::from_parts`, arguments: [sviTx.pure.u64(0n), sviTx.pure.bool(false)] });
  const svi = sviTx.moveCall({
    target: `${packageId}::oracle::new_svi_params`,
    arguments: [sviTx.pure.u64(usd1e9(0.04)), sviTx.pure.u64(usd1e9(0.1)), rho, m, sviTx.pure.u64(usd1e9(0.6))],
  });
  sviTx.moveCall({ target: `${packageId}::oracle::update_svi`, arguments: [sviTx.object(oracleId), sviTx.object(capId), svi, sviTx.object(CLOCK)] });
  await run(sviTx, 'update_svi');

  const spot = 109_000;
  const pushPrice = async (label: string) => {
    const tx = new Transaction();
    const pd = tx.moveCall({ target: `${packageId}::oracle::new_price_data`, arguments: [tx.pure.u64(usd1e9(spot)), tx.pure.u64(usd1e9(spot))] });
    tx.moveCall({ target: `${packageId}::oracle::update_prices`, arguments: [tx.object(oracleId), tx.object(capId), pd, tx.object(CLOCK)] });
    await run(tx, label);
  };
  await pushPrice('update_prices');

  // --- 5. real mint + redeem round trip ---
  console.log('\n[5/6] Round trip: create_manager -> deposit -> mint -> redeem...');
  const managerId = findCreated(
    await run(
      (() => {
        const tx = new Transaction();
        tx.moveCall({ target: `${packageId}::predict::create_manager` });
        return tx;
      })(),
      'create_manager',
    ),
    (t) => t.includes('::predict_manager::PredictManager'),
  );

  // fund the manager with 200 DUSDC
  const depTx = new Transaction();
  const depCoin = depTx.moveCall({
    target: '0x2::coin::mint',
    typeArguments: [DUSDC_TYPE],
    arguments: [depTx.object(dusdcTreasuryCapId), depTx.pure.u64(dusdc(200))],
  });
  depTx.moveCall({ target: `${packageId}::predict_manager::deposit`, typeArguments: [DUSDC_TYPE], arguments: [depTx.object(managerId), depCoin] });
  await run(depTx, 'deposit to manager');

  // UP position, strike $104k (below spot -> in the money), grid aligned, $50 max payout
  const strike = usd1e9(104_000);
  const quantity = 50_000_000n;
  const buildKey = (tx: Transaction) =>
    tx.moveCall({
      target: `${packageId}::market_key::up`,
      arguments: [tx.pure.id(oracleId), tx.pure.u64(BigInt(expiryMs)), tx.pure.u64(strike)],
    });

  const readBalance = async (): Promise<bigint> => {
    const tx = new Transaction();
    tx.moveCall({ target: `${packageId}::predict_manager::balance`, typeArguments: [DUSDC_TYPE], arguments: [tx.object(managerId)] });
    return readU64(tx);
  };

  const before = await readBalance();
  const mintTx = new Transaction();
  mintTx.moveCall({
    target: `${packageId}::predict::mint`,
    typeArguments: [DUSDC_TYPE],
    arguments: [mintTx.object(predictId), mintTx.object(managerId), mintTx.object(oracleId), buildKey(mintTx), mintTx.pure.u64(quantity), mintTx.object(CLOCK)],
  });
  await run(mintTx, 'mint');
  const afterMint = await readBalance();

  await pushPrice('update_prices (keep fresh)');

  const redeemTx = new Transaction();
  redeemTx.moveCall({
    target: `${packageId}::predict::redeem`,
    typeArguments: [DUSDC_TYPE],
    arguments: [redeemTx.object(predictId), redeemTx.object(managerId), redeemTx.object(oracleId), buildKey(redeemTx), redeemTx.pure.u64(quantity), redeemTx.object(CLOCK)],
  });
  await run(redeemTx, 'redeem');
  const afterRedeem = await readBalance();

  const cost = before - afterMint;
  const payout = afterRedeem - afterMint;
  console.log(`  manager DUSDC: before=${before} afterMint=${afterMint} afterRedeem=${afterRedeem}`);
  console.log(`  mint cost=${cost} (6dp), redeem payout=${payout} (6dp)`);
  if (!(afterMint < before)) throw new Error('SPIKE FAILED: mint did not deduct cost from the manager');
  if (!(afterRedeem > afterMint)) throw new Error('SPIKE FAILED: redeem did not return payout to the manager');
  console.log('  Round trip OK: real DUSDC moved through a real mint + redeem.');

  // --- 6. persist ids ---
  console.log('\n[6/6] Persisting deployed ids...');
  const deployed = {
    network: NETWORK,
    packageId,
    upgradeCapId,
    adminCapId,
    registryId,
    predictId,
    plpTreasuryCapId,
    dusdc: { packageId: dusdcPackageId, type: DUSDC_TYPE, treasuryCapId: dusdcTreasuryCapId, currencyId: dusdcCurrencyId },
    oracleCapIds: [capId],
    oracles: [{ oracleId, underlying: 'BTC', expiryMs, minStrike: String(minStrike), tickSize: String(tickSize) }],
    bootstrappedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(DEPLOYED_PATH), { recursive: true });
  fs.writeFileSync(DEPLOYED_PATH, JSON.stringify(deployed, null, 2) + '\n');
  console.log(`  wrote ${path.relative(process.cwd(), DEPLOYED_PATH)}`);

  // reflect the headline ids into .env for visibility
  updateEnv({
    PREDICT_PACKAGE_ID: packageId,
    PREDICT_REGISTRY_ID: registryId,
    PREDICT_OBJECT_ID: predictId,
    PREDICT_ADMIN_CAP_ID: adminCapId,
  });

  console.log('\n=== Bootstrap complete. Spike is GREEN. ===');
}

function updateEnv(vars: Record<string, string>): void {
  if (!fs.existsSync(ENV_PATH)) return;
  let env = fs.readFileSync(ENV_PATH, 'utf-8');
  for (const [k, v] of Object.entries(vars)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    env = re.test(env) ? env.replace(re, `${k}=${v}`) : env + `\n${k}=${v}`;
  }
  fs.writeFileSync(ENV_PATH, env);
  console.log(`  updated ${path.relative(process.cwd(), ENV_PATH)} headline ids`);
}

main().catch((e) => {
  console.error('\nBootstrap failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
