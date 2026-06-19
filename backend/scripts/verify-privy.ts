// Phase 12 gate: prove the Privy server-signing recipe end to end against the live localnet,
// without a browser. It is the one subtle correctness point of the Privy swap (LUCKY.md §6):
//
//   does Privy's ed25519 rawSign over our blake2b256 intent digest yield a signature Sui accepts?
//
// What it proves: take a real Privy embedded Sui wallet (created by the client login flow or the
// dashboard), fund it with operator SUI for gas, then build + sign + submit a real Predict PTB
// (create_manager) entirely through the SAME production path the API uses (executeForUser ->
// signSuiTxWithPrivy). A green run here is the green light to wire Privy plays.
//
// It does NOT create the wallet or grant the session signer; those are the client's job
// (web/src/lib/privy.tsx does createWallet + addSigners at login). Supply the resulting wallet
// here so the spike stays a pure server-signing proof with nothing guessed.
//
// Prereqs (all user-provided, see the pause message in the build log):
//   - PIPS_AUTH_MODE=privy and PRIVY_APP_ID / PRIVY_APP_SECRET / PRIVY_AUTHORIZATION_KEY set in .env
//   - the local Sui node up + operator funded
//   - a Privy Sui wallet the app can sign for (session signer granted), passed via:
//       SPIKE_PRIVY_WALLET_ID, SPIKE_PRIVY_PUBLIC_KEY, SPIKE_PRIVY_ADDRESS
//
// Run from backend/:  bun run scripts/verify-privy.ts

import '../dotenv.ts';

import { Transaction } from '@mysten/sui/transactions';

import { AUTH_MODE } from '../src/config/main-config.ts';
import { explorerTxUrl } from '../src/lib/sui/client.ts';
import { operatorAddress } from '../src/lib/sui/signer.ts';
import { fundSui, getSuiBalanceRaw } from '../src/lib/sui/gas.ts';
import { buildCreateManager } from '../src/lib/sui/predict.ts';
import { executeForUser } from '../src/lib/sui/execute.ts';

const suiFromMist = (raw: bigint): number => Number(raw) / 1e9;

function die(msg: string): never {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  console.log('\n=== Privy server-signing spike (Phase 12 gate) ===\n');

  if (AUTH_MODE !== 'privy') {
    die('Set PIPS_AUTH_MODE=privy in backend/.env first (this spike exercises the privy branch).');
  }

  const walletId = process.env.SPIKE_PRIVY_WALLET_ID;
  const publicKey = process.env.SPIKE_PRIVY_PUBLIC_KEY;
  const address = process.env.SPIKE_PRIVY_ADDRESS;
  if (!walletId || !publicKey || !address) {
    die(
      'Provide the Privy Sui wallet to sign with:\n' +
        '    SPIKE_PRIVY_WALLET_ID=<wallet id>  SPIKE_PRIVY_PUBLIC_KEY=<ed25519 pubkey>  SPIKE_PRIVY_ADDRESS=<0x sui address>\n' +
        '  Get these from a client login (web/src/lib/privy.tsx logs them) or the Privy dashboard,\n' +
        '  and make sure the app has a session signer on that wallet so the server can rawSign it.',
    );
  }

  console.log(`  wallet   ${walletId}`);
  console.log(`  address  ${address}`);

  // 1) Fund operator SUI for gas. The user signs their own play gas in privy mode, so the wallet
  //    needs a SUI coin before it can submit anything.
  await fundSui(address);
  const sui = await getSuiBalanceRaw(address);
  console.log(`  gas      ${suiFromMist(sui).toFixed(4)} SUI (operator ${operatorAddress.slice(0, 10)}...)`);
  if (sui === 0n) die('Wallet still has 0 SUI after funding. Is the operator funded and the node reachable?');

  // 2) The proof: build a real Predict PTB (create_manager, no oracle needed), sign it with the
  //    user's wallet via Privy rawSign, and submit. This is the exact onboarding path.
  console.log('\n  signing create_manager via Privy rawSign (blake2b256 intent digest)...');
  const tx = new Transaction();
  buildCreateManager(tx);

  let digest: string;
  let managerId: string | undefined;
  try {
    const res = await executeForUser(tx, { address, walletId, publicKey });
    digest = res.digest;
    managerId = res.objectChanges.find(
      (c) => c.type === 'created' && c.objectType?.includes('::predict_manager::PredictManager'),
    )?.objectId;
  } catch (e) {
    die(`Privy-signed tx was rejected: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!managerId) die('Tx landed but no PredictManager was created. Check the Predict package ids.');

  console.log(`\n  ✓ tx accepted by Sui:  ${digest}`);
  console.log(`  ✓ PredictManager:      ${managerId}`);
  console.log(`  ✓ explorer:            ${explorerTxUrl(digest)}`);
  console.log('\n  PRIVY SIGNING SPIKE GREEN — Privy rawSign produces a Sui-acceptable signature.\n');
  console.log('  Next: wire this wallet through /auth/privy/verify and run a real Lucky play.\n');
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
