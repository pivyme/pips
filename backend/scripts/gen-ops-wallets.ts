// One-time generator for the dedicated ops wallets (settlement + treasury). Appends any missing key
// to backend/.env (idempotent: never clobbers an existing non-empty value), then prints the
// addresses. Copy the printed env lines into the deployed server's .env too, both processes must use
// the SAME treasury wallet (the operator funds it; followers pay onboarding/faucet from it).
//
//   bun scripts/gen-ops-wallets.ts
//
// Settlement is only USED on the operator (the redeem sweep is operator-gated), but setting it
// everywhere is harmless. The operator auto-funds both wallets on boot (ensureOpsFunded).

import fs from 'fs';
import path from 'path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const ENV_PATH = path.resolve(import.meta.dir, '..', '.env');

const WALLETS = [
  { key: 'SETTLEMENT_WALLET_PK', label: 'Settlement (permissionless redeem sweep)' },
  { key: 'TREASURY_WALLET_PK', label: 'Treasury (DUSDC chips: onboarding + faucet)' },
] as const;

const env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf-8') : '';

const hasValue = (key: string): string | null => {
  const m = env.match(new RegExp(`^${key}=(.+)$`, 'm'));
  return m && m[1].trim() ? m[1].trim() : null;
};

const additions: string[] = [];
console.log('\nOps wallets:\n');
for (const { key, label } of WALLETS) {
  const existing = hasValue(key);
  if (existing) {
    const kp = Ed25519Keypair.fromSecretKey(existing);
    console.log(`  ${label}\n    ${key} already set\n    address ${kp.getPublicKey().toSuiAddress()}\n`);
    continue;
  }
  const kp = Ed25519Keypair.generate();
  const pk = kp.getSecretKey(); // suiprivkey1... bech32 envelope
  additions.push(`${key}=${pk}`);
  console.log(`  ${label}\n    generated -> ${key}\n    address ${kp.getPublicKey().toSuiAddress()}\n`);
}

if (additions.length > 0) {
  const block = `\n# Dedicated ops wallets (gen-ops-wallets.ts). Mirror these to the deployed server's .env.\n${additions.join('\n')}\n`;
  fs.appendFileSync(ENV_PATH, block);
  console.log(`Wrote ${additions.length} key(s) to ${ENV_PATH}`);
  console.log('Copy the new line(s) into the DEPLOYED server .env as well, then restart the operator.\n');
} else {
  console.log('Nothing to do, both keys already present.\n');
}
