// Transaction execution. Operator txs (price pushes, oracle ops) sign with the operator
// key. User plays split by AUTH_MODE: dev mode signs + submits with the dev key (the
// backend IS the user); enoki mode sponsors the play via Enoki and hands the client bytes
// to sign, then submits on confirm. Enoki method names verified against @mysten/enoki 1.1.

import { Transaction, SerialTransactionExecutor } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { EnokiClient } from '@mysten/enoki';

import { AUTH_MODE, ENOKI_PRIVATE_API_KEY, SUI_NETWORK } from '../../config/main-config.ts';
import { suiClient } from './client.ts';
import { operatorKeypair } from './signer.ts';

export type ExecResult = {
  digest: string;
  objectChanges: Array<{ type: string; objectId?: string; objectType?: string }>;
};

// One serial executor for EVERY operator-signed tx: the cron workers (push, roll, settle), the
// settle redeems, dev-mode plays, and DUSDC mints. The operator has a single gas coin and the
// single oracle cap, both fast-path owned objects, so concurrent submissions from the same
// sender equivocate ("object unavailable for consumption / already locked by a different
// transaction"). SerialTransactionExecutor fixes that at the root: it runs every tx through one
// internal queue, reuses the gas coin, and chains owned-object versions from each tx's effects
// instead of re-reading them from the node. That removes the version races AND the extra
// waitForTransaction round-trip, dropping operator latency from ~3.9s to ~0.8s per tx over the
// remote node, which is what lets the 3-asset 30s ladder actually stay fresh. The gas budget is
// a generous cap (covers the storage-heavy create_oracle; the rest is refunded). EVERY operator
// tx must go through here, a side path that signs as the operator would desync the gas cache.
const operatorExecutor = new SerialTransactionExecutor({
  client: suiClient,
  signer: operatorKeypair,
  defaultGasBudget: 1_000_000_000n,
});

// Sign + submit as the operator through the serial executor. Throws on a reverted/failed tx.
// objectChanges is reduced to the created objects (with their Move type), which is all any
// caller reads (the new oracle / manager id).
export async function executeAsOperator(tx: Transaction, label: string): Promise<ExecResult> {
  const out = await operatorExecutor.executeTransaction(tx, { objectTypes: true });
  const t = out.$kind === 'Transaction' ? out.Transaction : null;
  if (!t || t.effects?.status?.success !== true) {
    const status = t?.effects?.status ?? (out.$kind === 'FailedTransaction' ? out.FailedTransaction.status : out);
    throw new Error(`${label} failed: ${JSON.stringify(status)}`);
  }
  const objectChanges = (t.effects.changedObjects ?? [])
    .filter((o) => o.idOperation === 'Created')
    .map((o) => ({ type: 'created', objectId: o.objectId, objectType: t.objectTypes?.[o.objectId] }));
  return { digest: t.digest ?? t.effects.transactionDigest ?? '', objectChanges };
}

// Enoki has no localnet prover; localnet always runs dev auth mode (this path is never hit
// there), so fall back to testnet to keep the type honest.
const ENOKI_NETWORK = (SUI_NETWORK === 'localnet' ? 'testnet' : SUI_NETWORK) as 'mainnet' | 'testnet' | 'devnet';

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
    // dev plays sign as the operator too, so they share the same serial executor (one gas coin).
    const res = await executeAsOperator(tx, 'play');
    return { mode: 'dev', digest: res.digest, objectChanges: res.objectChanges };
  }

  // enoki: build the kind bytes, let Enoki own gas, return bytes for the client to sign.
  // Sender must be set so coin-selection intents (coinWithBalance) resolve the user's
  // DUSDC, even though the sender is not encoded into the kind-only bytes.
  tx.setSenderIfNotSet(ctx.address);
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
