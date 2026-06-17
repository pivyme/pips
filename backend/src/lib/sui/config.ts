// The single source of truth for our Predict instance ids on the server.
// The bootstrap (scripts/bootstrap.ts) writes deployed.json; everything reads from
// here. Never inline a package/object/oracle id anywhere else. Ids are unstable
// pre-mainnet, so a mainnet re-point is one bootstrap + this file, nothing else.

import fs from 'fs';
import path from 'path';

import { SUI_NETWORK } from '../../config/main-config.ts';

export const CLOCK = '0x6';
export const COIN_REGISTRY = '0xc';

// Two scales live in the protocol: prices/strikes are 1e9-scaled, DUSDC is 6dp.
export const FLOAT_SCALING = 1_000_000_000n;
export const DUSDC_DECIMALS = 1_000_000n;

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

const DEPLOYED_PATH = path.resolve(import.meta.dir, 'deployed.json');

function loadDeployed(): Deployed {
  if (!fs.existsSync(DEPLOYED_PATH)) {
    throw new Error(
      'Predict deployment missing: backend/src/lib/sui/deployed.json not found. ' +
        'Run `bun scripts/bootstrap.ts` from backend/ to publish and seed the instance.',
    );
  }
  const d = JSON.parse(fs.readFileSync(DEPLOYED_PATH, 'utf-8')) as Deployed;
  if (d.network !== SUI_NETWORK) {
    throw new Error(`deployed.json is for "${d.network}" but SUI_NETWORK is "${SUI_NETWORK}". Re-bootstrap or fix the env.`);
  }
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

// Move call targets, built once from the package id so callers never string-concat.
export const target = (mod: string, fn: string): `${string}::${string}::${string}` =>
  `${PACKAGE_ID}::${mod}::${fn}`;

// display USD -> 1e9-scaled u64 (prices, strikes)
export const usd1e9 = (n: number): bigint => BigInt(Math.round(n * 1e9));
// display DUSDC -> 6dp raw u64 (coin amounts)
export const toDusdcRaw = (n: number): bigint => BigInt(Math.round(n * 1_000_000));
// 6dp raw DUSDC -> display number
export const fromDusdcRaw = (raw: bigint): number => Number(raw) / 1_000_000;
