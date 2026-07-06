// Self-heal watcher. The shared DB holds the live Predict deploy record (see deployment-store). When a
// devnet wipe is recovered, the deployer publishes a fresh stack and writes a new record; its package
// id changes. This worker notices that change and restarts the process. The boot hook (preboot.ts)
// then reloads the new ids from the DB, so with a restart-on-exit container (Dokploy default) the box
// re-points to the fresh deployment on its own, no env paste, no manual redeploy. Downtime is one
// container restart.
//
// It also logs loudly when the package this process booted with has vanished on chain (a wipe in
// progress), so the logs explain why plays are failing while we wait for the fresh record to land.
//
// Disabled by default off production (DEPLOY_WATCH_ENABLED) so it never kills a local `bun dev`
// follower: locally the deploy script rewires .env and the dev server restart picks the ids up.

import path from 'path';

import cron from 'node-cron';

import {
  DEPLOY_WATCH_ENABLED,
  DEPLOY_WATCH_CRON,
  SUI_NETWORK,
  SELF_PUBLISH,
  SELF_PUBLISH_COOLDOWN_MS,
} from '../config/main-config.ts';
import { PACKAGE_ID } from '../lib/sui/config.ts';
import { readDeploymentRecord } from '../lib/deployment-store.ts';
import { suiClient } from '../lib/sui/client.ts';

// The package id config loaded at boot. A DB record carrying a different one means a fresh deploy.
const bootPackageId = PACKAGE_ID;
// Repo root in the operator image (/app): backend/src/workers -> ../../.. Holds scripts/ + contracts/.
const REPO_ROOT = process.env.PIPS_REPO_ROOT || path.resolve(import.meta.dir, '../../..');
let isRunning = false;
let warnedMissing = false;
let publishing = false;
let lastPublishAt = 0;

// Republish the whole Predict stack from inside the operator container after a wipe. Spawns the same
// recovery the local CLI uses (fund -> publish -> write the DB deploy record). On success the record's
// package id changes, so the next tick exits and the container restarts onto the fresh ids. Guarded by
// a single-flight flag + a cooldown so a devnet outage (publish fails/timeouts) retries calmly instead
// of hammering. The API keeps serving (the CHAIN_UNAVAILABLE door) while this runs in the background.
async function selfPublish(): Promise<void> {
  if (publishing) return;
  if (Date.now() - lastPublishAt < SELF_PUBLISH_COOLDOWN_MS) return;
  publishing = true;
  lastPublishAt = Date.now();
  console.warn(`[deploy-watch] wipe detected; self-publishing via scripts/devnet-refresh.sh recover (cwd ${REPO_ROOT})…`);
  try {
    const proc = Bun.spawn(['bash', path.join(REPO_ROOT, 'scripts/devnet-refresh.sh'), 'recover'], {
      cwd: REPO_ROOT,
      env: { ...process.env, AUTO: '1' },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const code = await proc.exited;
    if (code === 0) console.warn('[deploy-watch] self-publish OK; will adopt the fresh ids on the next tick.');
    else console.warn(`[deploy-watch] self-publish exited ${code} (devnet down or CLI lag?); retry after cooldown.`);
  } catch (e) {
    console.warn('[deploy-watch] self-publish spawn failed:', e instanceof Error ? e.message : e);
  } finally {
    publishing = false;
  }
}

const tick = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;
  try {
    const raw = await readDeploymentRecord();
    if (raw) {
      let pkg = '';
      try {
        pkg = (JSON.parse(raw) as { packageId?: string }).packageId ?? '';
      } catch {
        pkg = '';
      }
      if (pkg && pkg !== bootPackageId) {
        console.warn(
          `[deploy-watch] fresh ${SUI_NETWORK} deployment in DB (boot ${bootPackageId.slice(0, 10)}… -> ${pkg.slice(0, 10)}…). Restarting to adopt it.`,
        );
        // Clean exit -> the container restart policy brings us back, and preboot reloads the new ids.
        process.exit(0);
      }
    }

    // Liveness check: is the package we booted with still on chain? If it 404s, a wipe is underway and
    // every play is failing until the deployer republishes. Surface it once so the logs aren't silent,
    // and in self-publish mode kick off the republish ourselves.
    if (bootPackageId) {
      try {
        // gRPC throws "not found" when the package is gone; a successful read means it's live.
        let gone = false;
        try {
          await suiClient.getObject({ objectId: bootPackageId });
        } catch (readErr) {
          if ((readErr instanceof Error ? readErr.message : String(readErr)).toLowerCase().includes('not found')) gone = true;
          else throw readErr;
        }
        if (gone) {
          if (!warnedMissing) {
            warnedMissing = true;
            console.warn(
              `[deploy-watch] Predict package ${bootPackageId.slice(0, 10)}… is GONE on ${SUI_NETWORK} (chain wiped?). Plays will fail until a fresh deploy lands.${SELF_PUBLISH ? ' Self-publishing now.' : ' Run scripts/devnet-refresh.sh recover.'}`,
            );
          }
          if (SELF_PUBLISH) void selfPublish(); // single-flight + cooldown guarded; non-blocking
        } else {
          warnedMissing = false;
        }
      } catch {
        // RPC hiccup: ignore, try next tick.
      }
    }
  } catch (e) {
    console.warn('[deploy-watch] tick error:', e instanceof Error ? e.message : e);
  } finally {
    isRunning = false;
  }
};

export const startDeployWatch = (): void => {
  if (!DEPLOY_WATCH_ENABLED) return;
  console.log(
    `[deploy-watch] Scheduled: ${DEPLOY_WATCH_CRON} (boot pkg ${bootPackageId.slice(0, 10)}…, restarts on a fresh DB deploy record${SELF_PUBLISH ? ', self-publishes on a wipe' : ''})`,
  );
  cron.schedule(DEPLOY_WATCH_CRON, tick);
  tick(); // check immediately on boot
};
