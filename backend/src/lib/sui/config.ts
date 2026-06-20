// The single source of truth for our Predict instance ids on the server.
// The bootstrap (scripts/bootstrap.ts) writes deployed.json; everything reads from
// here. Never inline a package/object/oracle id anywhere else. Ids are unstable
// pre-mainnet, so a mainnet re-point is one bootstrap + this file, nothing else.

import fs from 'fs';
import path from 'path';

import { SUI_NETWORK } from '../../config/main-config.ts';

// Pure money math lives in math.ts (chain-free, unit-tested). Re-exported here so the
// rest of the backend keeps importing scaling helpers from the one Sui config surface.
export {
  FLOAT_SCALING,
  DUSDC_DECIMALS,
  usd1e9,
  toDusdcRaw,
  fromDusdcRaw,
  mulScaled,
  quantityForStake,
  multiplier,
} from './math.ts';
import { usd1e9 } from './math.ts';

export const CLOCK = '0x6';
export const COIN_REGISTRY = '0xc';

export type DeployedOracle = {
  oracleId: string;
  underlying: string;
  expiryMs: number;
  minStrike: string;
  tickSize: string;
};

type Deployed = {
  network: string;
  packageId: string;
  upgradeCapId: string;
  adminCapId: string;
  registryId: string;
  predictId: string;
  plpTreasuryCapId: string;
  dusdc: { packageId: string; type: string; treasuryCapId: string; currencyId: string };
  oracleCapIds: string[];
  oracles: DeployedOracle[];
  bootstrappedAt: string;
};

// Per-network deployment record. testnet keeps the committed `deployed.json`; localnet (and
// any other chain) reads its own `deployed.<network>.json`, so switching networks never
// clobbers another network's ids. The bootstrap writes the matching file.
const DEPLOYED_FILE = SUI_NETWORK === 'testnet' ? 'deployed.json' : `deployed.${SUI_NETWORK}.json`;
const DEPLOYED_PATH = path.resolve(import.meta.dir, DEPLOYED_FILE);

// True when the deployment was read from the on-disk file (not PIPS_DEPLOYED_JSON), so a runtime
// update (oracle-cap rotation, see replaceOracleCap) can persist back to it. Env-provided
// deployments have no file to own, so they stay in-memory only.
let deployedFromFile = false;

function loadDeployed(): Deployed {
  // Server/container builds (e.g. Dokploy from git) don't have the gitignored deploy file. Allow
  // the whole record to come from PIPS_DEPLOYED_JSON instead (raw JSON or base64), so ids still
  // live in config and never get hardcoded or committed. Local dev keeps using the bootstrap file.
  const fromEnv = process.env.PIPS_DEPLOYED_JSON?.trim();
  if (fromEnv) {
    const raw = fromEnv.startsWith('{') ? fromEnv : Buffer.from(fromEnv, 'base64').toString('utf-8');
    const d = JSON.parse(raw) as Deployed;
    if (d.network !== SUI_NETWORK) {
      throw new Error(`PIPS_DEPLOYED_JSON is for "${d.network}" but SUI_NETWORK is "${SUI_NETWORK}". Fix the env.`);
    }
    return d;
  }
  if (!fs.existsSync(DEPLOYED_PATH)) {
    throw new Error(
      `Predict deployment missing: set PIPS_DEPLOYED_JSON or provide backend/src/lib/sui/${DEPLOYED_FILE}. ` +
        (SUI_NETWORK === 'localnet'
          ? 'Locally: scripts/localnet.sh setup. On a server: paste the deploy file into PIPS_DEPLOYED_JSON.'
          : 'Run `bun scripts/bootstrap.ts` from backend/ to publish and seed the instance.'),
    );
  }
  const d = JSON.parse(fs.readFileSync(DEPLOYED_PATH, 'utf-8')) as Deployed;
  if (d.network !== SUI_NETWORK) {
    throw new Error(`deployed.json is for "${d.network}" but SUI_NETWORK is "${SUI_NETWORK}". Re-bootstrap or fix the env.`);
  }
  deployedFromFile = true;
  return d;
}

const deployed = loadDeployed();

export const NETWORK = deployed.network;
export const PACKAGE_ID = deployed.packageId;
export const UPGRADE_CAP_ID = deployed.upgradeCapId;
export const ADMIN_CAP_ID = deployed.adminCapId;
export const REGISTRY_ID = deployed.registryId;
export const PREDICT_ID = deployed.predictId;
export const PLP_TREASURY_CAP_ID = deployed.plpTreasuryCapId;

