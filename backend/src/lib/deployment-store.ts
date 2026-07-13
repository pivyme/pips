// The shared DB is the source of truth for the live Predict deployment. Both this box and the local
// deployer point at the same Postgres (DATABASE_URL), so after a devnet wipe the deployer publishes a
// fresh stack and writes the new deploy record here. The box then reloads those ids on its next boot
// (hydrateDeploymentFromDB, called before src/lib/sui/config.ts loads) and the deploy-watch worker
// triggers that restart on its own. Net effect: a redeploy self-heals with no Dokploy env paste, no
// manual redeploy, downtime = one container restart.
//
// IMPORTANT: this module must NOT import src/lib/sui/config.ts (directly or transitively). It runs in
// the boot hook before config is allowed to load, so it stays on prisma + main-config only.

import { prismaQuery } from './prisma.ts';
import { SUI_NETWORK, IS_REAL_PREDICT } from '../config/main-config.ts';

const keyFor = (network: string): string => `deployment.${network}`;

// A cheap identity for a deploy record: the package id plus when it was bootstrapped. A change here
// means a fresh deployment landed, which is what the watcher compares against to decide to restart.
export function fingerprint(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as { packageId?: string; bootstrappedAt?: string };
    return d.packageId ? `${d.packageId}:${d.bootstrappedAt ?? ''}` : null;
  } catch {
    return null;
  }
}

// Read the live deploy record (raw JSON string) for a network, or null. Resilient by design: a missing
// AppConfig table (pre db:push) or an unreachable DB just reads as "no record", so callers fall back to
// the env/file path and the app still boots.
export async function readDeploymentRecord(network: string = SUI_NETWORK): Promise<string | null> {
  try {
    const row = await prismaQuery.appConfig.findUnique({ where: { key: keyFor(network) } });
    return row?.value ?? null;
  } catch {
    return null;
  }
}

// Publish a fresh deploy record to the shared DB (called by scripts/publish-deploy-record.ts after a
// successful bootstrap). Validates the record is for the expected network so we never cross-wire chains.
export async function writeDeploymentRecord(value: string, network: string = SUI_NETWORK): Promise<void> {
  const d = JSON.parse(value) as { network?: string; packageId?: string };
  if (!d.packageId) throw new Error('deploy record has no packageId');
  if (d.network !== network) throw new Error(`deploy record is for "${d.network}" but expected "${network}"`);
  await prismaQuery.appConfig.upsert({
    where: { key: keyFor(network) },
    create: { key: keyFor(network), value },
    update: { value },
  });
}

// Boot hook: if the DB holds a deploy record for this network, expose it via PIPS_DEPLOYED_JSON so
// config.ts loads the live ids (DB wins over a stale env/file). MUST run before anything imports
// src/lib/sui/config.ts. No-op when the table/record is absent (env/file path takes over).
export async function hydrateDeploymentFromDB(): Promise<void> {
  // Real mode (testnet) uses Mysten's fixed deployment (config-real.ts), not a self-published fork
  // record, so a stale fork "deployment.testnet" row in the DB must not hijack PIPS_DEPLOYED_JSON.
  if (IS_REAL_PREDICT) return;
  const raw = await readDeploymentRecord();
  if (!raw) return;
  try {
    const d = JSON.parse(raw) as { network?: string; packageId?: string; bootstrappedAt?: string };
    if (d.network === SUI_NETWORK && d.packageId) {
      process.env.PIPS_DEPLOYED_JSON = raw;
      console.log(`[deploy-store] using ${SUI_NETWORK} deployment from DB (pkg ${d.packageId.slice(0, 10)}…, ${d.bootstrappedAt ?? 'unknown'})`);
    }
  } catch (e) {
    console.warn('[deploy-store] DB deploy record unparseable, ignoring:', e instanceof Error ? e.message : e);
  }
}
