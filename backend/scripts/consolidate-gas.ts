// Consolidate the operator's SUI coin objects down to a small count.
//
//   bun scripts/consolidate-gas.ts
//
// Why: the devnet faucet hands out hundreds of tiny SUI coins. Once the operator holds a few
// hundred, the `sui` CLI's gas-coin discovery stalls, so `sui client gas` and `bun run bootstrap`
// (which shells out to `sui client publish`) hang forever at "[1/6] Publishing DUSDC...". This is
// coin fragmentation, not the RPC transport, so switching the CLI to gRPC does nothing.
//
// The fix is to merge those coins into a handful. We keep ~15 (not 1): a single coin makes the
// CLI publish contend with the SDK seed step on the same gas version. This signs as the operator
// and sets the gas payment explicitly, so the merge tx itself never triggers the hanging discovery.

import { Transaction } from '@mysten/sui/transactions';
import { suiClient } from '../src/lib/sui/client.ts';
import { operatorKeypair, operatorAddress } from '../src/lib/sui/signer.ts';

const KEEP = 15; // target coin count to leave behind
const MERGE_PER_TX = 400; // input-object headroom under the PTB cap

async function allSuiCoins() {
  const coins: { objectId: string; version: string; digest: string; balance: string }[] = [];
  let cursor: string | null = null;
  do {
    const page = await suiClient.listCoins({ owner: operatorAddress, coinType: '0x2::sui::SUI', cursor, limit: 200 });
    coins.push(...page.objects.map((c) => ({ objectId: c.objectId, version: c.version, digest: c.digest, balance: c.balance })));
    cursor = page.hasNextPage ? page.cursor : null;
  } while (cursor);
  return coins;
}

async function main() {
  console.log(`Operator ${operatorAddress}`);
  let coins = await allSuiCoins();
  console.log(`Holding ${coins.length} SUI coins.`);
  if (coins.length <= KEEP + 1) {
    console.log('Already consolidated, nothing to do.');
    return;
  }

  // coins[0] pays gas (stays separate). Everything past the KEEP window folds into coins[1].
  const gas = coins[0];
  const dest = coins[1];
  const sources = coins.slice(KEEP + 1);
  console.log(`Merging ${sources.length} coins into 1, keeping ~${KEEP}. Gas coin ${gas.objectId.slice(0, 10)}.`);

  for (let i = 0; i < sources.length; i += MERGE_PER_TX) {
    const batch = sources.slice(i, i + MERGE_PER_TX);
    const tx = new Transaction();
    tx.setSender(operatorAddress);
    tx.setGasPayment([{ objectId: gas.objectId, version: gas.version, digest: gas.digest }]);
    tx.setGasBudget(2_000_000_000n);
    tx.mergeCoins(
      tx.object(dest.objectId),
      batch.map((c) => tx.object(c.objectId)),
    );
    const res = await suiClient.signAndExecuteTransaction({
      signer: operatorKeypair,
      transaction: tx,
      include: { effects: true },
    });
    const t = res.$kind === 'Transaction' ? res.Transaction : null;
    if (t?.effects?.status?.success !== true) throw new Error(`merge batch failed: ${JSON.stringify(t?.effects?.status ?? res)}`);
    // gas coin version advances each tx; refresh so the next batch pays with the live ref.
    const fresh = await suiClient.getObject({ objectId: gas.objectId });
    gas.version = fresh.object.version;
    gas.digest = fresh.object.digest;
    console.log(`  merged ${Math.min(i + MERGE_PER_TX, sources.length)}/${sources.length}`);
  }

  coins = await allSuiCoins();
  console.log(`Done. Operator now holds ${coins.length} SUI coins.`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
