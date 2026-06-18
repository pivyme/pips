// Pips Predict bootstrap (the Phase 2 spike, and the production bootstrap).
//
// Publishes our OWN DeepBook Predict instance and proves it end to end:
//   1. publish our own DUSDC (so we own a freely mintable treasury for free chips)
//   2. publish packages/predict (+ deepbook + token, as unpublished deps)
//   3. create_predict -> seed the vault -> stand up one live short-expiry BTC oracle
//   4. one real mint + redeem round trip, asserting DUSDC moved in the manager
//   5. persist every id to src/lib/sui/deployed.json + the headline ids to .env
//
// Network is SUI_NETWORK (testnet by default, or `localnet` for a fully local instance
// with infinite faucet SUI). On localnet this also auto-switches the sui CLI to the local
// env, funds the operator from the local faucet, and aligns the Move.toml localnet
// chain-id, so a fresh chain bootstraps in one shot. See scripts/localnet.sh.
//
// Why we publish our own: Mysten's Predict instance is admin gated (oracle creation
// needs an AdminCap only they hold) and the public DUSDC treasury is owned, not shared,
// so we cannot mint from it. Self publishing mints us our own AdminCap + PLP treasury +
// Registry, and our own DUSDC treasury we can mint freely. All ids are unstable
// pre-mainnet and live in config, never inline. Every signature here is mirrored from
// Mysten's reference scripts on branch predict-testnet-4-16.
//
// Requires (PAUSE_FOR_USER if missing): the `sui` CLI, its active address equal to
// TESTING_WALLET_PK's address (the CLI signs the publish), and that address funded with
// SUI. Run from the backend dir: `bun scripts/bootstrap.ts` (or via scripts/localnet.sh).

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

import { TESTING_WALLET_PK, SUI_NETWORK, SUI_FULLNODE_URL } from '../src/config/main-config.ts';

type Network = 'testnet' | 'mainnet' | 'devnet' | 'localnet';
const VALID_NETWORKS: Network[] = ['testnet', 'mainnet', 'devnet', 'localnet'];
const NETWORK = (SUI_NETWORK || 'testnet').toLowerCase() as Network;
if (!VALID_NETWORKS.includes(NETWORK)) {
  throw new Error(`Unsupported SUI_NETWORK "${SUI_NETWORK}". Use one of: ${VALID_NETWORKS.join(', ')}.`);
}
const IS_LOCAL = NETWORK === 'localnet';
// The sui CLI env alias whose RPC matches our network. Resolved in preflight; used to
// strip the right [published.<alias>] table before each republish.
let CLI_ALIAS = NETWORK as string;

const RPC_URL = SUI_FULLNODE_URL || getJsonRpcFullnodeUrl(NETWORK);
const CLOCK = '0x6';
const COIN_REGISTRY = '0xc';
const FLOAT_SCALING = 1_000_000_000n; // on-chain prices/strikes are 1e9 scaled
const DUSDC_DECIMALS = 1_000_000n; // DUSDC is 6dp
// per-publish gas ceiling. real cost ~0.35 SUI on testnet; localnet gas is free, so give
// the (separate, leaf-first) predict publish generous headroom.
const PUBLISH_GAS = 2_000_000_000n;
const MIN_SUI = 1_200_000_000n; // floor for the publishes + the bootstrap txs, with headroom

const CONTRACTS = path.resolve(import.meta.dir, '../../contracts');
// testnet keeps the committed deployed.json; other networks get deployed.<network>.json
// (localnet's is gitignored, ids change every regenesis). config.ts resolves the same way.
const DEPLOYED_FILE = NETWORK === 'testnet' ? 'deployed.json' : `deployed.${NETWORK}.json`;
const DEPLOYED_PATH = path.resolve(import.meta.dir, `../src/lib/sui/${DEPLOYED_FILE}`);
// localnet only: test-publish records ephemeral publication addresses in this file (one
// shared across the leaf-first publishes so deepbook/predict resolve their deps). It must
// start empty each run, else test-publish refuses ("already published"). Gitignored.
const LOCAL_PUBFILE = path.resolve(import.meta.dir, '../Pub.localnet.toml');
const ENV_PATH = path.resolve(import.meta.dir, '../.env');
const WEB_ENV_PATH = path.resolve(import.meta.dir, '../../web/.env');

