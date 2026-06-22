// Publish the freshly-bootstrapped deploy record into the shared DB so the deployed box self-heals.
// Run from backend/ after a successful bootstrap (the devnet recovery script does this for you):
//
//   bun scripts/publish-deploy-record.ts
//
// It reads the on-disk deployed.<network>.json the bootstrap just wrote and upserts it into AppConfig
// under "deployment.<network>". The box's deploy-watch worker then sees the new package id and restarts
// onto it. Requires the AppConfig table (run `bun run db:push` once); otherwise it fails with a clear hint.

import fs from 'fs';
import path from 'path';

import { SUI_NETWORK } from '../src/config/main-config.ts';
import { writeDeploymentRecord } from '../src/lib/deployment-store.ts';

const file = SUI_NETWORK === 'testnet' ? 'deployed.json' : `deployed.${SUI_NETWORK}.json`;
const p = path.resolve(import.meta.dir, '../src/lib/sui', file);

if (!fs.existsSync(p)) {
  console.error(`[publish-deploy-record] ${file} not found. Run the bootstrap first (scripts/devnet-recover.sh deploy).`);
  process.exit(1);
}

const raw = fs.readFileSync(p, 'utf-8');

try {
  await writeDeploymentRecord(raw, SUI_NETWORK);
  const d = JSON.parse(raw) as { packageId: string; bootstrappedAt?: string };
  console.log(`[publish-deploy-record] wrote ${file} -> DB key "deployment.${SUI_NETWORK}" (pkg ${d.packageId.slice(0, 10)}…, ${d.bootstrappedAt ?? 'unknown'}).`);
  console.log('[publish-deploy-record] the deployed box will adopt these ids on its next deploy-watch tick.');
  process.exit(0);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[publish-deploy-record] failed: ${msg}`);
  if (/relation|table|appConfig|does not exist|P2021/i.test(msg)) {
    console.error('[publish-deploy-record] the AppConfig table is missing. Run `bun run db:push` from backend/ once, then retry.');
  }
  process.exit(1);
}
