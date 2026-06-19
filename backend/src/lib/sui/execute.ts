// Transaction execution. Operator txs (price pushes, oracle ops, DUSDC/SUI funding) sign with
// the operator key. User plays split by AUTH_MODE: dev mode signs + submits with the operator
// key (the backend IS the user); privy mode signs with the user's embedded ed25519 wallet via
// Privy rawSign under a session signer, then submits. Both modes finalize server-side, no client
// round trip and no sponsor envelope.

import { Transaction, SerialTransactionExecutor } from '@mysten/sui/transactions';

import { AUTH_MODE } from '../../config/main-config.ts';
import { suiClient } from './client.ts';
import { operatorKeypair } from './signer.ts';
import { signSuiTxWithPrivy } from './privy.ts';

export type ExecResult = {
  digest: string;
  objectChanges: Array<{ type: string; objectId?: string; objectType?: string }>;
};

// One serial executor for EVERY operator-signed tx: the cron workers (push, roll, settle), the
// settle redeems, dev-mode plays, and DUSDC/SUI funding. The operator has a single gas coin and
// the single oracle cap, both fast-path owned objects, so concurrent submissions from the same
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

// Cache the network's reference gas price (per-epoch, near-constant on localnet). Setting it on the
// tx lets tx.build skip its own getReferenceGasPrice round trip. We deliberately do NOT pin the gas
// budget: a Predict mint's GROSS storage cost (~0.21 SUI before rebate) sits close to the user's SUI
// funding floor, so the build-time dry-run that sizes the budget to the real cost has to stay.
let gasPriceCache: { price: bigint; at: number } | null = null;
async function refGasPrice(): Promise<bigint> {
  const now = Date.now();
  if (gasPriceCache && now - gasPriceCache.at < 60_000) return gasPriceCache.price;
  const price = await suiClient.getReferenceGasPrice();
  gasPriceCache = { price, at: now };
  return price;
}

// Reject if a promise outruns its budget, so a stuck network call can never hang a request. The
// underlying call is not aborted (it may still complete on the node), the caller just stops waiting.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// What a privy play needs to sign on the user's behalf.
export type UserContext = { address: string; walletId?: string | null; publicKey?: string | null };

// Execute a user's play. dev signs as the operator (same serial executor, one gas coin). privy
// builds the PTB with the user as sender, signs the intent digest with the user's wallet via
// Privy rawSign (session signer), and submits. Both return the finalized result.
export async function executeForUser(tx: Transaction, ctx: UserContext): Promise<ExecResult> {
  if (AUTH_MODE === 'dev') {
    return executeAsOperator(tx, 'play');
  }

  // privy: the user owns the wallet, so they sign. The session signer lets the server produce
  // the signature with no popup. Requires the provisioned wallet id + public key.
  if (!ctx.walletId || !ctx.publicKey) {
    throw new Error('privy play: user wallet not provisioned (missing walletId / publicKey)');
  }
  tx.setSender(ctx.address);
  tx.setGasPrice(await refGasPrice()); // skip build's own reference-gas-price round trip
  // Hard timeouts so a stalled node/Privy connection surfaces a clean error instead of leaving the
  // play pending forever. Build/sign make no chain change. Submit is given more room and its timeout
  // is deliberately not retried upstream (the tx could still land, so a retry could double-mint).
  const txBytes = await withTimeout(tx.build({ client: suiClient }), 15_000, 'tx build');
  const signature = await withTimeout(signSuiTxWithPrivy({ walletId: ctx.walletId, publicKey: ctx.publicKey, txBytes }), 15_000, 'privy sign');

  const res = await withTimeout(
    suiClient.executeTransactionBlock({
      transactionBlock: txBytes,
      signature,
      options: { showEffects: true, showObjectChanges: true },
    }),
    25_000,
    'submit',
  );
  if (res.effects?.status?.status !== 'success') {
    throw new Error(`privy play failed: ${JSON.stringify(res.effects?.status ?? res)}`);
  }
  const objectChanges = (res.objectChanges ?? [])
    .filter((c) => c.type === 'created')
    .map((c) => ({ type: 'created', objectId: 'objectId' in c ? c.objectId : undefined, objectType: 'objectType' in c ? c.objectType : undefined }));
  return { digest: res.digest, objectChanges };
}