export const DUSDC_TYPE = deployed.dusdc.type;
export const DUSDC_PACKAGE_ID = deployed.dusdc.packageId;
export const DUSDC_TREASURY_CAP_ID = deployed.dusdc.treasuryCapId;
export const DUSDC_CURRENCY_ID = deployed.dusdc.currencyId;

export const ORACLE_CAP_IDS = deployed.oracleCapIds;
export const ORACLES = deployed.oracles;

// Swap a rotated oracle cap into the live set and persist it. oracle-roll calls this when a cap's
// registry bookkeeping vector (Registry.oracle_ids[cap], an unbounded vector<ID>) fills to Sui's
// 256KB object cap and bricks create_oracle; a fresh cap starts that vector empty so creation
// resumes. ORACLE_CAP_IDS is mutated IN PLACE (signer's operatorCaps holds the same reference, and
// each tick re-reads it), then written back to the deploy file so a restart keeps the fresh cap
// instead of re-rotating off the bricked one. No file write for an env-provided deployment.
export function replaceOracleCap(fullCapId: string, freshCapId: string): void {
  const idx = ORACLE_CAP_IDS.indexOf(fullCapId);
  if (idx >= 0) ORACLE_CAP_IDS[idx] = freshCapId;
  else ORACLE_CAP_IDS.push(freshCapId);
  if (!deployedFromFile) return;
  deployed.oracleCapIds = ORACLE_CAP_IDS;
  fs.writeFileSync(DEPLOYED_PATH, JSON.stringify(deployed, null, 2) + '\n');
}

// Move call targets, built once from the package id so callers never string-concat.
export const target = (mod: string, fn: string): `${string}::${string}::${string}` =>
  `${PACKAGE_ID}::${mod}::${fn}`;

// Number of strike ticks an oracle covers, mirrored from our vendored
// constants.move (oracle_strike_grid_ticks). The grid spans tickSize * this.
export const ORACLE_STRIKE_GRID_TICKS = 500n;
// Tick granularity unit: every 1e9-scaled tickSize must be a multiple of this.
const TICK_SIZE_UNIT = 10_000n;

// Per-asset tick size in display USD. Sized to ~0.15% of spot so 500 ticks span ~+-37% around spot:
// wide enough that a strike stays on the grid as the game price strays, tight enough that the dense
// solve resolves the near-money tiers (the common 2x-3x sit within ~+-1.5% now that implied vol is
// game-calibrated, so a coarse grid would smear them, and the 2x floor would clamp far above 2x).
// Keep each a clean multiple of the tick unit. NOTE: changes here only land when the operator next
// (re)creates oracles (redeploy / oracle-roll); live oracles keep the grid they were created with.
export const ASSET_TICK_USD: Record<string, number> = {
  BTC: 100, // ~0.16% at ~63k
  ETH: 3, // ~0.17% at ~1.7k
  SOL: 0.15,
  SUI: 0.001, // ~0.14% at ~0.71 (was 0.0035 ~0.49%, too coarse to resolve the near tiers)
};

// Build a grid (minStrike, tickSize) centered on the current spot so strikes near the
// money exist. Both 1e9-scaled. minStrike is floored to the grid and kept > 0; tickSize
// is snapped to the protocol's tick unit. The oracle covers 500 ticks from minStrike.
export function gridForSpot(asset: string, spotUsd: number): { minStrike: bigint; tickSize: bigint } {
  const tickUsd = ASSET_TICK_USD[asset];
  if (!tickUsd) throw new Error(`No tick size configured for asset ${asset}`);
  let tickSize = usd1e9(tickUsd);
  tickSize -= tickSize % TICK_SIZE_UNIT; // snap to unit (assert_valid_strike_grid)
  if (tickSize <= 0n) throw new Error(`Tick size for ${asset} rounds to zero`);

  const span = tickSize * ORACLE_STRIKE_GRID_TICKS;
  const spot = usd1e9(spotUsd);
  // floor((spot - span/2) / tick) * tick, clamped above zero to the first whole tick.
  let minStrike = ((spot - span / 2n) / tickSize) * tickSize;
  if (minStrike < tickSize) minStrike = tickSize;
  return { minStrike, tickSize };
}