const client = new SuiJsonRpcClient({ url: RPC_URL, network: NETWORK });

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

// Strip the `[published.<CLI_ALIAS>]` table from a package's Published.toml so the CLI
// will publish it again on this env. Leaves other environments (e.g. mainnet) untouched.
function clearPublication(pkgDir: string): void {
  const file = path.join(CONTRACTS, pkgDir, 'Published.toml');
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.startsWith('[')) skipping = line.trim() === `[published.${CLI_ALIAS}]`;
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
// active address, which must equal our keypair address.
//
// Two paths:
//  - real networks: `sui client publish`. testnet/mainnet/devnet are well-known envs, so
//    no --build-env (it builds for the active client env automatically; the flag is
//    rejected). --with-unpublished-dependencies bundles deepbook+token in one tx.
//  - localnet: `sui client test-publish -e <alias>`. localnet is short-lived + private, so
//    the package manager wants an ephemeral publication (docs: don't put localnet in
//    [environments]). test-publish records ephemeral addresses in Move.lock instead.
//    Bundling all unpublished deps at 0x0 collides (deepbook + deepbook_predict both 0x0),
//    so we publish leaf-first (token -> deepbook -> predict) and each links the prior.
//
// --skip-dependency-verification avoids a false dep-mismatch when the CLI protocol version
// lags the network's; we publish our own source so there is nothing third-party to verify.
function publish(pkgDir: string, withUnpublishedDeps: boolean): ObjectChange[] {
  // The CLI records each publish in the package's Published.toml and refuses to
  // republish while an entry for this env exists. We always want a fresh publish here, so
  // drop our own package's entry for the active alias first. Only touches the package we
  // publish, never its deps (deepbook keeps its canonical published entries).
  clearPublication(pkgDir);
  const args = IS_LOCAL
    ? ['client', 'test-publish', '-e', CLI_ALIAS, '--pubfile-path', LOCAL_PUBFILE, '--json', '--skip-dependency-verification', '--gas-budget', String(PUBLISH_GAS)]
    : ['client', 'publish', '--json', '--skip-dependency-verification', '--gas-budget', String(PUBLISH_GAS)];
  // Real networks bundle unpublished deps; localnet publishes them leaf-first instead.
  if (withUnpublishedDeps && !IS_LOCAL) args.push('--with-unpublished-dependencies');
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// `sui client envs --json` -> [ [{alias, rpc, ...}], activeAlias ]. Parsed defensively.
function listEnvs(): { alias: string; rpc: string }[] {
  try {
    const raw = JSON.parse(sui(['client', 'envs', '--json']));
    const arr = Array.isArray(raw) ? (Array.isArray(raw[0]) ? raw[0] : raw) : [];
    return arr.map((e: { alias: string; rpc: string }) => ({ alias: e.alias, rpc: e.rpc }));
  } catch {
    return [];
  }
}

// Point the sui CLI at the node we publish to. On localnet we auto-manage the env (create
// the alias if missing, switch to it) so a fresh chain bootstraps with no manual setup.
// On real networks we only verify the active env's RPC matches, never mutate the CLI.
function resolveCliEnv(): void {
  const envs = listEnvs();
  const match = envs.find((e) => e.rpc === RPC_URL);

  if (IS_LOCAL) {
    if (match) {
      CLI_ALIAS = match.alias;
    } else {
      sui(['client', 'new-env', '--alias', 'localnet', '--rpc', RPC_URL]);
      CLI_ALIAS = 'localnet';
    }
    if (sui(['client', 'active-env']) !== CLI_ALIAS) sui(['client', 'switch', '--env', CLI_ALIAS]);
    return;
  }

  CLI_ALIAS = sui(['client', 'active-env']);
  const active = envs.find((e) => e.alias === CLI_ALIAS);
  if (active && active.rpc !== RPC_URL) {
    throw new Error(
      `sui CLI active env "${CLI_ALIAS}" (${active.rpc}) does not match SUI_NETWORK=${NETWORK} (${RPC_URL}). ` +
        `Switch the CLI to a matching env: sui client switch --env <alias>.`,
    );
  }
}

// Fund the operator. localnet faucet is unlimited (loop a few times for headroom); the
// public faucets are rate-limited so one shot. Tries the v2 endpoint, falls back to v1.
// Mainnet has no faucet, so there we just verify the wallet already holds enough.
async function ensureFunded(): Promise<void> {
  if (NETWORK === 'mainnet') {
    const bal = BigInt((await client.getBalance({ owner: address })).totalBalance);
    if (bal < MIN_SUI) throw new Error(`Insufficient mainnet SUI (${bal} MIST). Fund ${address} and re-run.`);
    console.log(`Funded. Address ${address}, balance ${bal} MIST.`);
    return;
  }
  const host = getFaucetHost(NETWORK);
  const requestOnce = async (): Promise<void> => {
    try {
      await requestSuiFromFaucetV2({ host, recipient: address });
    } catch {
      // v1 fallback for older local faucets that only serve /gas
      await fetch(`${host}/gas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ FixedAmountRequest: { recipient: address } }),
      });
    }
  };

  let bal = BigInt((await client.getBalance({ owner: address })).totalBalance);
  const maxTries = IS_LOCAL ? 5 : 1;
  for (let i = 0; bal < MIN_SUI && i < maxTries; i++) {
    console.log(`Balance ${bal} MIST < ${MIN_SUI}. Requesting ${NETWORK} faucet (${i + 1}/${maxTries})...`);
    try {
      await requestOnce();
    } catch (e) {
      console.log(`Faucet request failed: ${String(e)}`);
    }
    await sleep(IS_LOCAL ? 1500 : 5000);
    bal = BigInt((await client.getBalance({ owner: address })).totalBalance);
  }
  if (bal < MIN_SUI) {
    const hint = IS_LOCAL
      ? `the local faucet at ${host} (is \`sui start --with-faucet\` running? try scripts/localnet.sh up)`
      : `${address} (e.g. https://faucet.sui.io or \`sui client faucet\`)`;
    throw new Error(`Insufficient SUI (${bal} MIST). Fund ${hint} to at least ${MIN_SUI} MIST and re-run.`);
  }
  console.log(`Funded. Address ${address}, balance ${bal} MIST.`);
}

async function preflight(): Promise<void> {
  let chainId: string;
  try {
    chainId = await client.getChainIdentifier();
  } catch (e) {
    const hint = IS_LOCAL ? ` Is the local node running? Start it with: scripts/localnet.sh up` : '';
    throw new Error(`Cannot reach the Sui node at ${RPC_URL}.${hint} (${String(e)})`);
  }

  resolveCliEnv();

  const activeAddr = sui(['client', 'active-address']);
  if (activeAddr !== address) {
    throw new Error(
      `sui CLI active address (${activeAddr}) does not match TESTING_WALLET_PK (${address}). ` +
        `The CLI signs the publish, so import this key and switch to it: sui keytool import <key> ed25519 && sui client switch --address ${address}`,
    );
  }

  await ensureFunded();

  // Start each localnet publish from an empty ephemeral pubfile (test-publish refuses to
  // republish an existing entry). Fresh chain every --force-regenesis, so this is expected.
  if (IS_LOCAL) fs.rmSync(LOCAL_PUBFILE, { force: true });

  console.log(`Preflight ok. Network ${NETWORK} (cli env "${CLI_ALIAS}", chain ${chainId}).`);
}

// localnet only: test-publish dirties the vendored Move.lock files (ephemeral local pins),
// may create a stray token/Published.toml, and leaves the pubfile behind. None of it should
// be committed, so restore/drop it once the on-chain instance is fully stood up. Best-effort.
function cleanupLocalArtifacts(): void {
  if (!IS_LOCAL) return;
  fs.rmSync(LOCAL_PUBFILE, { force: true });
  const git = (args: string[]): void => {
    try {
      execFileSync('git', ['-C', CONTRACTS, ...args], { stdio: 'ignore' });
    } catch {
      // not a git checkout or git unavailable: leave the artifacts, they are harmless
    }
  };
  git(['checkout', '--', 'predict/Move.lock', 'deepbook/Move.lock', 'token/Move.lock', 'dusdc/Move.lock']);
  git(['clean', '-fq', 'token/Published.toml']); // only removes it if untracked
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

// Idempotency: if we already published and the package is alive on-chain, a re-run is
// a no-op (protects scarce testnet gas). Oracle freshness is the oracle-roll worker's
// job, not the bootstrap's. Pass --force to redeploy from scratch.
async function alreadyDeployed(): Promise<boolean> {
  if (process.argv.includes('--force') || !fs.existsSync(DEPLOYED_PATH)) return false;
  try {
    const prev = JSON.parse(fs.readFileSync(DEPLOYED_PATH, 'utf-8')) as { packageId?: string };
    if (!prev.packageId) return false;
    const pkg = await client.getObject({ id: prev.packageId, options: { showType: true } });
    if (pkg.data) {
      console.log(`Already deployed (package ${prev.packageId}). Re-run with --force to redeploy.`);
      return true;
    }
  } catch {
    // unreadable/partial deployed.json -> treat as not deployed and bootstrap fresh
  }
  return false;
}

async function main(): Promise<void> {
  console.log(`=== Pips Predict bootstrap (${NETWORK}) ===`);
  if (await alreadyDeployed()) return;
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

  // --- 2. publish predict (+ deepbook + token) ---
  // localnet links unpublished deps by address, so they cannot all share 0x0: publish
  // leaf-first (token -> deepbook) so each is on-chain before predict builds against it.
  // Real networks bundle them in predict's publish via --with-unpublished-dependencies.
  if (IS_LOCAL) {
    console.log('\n[2/6] Publishing token + deepbook (leaf-first for localnet)...');
    publish('token', false);
    publish('deepbook', false);
  }
  console.log(IS_LOCAL ? '       Publishing predict...' : '\n[2/6] Publishing predict (with deepbook + token)...');
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

  // reflect network + headline ids into backend/.env (config reads deployed.json, but
  // keeping SUI_NETWORK in sync here prevents the "deployed.json is for X but SUI_NETWORK
  // is Y" mismatch error when switching between testnet and localnet).
  updateEnv(ENV_PATH, {
    SUI_NETWORK: NETWORK,
    PREDICT_PACKAGE_ID: packageId,
    PREDICT_REGISTRY_ID: registryId,
    PREDICT_OBJECT_ID: predictId,
    PREDICT_ADMIN_CAP_ID: adminCapId,
  });
  // mirror network + the public ids the client needs into web/.env (reads only, no secrets)
  updateEnv(WEB_ENV_PATH, {
    VITE_SUI_NETWORK: NETWORK,
    VITE_PREDICT_PACKAGE_ID: packageId,
    VITE_PREDICT_OBJECT_ID: predictId,
    VITE_DUSDC_TYPE: DUSDC_TYPE,
  });

  cleanupLocalArtifacts();
  console.log(`\n=== Bootstrap complete (${NETWORK}). Spike is GREEN. ===`);
}

function updateEnv(envPath: string, vars: Record<string, string>): void {
  if (!fs.existsSync(envPath)) return;
  let env = fs.readFileSync(envPath, 'utf-8');
  for (const [k, v] of Object.entries(vars)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    env = re.test(env) ? env.replace(re, `${k}=${v}`) : env + `\n${k}=${v}`;
  }
  fs.writeFileSync(envPath, env);
  console.log(`  updated ${path.relative(process.cwd(), envPath)} ids`);
}

main().catch((e) => {
  console.error('\nBootstrap failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
