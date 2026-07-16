// Real Mysten DeepBook Predict deployment ids (testnet only, SUI_NETWORK==='testnet'); localnet/devnet keep our fork (config.ts). Vendored from Mysten's deployment.testnet.json into deployed-real.testnet.json, never hardcode an id elsewhere.
// Different shape than the fork's Deployed (no adminCap/oracleCaps/per-oracle grid): the real protocol is permissionless discovery + a per-owner account wrapper.

import fs from 'fs';
import path from 'path';

import { IS_REAL_PREDICT } from '../../config/main-config.ts';

export type RealAsset = {
  symbol: string;
  propbookUnderlyingId: number;
  // The 4 Propbook feed OBJECT ids load_live_pricer needs, resolved per underlying.
  feeds: { pyth: string; bsSpot: string; bsForward: string; bsSvi: string };
};
export type RealCadence = { id: number; name: string; periodMs: number; tickSize: string; admissionTickSize: string };

export type DeployedReal = {
  network: string;
  chainId: string;
  source?: string;
  packages: { predict: string; propbook: string; blockScholesOracle: string; account: string; fixedMath: string };
  shared: {
    protocolConfigId: string;
    poolVaultId: string;
    registryId: string;
    oracleRegistryId: string;
    accountRegistryId: string;
  };
  accumulatorRoot: string;
  clock: string;
  dusdc: { packageId: string; type: string };
  assets: RealAsset[];
  cadences: RealCadence[];
};

const REAL_FILE = 'deployed-real.testnet.json';
const REAL_PATH = path.resolve(import.meta.dir, REAL_FILE);

function loadDeployedReal(): DeployedReal {
  // Server/container builds may not ship the file, so allow the whole record via PIPS_DEPLOYED_REAL_JSON (raw JSON or base64), same escape hatch as the fork's PIPS_DEPLOYED_JSON.
  const fromEnv = process.env.PIPS_DEPLOYED_REAL_JSON?.trim();
  const raw = fromEnv
    ? fromEnv.startsWith('{')
      ? fromEnv
      : Buffer.from(fromEnv, 'base64').toString('utf-8')
    : fs.existsSync(REAL_PATH)
      ? fs.readFileSync(REAL_PATH, 'utf-8')
      : null;
  if (!raw) {
    throw new Error(
      `Real Predict deployment missing: provide backend/src/lib/sui/${REAL_FILE} or set PIPS_DEPLOYED_REAL_JSON.`,
    );
  }
  const d = JSON.parse(raw) as DeployedReal;
  if (d.network !== 'testnet') throw new Error(`deployed-real record is for "${d.network}", expected testnet.`);
  return d;
}

// Loaded ONLY in real mode; null on localnet/devnet so the fork path never touches this file.
const real: DeployedReal | null = IS_REAL_PREDICT ? loadDeployedReal() : null;

// Accessor that asserts real mode; real-protocol code calls this so a stray fork-mode access fails loud instead of silently using ''.
export function realDeployment(): DeployedReal {
  if (!real) throw new Error('config-real accessed while SUI_NETWORK is not testnet (fork mode).');
  return real;
}

// Flat id exports ('' in fork mode); only real-mode code reads these, the '' fallback just keeps TS/imports happy on localnet/devnet.
export const REAL_PREDICT_PACKAGE = real?.packages.predict ?? '';
export const REAL_PROPBOOK_PACKAGE = real?.packages.propbook ?? '';
export const REAL_ACCOUNT_PACKAGE = real?.packages.account ?? '';
export const REAL_BLOCK_SCHOLES_PACKAGE = real?.packages.blockScholesOracle ?? '';

export const REAL_PROTOCOL_CONFIG_ID = real?.shared.protocolConfigId ?? '';
export const REAL_POOL_VAULT_ID = real?.shared.poolVaultId ?? '';
export const REAL_REGISTRY_ID = real?.shared.registryId ?? '';
export const REAL_ORACLE_REGISTRY_ID = real?.shared.oracleRegistryId ?? '';
export const REAL_ACCOUNT_REGISTRY_ID = real?.shared.accountRegistryId ?? '';

export const REAL_ACCUMULATOR_ROOT = real?.accumulatorRoot ?? '';
export const REAL_CLOCK = real?.clock ?? '0x6';
export const REAL_DUSDC_TYPE = real?.dusdc.type ?? '';
export const REAL_DUSDC_PACKAGE_ID = real?.dusdc.packageId ?? '';

export const REAL_ASSETS: RealAsset[] = real?.assets ?? [];
export const REAL_CADENCES: RealCadence[] = real?.cadences ?? [];
// Only BTC_USD is live on Mysten's deployment for now; the cadence we trade is 1m (id 0).
export const REAL_BTC_ASSET: RealAsset | null = real?.assets.find((a) => a.symbol === 'BTC_USD') ?? null;
export const REAL_MINUTE_CADENCE: RealCadence | null = real?.cadences.find((c) => c.id === 0) ?? null;

// Build a real-protocol Move call target off a specific package (predict/account/propbook), never string-concat at call sites.
// Mirrors config.ts `target()` but the package is explicit since the real protocol spans several packages.
export const realTarget = (pkg: string, mod: string, fn: string): `${string}::${string}::${string}` =>
  `${pkg}::${mod}::${fn}`;

// Stale-id guard: a Mysten redeploy would strand us on gone objects, so confirm a few configured shared objects still exist with the expected type. Non-fatal (demo mode still boots), returns false on mismatch.
// Called once at boot in real mode; lazy-imports the client to avoid a config<->client module cycle.
export async function verifyRealDeployment(): Promise<boolean> {
  if (!real) return true;
  const { suiClient } = await import('./client.ts');
  const expect: { id: string; type: string; label: string }[] = [
    { id: real.shared.poolVaultId, type: `${real.packages.predict}::plp::PoolVault`, label: 'PoolVault' },
    {
      id: real.shared.accountRegistryId,
      type: `${real.packages.account}::account_registry::AccountRegistry`,
      label: 'AccountRegistry',
    },
    {
      id: real.shared.oracleRegistryId,
      type: `${real.packages.propbook}::registry::OracleRegistry`,
      label: 'OracleRegistry',
    },
  ];
  let ok = true;
  for (const e of expect) {
    try {
      // `type` is always on the object response (no include needed); a missing object throws (L-003).
      const res = await suiClient.core.getObject({ objectId: e.id });
      const onChain = res.object?.type;
      if (onChain !== e.type) {
        ok = false;
        console.error(
          `[predict-real] STALE ID: ${e.label} ${e.id} is "${onChain ?? 'missing'}", expected "${e.type}". ` +
            'Mysten likely redeployed; re-vendor deployed-real.testnet.json.',
        );
      }
    } catch (err) {
      ok = false;
      console.error(
        `[predict-real] STALE ID: ${e.label} ${e.id} not found on chain (${err instanceof Error ? err.message : err}). ` +
          'Re-vendor deployed-real.testnet.json.',
      );
    }
  }
  if (ok) console.log('[predict-real] deployment verified: PoolVault, AccountRegistry, OracleRegistry live.');
  return ok;
}
