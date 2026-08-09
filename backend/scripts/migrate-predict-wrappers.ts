// One-time migration off Mysten's retired predict-testnet-6-24 deployment onto predict-testnet-7-29.
//
// The 7-29 redeploy ships a NEW AccountRegistry, so every user's derived AccountWrapper address changes
// and the cached User.predictWrapperId points at a wrapper on the dead deployment. Chips left inside the
// old wrapper are still withdrawable (the old account package is a plain balance store, unaffected by the
// oracle outage that killed pricing), so this sweeps them back to the user's wallet and clears the cache.
// The next play re-derives and creates the new wrapper, and the deposit step picks the chips back up.
//
// Dry run by default. Run `bun scripts/migrate-predict-wrappers.ts --apply` to execute.

import '../dotenv.ts';

import { Transaction } from '@mysten/sui/transactions';

import { prismaQuery } from '../src/lib/prisma.ts';
import { suiClient } from '../src/lib/sui/client.ts';
import { DUSDC_TYPE } from '../src/lib/sui/config.ts';
import { REAL_ACCUMULATOR_ROOT, REAL_CLOCK } from '../src/lib/sui/config-real.ts';
import { executeAsOperator, executeForUser, userContext } from '../src/lib/sui/execute.ts';
import { operatorAddress } from '../src/lib/sui/signer.ts';

// Retired 6-24 ids. Deliberately literal: this is historical data for a one-shot sweep, not live config,
// and it must not follow deployed-real.testnet.json forward to 7-29.
const OLD_ACCOUNT_PACKAGE = '0xb9389eac8d59170ffd1427c1a66e5c8306263464fcc6615e825c1f5b3e15da3b';

const APPLY = process.argv.includes('--apply');

const decodeU64 = (bytes: Uint8Array | number[] | null | undefined): bigint | null => {
  if (!bytes) return null;
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
};

const usd = (raw: bigint): string => (Number(raw) / 1e6).toFixed(6);

// Read a retired wrapper's DUSDC balance through the OLD account package; null if the object is gone or unreadable.
async function readOldBalance(wrapperId: string, owner: string): Promise<bigint | null> {
  try {
    const tx = new Transaction();
    const account = tx.moveCall({
      target: `${OLD_ACCOUNT_PACKAGE}::account::load_account`,
      arguments: [tx.object(wrapperId)],
    });
    tx.moveCall({
      target: `${OLD_ACCOUNT_PACKAGE}::account::balance`,
      typeArguments: [DUSDC_TYPE],
      arguments: [account, tx.object(REAL_ACCUMULATOR_ROOT), tx.object(REAL_CLOCK)],
    });
    tx.setSender(owner);
    const res = await suiClient.simulateTransaction({ transaction: tx, include: { commandResults: true }, checksEnabled: false });
    if (res.$kind !== 'Transaction') return null;
    const rv = (res.commandResults ?? []).at(-1)?.returnValues?.[0]?.bcs;
    return decodeU64(rv as Uint8Array | null);
  } catch {
    return null;
  }
}

const users = await prismaQuery.user.findMany({
  where: { predictWrapperId: { not: null } },
  select: { id: true, username: true, address: true, predictWrapperId: true, provider: true, privyWalletId: true, suiPublicKey: true, playWalletSecret: true },
});

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: ${users.length} user(s) hold a cached wrapper id from the retired deployment.\n`);

let swept = 0n;
let cleared = 0;
let failed = 0;

for (const u of users) {
  const oldId = u.predictWrapperId!;
  const balance = await readOldBalance(oldId, u.address);
  const label = `${u.username ?? u.id} ${u.address.slice(0, 10)} old=${oldId.slice(0, 12)}`;

  if (balance == null) {
    console.log(`${label} -> unreadable (already gone or never created), clearing cache only`);
  } else if (balance > 0n) {
    console.log(`${label} -> ${usd(balance)} DUSDC to sweep back to wallet`);
  } else {
    console.log(`${label} -> empty, clearing cache only`);
  }

  if (!APPLY) continue;

  if (balance != null && balance > 0n) {
    try {
      const tx = new Transaction();
      const auth = tx.moveCall({ target: `${OLD_ACCOUNT_PACKAGE}::account::generate_auth`, arguments: [] });
      const coin = tx.moveCall({
        target: `${OLD_ACCOUNT_PACKAGE}::account::withdraw_funds`,
        typeArguments: [DUSDC_TYPE],
        arguments: [tx.object(oldId), auth, tx.pure.u64(balance), tx.object(REAL_ACCUMULATOR_ROOT), tx.object(REAL_CLOCK)],
      });
      tx.transferObjects([coin], tx.pure.address(u.address));
      // withdraw_funds takes OWNER auth off ctx.sender(), so each sweep signs as that user. The seeded dev
      // account has no Privy wallet and its address IS the operator, so it signs through the operator path.
      const res =
        u.provider === 'dev' && u.address === operatorAddress
          ? await executeAsOperator(tx, 'wrapper migration sweep')
          : await executeForUser(tx, userContext(u as Parameters<typeof userContext>[0]));
      swept += balance;
      console.log(`   swept ${usd(balance)} DUSDC -> ${u.address.slice(0, 10)} (${res.digest})`);
    } catch (e) {
      failed++;
      console.error(`   SWEEP FAILED, keeping cache so it can be retried: ${e instanceof Error ? e.message : e}`);
      continue; // leave predictWrapperId set so a re-run picks this user up again
    }
  }

  await prismaQuery.user.update({ where: { id: u.id }, data: { predictWrapperId: null } });
  cleared++;
}

console.log(
  `\n${APPLY ? 'Done' : 'Dry run complete'}: ${cleared} cache(s) cleared, ${usd(swept)} DUSDC swept, ${failed} failure(s).` +
    (APPLY ? '' : '\nRe-run with --apply to execute.'),
);
