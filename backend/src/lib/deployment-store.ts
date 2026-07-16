// The shared DB is the source of truth for the live Predict deployment: after a devnet wipe the deployer
// publishes a fresh stack here, and this box reloads those ids on next boot (hydrateDeploymentFromDB), so a redeploy self-heals with no Dokploy env paste.

// IMPORTANT: must NOT import src/lib/sui/config.ts (directly or transitively); this runs in the boot hook
// before config is allowed to load, so it stays on prisma + main-config only.

import { prismaQuery } from './prisma.ts';
import { SUI_NETWORK, IS_REAL_PREDICT } from '../config/main-config.ts';

const keyFor = (network: string): string => `deployment.${network}`;

// A cheap identity for a deploy record (packageId + bootstrappedAt); a change here means a fresh deployment landed, which the watcher compares against to decide to restart.
export function fingerprint(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as { packageId?: string; bootstrappedAt?: string };
    return d.packageId ? `${d.packageId}:${d.bootstrappedAt ?? ''}` : null;
  } catch {
    return null;
  }
}

// Reads the live deploy record (raw JSON) for a network, or null. Resilient by design: a missing AppConfig
// table (pre db:push) or unreachable DB just reads as "no record", so callers fall back to env/file.
export async function readDeploymentRecord(network: string = SUI_NETWORK): Promise<string | null> {
  try {
    const row = await prismaQuery.appConfig.findUnique({ where: { key: keyFor(network) } });
    return row?.value ?? null;
  } catch {
    return null;
  }
}

// Publishes a fresh deploy record to the shared DB (called by scripts/publish-deploy-record.ts after bootstrap); validates the record is for the expected network so we never cross-wire chains.
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

// Boot hook: if the DB holds a deploy record for this network, exposes it via PIPS_DEPLOYED_JSON so config.ts
// loads the live ids (DB wins over stale env/file); must run before anything imports src/lib/sui/config.ts.
export async function hydrateDeploymentFromDB(): Promise<void> {
  // Real mode (testnet) uses Mysten's fixed deployment (config-real.ts), so a stale fork "deployment.testnet" row in the DB must not hijack PIPS_DEPLOYED_JSON.
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
