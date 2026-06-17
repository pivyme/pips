// Transaction execution. Operator txs (price pushes, oracle ops) sign with the operator
// key. User plays split by AUTH_MODE: dev mode signs + submits with the dev key (the
// backend IS the user); enoki mode sponsors the play via Enoki and hands the client bytes
// to sign, then submits on confirm. Enoki method names verified against @mysten/enoki 1.1.

import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { EnokiClient } from '@mysten/enoki';

import { AUTH_MODE, ENOKI_PRIVATE_API_KEY, SUI_NETWORK } from '../../config/main-config.ts';
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

const ENOKI_NETWORK = SUI_NETWORK as 'mainnet' | 'testnet' | 'devnet';

let enoki: EnokiClient | null = null;
function enokiClient(): EnokiClient {
  if (!enoki) {
    if (!ENOKI_PRIVATE_API_KEY) throw new Error('ENOKI_PRIVATE_API_KEY is not set (required in enoki mode)');
    enoki = new EnokiClient({ apiKey: ENOKI_PRIVATE_API_KEY });
  }
  return enoki;
}

export type UserContext = { address: string };

// dev: the play already executed (digest + object changes). enoki: a sponsored envelope the
// client must sign, then send back to /plays/:id/confirm to submit via executeSponsored.
export type UserExec =
  | { mode: 'dev'; digest: string; objectChanges: ExecResult['objectChanges'] }
  | { mode: 'enoki'; digest: string; bytes: string };

// Execute (dev) or sponsor (enoki) a user's play transaction.
export async function executeForUser(tx: Transaction, ctx: UserContext): Promise<UserExec> {
  if (AUTH_MODE === 'dev') {
    tx.setSenderIfNotSet(operatorAddress);
    const res = await suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: operatorKeypair,
      options: { showEffects: true, showObjectChanges: true },
    });
    if (res.effects?.status.status !== 'success') {
      throw new Error(`play failed: ${JSON.stringify(res.effects?.status)}`);
    }
    await suiClient.waitForTransaction({ digest: res.digest });
    return { mode: 'dev', digest: res.digest, objectChanges: (res.objectChanges as ExecResult['objectChanges']) ?? [] };
  }

  // enoki: build the kind bytes, let Enoki own gas, return bytes for the client to sign.
  const kindBytes = await tx.build({ client: suiClient, onlyTransactionKind: true });
  const sponsored = await enokiClient().createSponsoredTransaction({
    network: ENOKI_NETWORK,
    sender: ctx.address,
    transactionKindBytes: toBase64(kindBytes),
  });
  return { mode: 'enoki', digest: sponsored.digest, bytes: sponsored.bytes };
}

// Submit a sponsored tx once the client has signed the envelope bytes (enoki confirm path).
export async function executeSponsored(digest: string, signature: string): Promise<string> {
  const res = await enokiClient().executeSponsoredTransaction({ digest, signature });
  await suiClient.waitForTransaction({ digest: res.digest });
  return res.digest;
}
