// Transaction execution. Operator txs (price pushes, oracle ops, dev-mode plays) sign
// with the operator key and submit here. The enoki sponsorship path for user-signed
// plays is added in the auth phase.

import type { Transaction } from '@mysten/sui/transactions';

import { suiClient } from './client.ts';
import { operatorKeypair, operatorAddress } from './signer.ts';

export type ExecResult = {
  digest: string;
  objectChanges: Array<{ type: string; objectId?: string; objectType?: string }>;
};

// Sign with the operator key and submit. Throws on a non-success status so callers can
// surface a clean error. Waits for the tx so reads after it see the new state.
export async function executeAsOperator(tx: Transaction, label: string): Promise<ExecResult> {
  tx.setSenderIfNotSet(operatorAddress);
  const res = await suiClient.signAndExecuteTransaction({
    transaction: tx,
    signer: operatorKeypair,
    options: { showEffects: true, showObjectChanges: true },
  });
  if (res.effects?.status.status !== 'success') {
    throw new Error(`${label} failed: ${JSON.stringify(res.effects?.status)}`);
  }
  await suiClient.waitForTransaction({ digest: res.digest });
  return {
    digest: res.digest,
    objectChanges: (res.objectChanges as ExecResult['objectChanges']) ?? [],
  };
}
