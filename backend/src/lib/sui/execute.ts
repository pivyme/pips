// Transaction execution: operator txs sign with the operator key; user plays split by AUTH_MODE
// (dev = operator key, privy = user's embedded wallet via Privy rawSign under a session signer, sponsor co-signs gas). Both finalize server-side, no client round trip.

import { Transaction, SerialTransactionExecutor, TransactionDataBuilder } from '@mysten/sui/transactions';

import type { User } from '../../../prisma/generated/client.js';
import { AUTH_MODE, PLAY_GAS_BUDGET } from '../../config/main-config.ts';
import { suiClient } from './client.ts';
import { operatorKeypair, operatorAddress, settlementKeypair, settlementAddress, treasuryKeypair, treasuryAddress, revenueKeypair, revenueAddress } from './signer.ts';
import { signSuiTxWithPrivy } from './privy.ts';
import { loadCustodialKeypair } from './custodial.ts';
import { SPONSOR_ENABLED, applySponsorGas, signAsSponsor, ensureSponsorAccumulator, isSponsorGasError } from './sponsor.ts';

export type ExecResult = {
  digest: string;
  objectChanges: Array<{ type: string; objectId?: string; objectType?: string }>;
  events: Array<{ type: string; parsedJson: Record<string, unknown> | null }>;
};

// One serial executor for EVERY operator-signed tx (cron workers, settle redeems, dev-mode plays, funding): the operator's owned gas coin + oracle cap equivocate under concurrent signers, so this queues txs and chains owned-object versions from effects instead of re-reading the node, cutting latency ~3.9s -> ~0.8s per tx (what keeps the 3-asset ladder fresh).
// Gas budget is a generous cap (covers the storage-heavy create_oracle, rest refunded); every operator tx must go through here, a side path would desync the gas cache.
const operatorExecutor = new SerialTransactionExecutor({
  client: suiClient,
  signer: operatorKeypair,
  defaultGasBudget: 1_000_000_000n,
});

// Dedicated serial executor for the settle-redeem sweep on its own wallet + gas coin. Redeem is permissionless (no oracle cap needed), so isolating it stops a slow redeem from blocking the operator's price-push + oracle-nudge lane (which share one serial gas coin).
// Null when no settlement wallet is configured, redeems then fall back to the operator executor.
const settlementExecutor = settlementKeypair
  ? new SerialTransactionExecutor({ client: suiClient, signer: settlementKeypair, defaultGasBudget: 1_000_000_000n })
  : null;

// Hard ceiling on a single operator tx. Normally finalizes in ~1-3s, but a stalled submit on the remote node would otherwise hang whatever worker awaited it (e.g. settle's isRunning flag stuck, stranding every play on SETTLING forever).
// On timeout we stop waiting, not abort: a nudge/push is idempotent and a settle redeem retries next tick, so the worker recovers on its own.
const OPERATOR_TX_TIMEOUT_MS = 25_000;

// User play submit budget, plus how long to keep confirming a timed-out submit by its digest before concluding it never finalized (a timeout is not treated as failure, the tx may still be landing).
// Only engages when the node is badly degraded; a healthy submit returns in ~1-3s.
const SUBMIT_TIMEOUT_MS = 25_000;
const SUBMIT_RECONCILE_MS = 20_000;

// Stale owned-object cache: the serial executor's version cache goes stale when another process signs as the same operator (the deployed backend running the same workers against the same key) and advances a shared owned object (gas coin, DUSDC TreasuryCap). The node then rejects the BUILD at input-object check before it ever executes, so a rebuild from fresh node state is always safe (no double-spend).
// resetCache() drops the stale entries so the next tx re-resolves versions from the node; retries are bounded and jittered so a brief race resolves without 500ing a login.
const STALE_OBJECT_RETRIES = 5;

function isStaleObjectError(e: unknown): boolean {
  if (e instanceof TimeoutError) return false; // a timed-out tx may still be in flight, never retry it
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    m.includes('unavailable for consumption') ||
    m.includes('not available for consumption') ||
    m.includes('needs to be rebuilt') ||
    m.includes('locked by a different') ||
    m.includes('objectversionunavailable') ||
    m.includes('equivocat')
  );
}

// Sign + submit as the operator through the serial executor. Retries a stale-object-cache rejection after resetting the cache (the rejected build never ran); a genuine revert surfaces immediately.
// opts.retries widens attempts/backoff for patient background callers (settle, oracle nudge) racing a competing operator signer; opts.freshFirst re-resolves owned-object versions before attempt 0 instead of after the first failure, since the cache is usually already stale by the time a background call fires.
async function runViaExecutor(executor: SerialTransactionExecutor, tx: Transaction, label: string, opts?: { retries?: number; freshFirst?: boolean }): Promise<ExecResult> {
  const maxRetries = Math.max(1, opts?.retries ?? STALE_OBJECT_RETRIES);
  if (opts?.freshFirst) await withTimeout(executor.resetCache(), 8_000, 'resetCache').catch(() => { });
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await withTimeout(
        executor.executeTransaction(tx, { objectTypes: true, events: true }),
        OPERATOR_TX_TIMEOUT_MS,
        `${label}`,
      );
      const t = out.$kind === 'Transaction' ? out.Transaction : null;
      if (!t || t.effects?.status?.success !== true) {
        const status = t?.effects?.status ?? (out.$kind === 'FailedTransaction' ? out.FailedTransaction.status : out);
        throw new Error(`${label} failed: ${JSON.stringify(status)}`);
      }
      const objectChanges = (t.effects.changedObjects ?? [])
        .filter((o) => o.idOperation === 'Created')
        .map((o) => ({ type: 'created', objectId: o.objectId, objectType: t.objectTypes?.[o.objectId] }));
      const events = (t.events ?? []).map((event) => ({
        type: event.eventType,
        parsedJson: event.json,
      }));
      return { digest: t.digest ?? t.effects.transactionDigest ?? '', objectChanges, events };
    } catch (e) {
      if (!isStaleObjectError(e) || attempt >= maxRetries - 1) throw e;
      console.warn(`[exec] ${label}: stale object cache, resetting and retrying (${attempt + 1}/${maxRetries - 1})`);
      // Bounded (a wedged waitForLastTransaction can't hang the retry); failure to reset is non-fatal, the next build re-resolves against the node.
      await withTimeout(executor.resetCache(), 8_000, 'resetCache').catch(() => { });
      // Backoff grows with wide jitter so retries desync from a competing operator's ~2s rhythm instead of bunching, capped so a patient call stays bounded.
      await new Promise((r) => setTimeout(r, Math.min(1200, 150 * (attempt + 1)) + Math.floor(Math.random() * 300)));
    }
  }
}

// Sign + submit as the operator (price pushes, oracle ops, settle-nudge, DUSDC/SUI funding/mint).
export function executeAsOperator(tx: Transaction, label: string, opts?: { retries?: number; freshFirst?: boolean }): Promise<ExecResult> {
  return runViaExecutor(operatorExecutor, tx, label, opts);
}

// Sign + submit the permissionless settle-redeem sweep on the dedicated settlement wallet (own gas coin) so it can't block the operator's price/nudge lane.
// Falls back to the operator executor when no settlement wallet is configured.
export function executeAsSettlement(tx: Transaction, label: string, opts?: { retries?: number; freshFirst?: boolean }): Promise<ExecResult> {
  return runViaExecutor(settlementExecutor ?? operatorExecutor, tx, label, opts);
}

// Real-mode settle-redeem: redeem_settled is all shared inputs, and when the paying wallet holds SUI as an address balance (routine on testnet) the resolver pays gas with no coin object, so the coin-caching SerialTransactionExecutor's post-exec cacheGasCoin throws "Gas object not found in effects" AFTER the redeem already landed, discarding the result and dropping the play into a slow reconcile-retry loop.
// This direct build-sign-submit path reads effects.status only (never the gas coin), so it finalizes on the first tick either way; serialized on its own chain so concurrent settles don't equivocate. Real-mode only, fork settle keeps the serial executor (its operator holds owned faucet coins, so the resolver never picks address-balance gas).
let settleChain: Promise<unknown> = Promise.resolve();
export function executeRealSettle(tx: Transaction, label: string): Promise<ExecResult> {
  const kp = settlementKeypair ?? operatorKeypair;
  const addr = settlementKeypair ? settlementAddress : operatorAddress;
  const run = settleChain.then(async () => {
    tx.setSender(addr);
    tx.setGasPrice(await refGasPrice()); // skip build's own reference-gas-price round trip
    tx.setGasBudget(PLAY_GAS_BUDGET); // pin so build skips its gas-sizing dry-run; resolver still picks the payment
    const txBytes = await withTimeout(tx.build({ client: suiClient }), 15_000, `${label} build`);
    const { signature } = await kp.signTransaction(txBytes);
    const digest = TransactionDataBuilder.getDigestFromBytes(txBytes);
    const res = await submitAndConfirm(txBytes, signature, digest);
    return toExecResult(res, label);
  });
  // Keep the chain alive regardless of this tx's outcome so one failed settle doesn't wedge the next.
  settleChain = run.catch(() => { });
  return run;
}

// Cache the network's reference gas price (per-epoch, near-constant) so tx.build skips its own round trip; pinning the gas budget (PLAY_GAS_BUDGET) similarly skips build's gas-sizing dry-run.
// A mint's gross gas is ~0.21 SUI, well under the pinned 0.5; under sponsorship the storage rebate just credits the sponsor.
let gasPriceCache: { price: bigint; at: number } | null = null;
async function refGasPrice(): Promise<bigint> {
  const now = Date.now();
  if (gasPriceCache && now - gasPriceCache.at < 60_000) return gasPriceCache.price;
  const price = BigInt((await suiClient.getReferenceGasPrice()).referenceGasPrice);
  gasPriceCache = { price, at: now };
  return price;
}

// A sponsored tx (empty gas payment, drawn from the sponsor's SUI address balance) needs a ValidDuring expiration: Predict txs are all shared-object inputs (no owned input) and the gRPC resolver, unlike the generic core one, does not auto-add it at build(), so without this the node rejects at input-object check (was looping manager creation, would block every sponsored play).
// Epoch + chain id are cached: devnet/localnet epochs are long, and a stale-by-one epoch stays valid since the window spans [epoch, epoch+1].
let chainCtxCache: { epoch: bigint; chain: string; at: number } | null = null;
async function chainCtx(): Promise<{ epoch: bigint; chain: string }> {
  const now = Date.now();
  if (chainCtxCache && now - chainCtxCache.at < 30_000) return chainCtxCache;
  const [state, id] = await Promise.all([
    suiClient.core.getCurrentSystemState(),
    suiClient.core.getChainIdentifier(),
  ]);
  chainCtxCache = { epoch: BigInt(state.systemState.epoch), chain: id.chainIdentifier, at: now };
  return chainCtxCache;
}

// Warm the play-path caches (gas price, sponsor epoch/chain) at boot so the first sponsored play after
// a restart doesn't eat the cold-read cost; best-effort, never throws.
export async function warmExecuteCaches(): Promise<void> {
  await Promise.all([
    refGasPrice().catch(() => {}),
    SPONSOR_ENABLED ? chainCtx().catch(() => {}) : Promise.resolve(),
  ]);
}

async function applySponsorExpiration(tx: Transaction): Promise<void> {
  const { epoch, chain } = await chainCtx();
  tx.setExpiration({
    ValidDuring: {
      minEpoch: epoch.toString(),
      maxEpoch: (epoch + 1n).toString(),
      minTimestamp: null,
      maxTimestamp: null,
      chain,
      nonce: (Math.random() * 0x100000000) >>> 0,
    },
  });
}

// Tagged so callers can tell a budget overrun (may still land on the node) apart from a real, definite rejection.
class TimeoutError extends Error { }

// Reject if a promise outruns its budget so a stuck call can't hang a request; the underlying call isn't aborted, it may still complete on the node.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// Submit a user play, reconciling an ambiguous TIMED-OUT submit against its precomputed digest instead of treating it as failure (which would mark the play 'error' while a real position might exist).
// A clean rejection (a real revert) surfaces immediately; if the digest never appears within the reconcile window, the tx genuinely never finalized.
async function submitAndConfirm(txBytes: Uint8Array, signature: string | string[], digest: string) {
  const signatures = Array.isArray(signature) ? signature : [signature];
  try {
    return await withTimeout(
      suiClient.executeTransaction({
        transaction: txBytes,
        signatures,
        include: { effects: true, objectTypes: true, events: true },
      }),
      SUBMIT_TIMEOUT_MS,
      'submit',
    );
  } catch (e) {
    if (!(e instanceof TimeoutError)) throw e;
    // The submit outran its budget; don't resubmit (a fresh tx could double-mint), confirm THIS digest instead (waitForTransaction self-bounds via timeout).
    return await suiClient.waitForTransaction({
      digest,
      timeout: SUBMIT_RECONCILE_MS,
      include: { effects: true, objectTypes: true, events: true },
    });
  }
}

// Normalize a gRPC execute/wait result into ExecResult, throwing a labelled error on a failed/reverted tx (mirrors the serial-executor parse in runViaExecutor).
type FullTxResult = Awaited<ReturnType<typeof submitAndConfirm>>;
function toExecResult(out: FullTxResult, label: string): ExecResult {
  const t = out.$kind === 'Transaction' ? out.Transaction : null;
  if (!t || t.effects?.status?.success !== true) {
    const status = t?.effects?.status ?? (out.$kind === 'FailedTransaction' ? out.FailedTransaction.status : out);
    throw new Error(`${label} failed: ${JSON.stringify(status)}`);
  }
  const objectChanges = (t.effects.changedObjects ?? [])
    .filter((o) => o.idOperation === 'Created')
    .map((o) => ({ type: 'created', objectId: o.objectId, objectType: t.objectTypes?.[o.objectId] }));
  const events = (t.events ?? []).map((event) => ({ type: event.eventType, parsedJson: event.json }));
  return { digest: t.digest ?? t.effects.transactionDigest ?? '', objectChanges, events };
}

// Submit a sponsored user tx, self-healing an empty gas accumulator: if the node rejects on the sponsor's address-balance reservation (e.g. right after a devnet wipe), top it up and retry the SAME bytes once.
// Safe because the reservation is checked at input validation before execution, so a rejected tx never ran; any other error (or a second failure) surfaces normally.
async function submitSponsored(txBytes: Uint8Array, signature: string | string[], digest: string) {
  try {
    return await submitAndConfirm(txBytes, signature, digest);
  } catch (e) {
    if (!SPONSOR_ENABLED || !isSponsorGasError(e)) throw e;
    console.warn('[sponsor] gas accumulator empty, topping up and retrying the play once');
    await ensureSponsorAccumulator(true);
    return await submitAndConfirm(txBytes, signature, digest);
  }
}

// DUSDC payouts (onboarding chips, the faucet) sign with the treasury wallet via the same build-sign-submit path withdraw uses, not the serial executor, serialized through one in-process chain so concurrent payouts never pick the same gas/DUSDC coin and equivocate.
// Low frequency (onboarding once per user, faucet cooldown-gated), so a per-tx build round trip is fine.
let treasuryChain: Promise<unknown> = Promise.resolve();
export function executeAsTreasury(tx: Transaction, label: string): Promise<ExecResult> {
  const kp = treasuryKeypair;
  if (!kp) throw new Error('executeAsTreasury: treasury wallet not configured');
  const run = treasuryChain.then(async () => {
    tx.setSender(treasuryAddress); // coinWithBalance resolves the treasury's DUSDC against this sender
    tx.setGasPrice(await refGasPrice());
    tx.setGasBudget(PLAY_GAS_BUDGET);
    const txBytes = await withTimeout(tx.build({ client: suiClient }), 15_000, `treasury ${label} build`);
    const { signature } = await kp.signTransaction(txBytes);
    const digest = TransactionDataBuilder.getDigestFromBytes(txBytes);
    const res = await submitAndConfirm(txBytes, signature, digest);
    return toExecResult(res, `treasury ${label}`);
  });
  // Keep the chain alive regardless of this tx's outcome so one failure doesn't wedge later payouts.
  treasuryChain = run.catch(() => { });
  return run;
}

// Referral-claim payouts sign with the revenue wallet (where the rake landed), paying their own gas
// from their own SUI. Verbatim mirror of executeAsTreasury: its own serialized chain so two concurrent
// claims never select the same revenue gas/DUSDC coin and equivocate, build-sign-submit via
// submitAndConfirm for a definitive paid/failed decision (digest-reconciled). Low frequency (a claim is
// user-initiated + $1-min gated), so a per-tx build round trip is fine.
let revenueChain: Promise<unknown> = Promise.resolve();
export function executeAsRevenue(tx: Transaction, label: string): Promise<ExecResult> {
  const kp = revenueKeypair;
  if (!kp) throw new Error('executeAsRevenue: revenue wallet not configured');
  const run = revenueChain.then(async () => {
    tx.setSender(revenueAddress); // coinWithBalance resolves the revenue wallet's DUSDC against this sender
    tx.setGasPrice(await refGasPrice());
    tx.setGasBudget(PLAY_GAS_BUDGET);
    const txBytes = await withTimeout(tx.build({ client: suiClient }), 15_000, `revenue ${label} build`);
    const { signature } = await kp.signTransaction(txBytes);
    const digest = TransactionDataBuilder.getDigestFromBytes(txBytes);
    const res = await submitAndConfirm(txBytes, signature, digest);
    return toExecResult(res, `revenue ${label}`);
  });
  // Keep the chain alive regardless of this tx's outcome so one failure doesn't wedge later payouts.
  revenueChain = run.catch(() => { });
  return run;
}

// What signing a user's play needs: `provider` selects the path, privy needs walletId/publicKey, wallet-connect needs the encrypted custodial secret.
export type UserContext = {
  provider: 'dev' | 'privy' | 'wallet';
  address: string;
  walletId?: string | null;
  publicKey?: string | null;
  playWalletSecret?: string | null;
};

// The canonical context builder so every caller (plays, cashout, withdraw, manager create) signs the same way for a user; read straight off the user row.
export const userContext = (user: User): UserContext => ({
  provider: (user.provider as UserContext['provider']) ?? 'dev',
  address: user.address,
  walletId: user.privyWalletId,
  publicKey: user.suiPublicKey,
  playWalletSecret: user.playWalletSecret,
});

// Execute a user's play: wallet-connect signs with the server-held custodial key, dev signs as the
// operator (same serial executor), privy signs the intent digest via the user's embedded wallet (Privy rawSign). All finalize server-side, no client round trip.
export async function executeForUser(tx: Transaction, ctx: UserContext): Promise<ExecResult> {
  if (ctx.provider === 'wallet') {
    return executeAsCustodialWallet(tx, ctx);
  }
  if (AUTH_MODE === 'dev') {
    return executeAsOperator(tx, 'play');
  }

  // privy: the user owns the wallet; the session signer lets the server produce the signature with no popup (requires walletId + publicKey).
  if (!ctx.walletId || !ctx.publicKey) {
    throw new Error('privy play: user wallet not provisioned (missing walletId / publicKey)');
  }
  tx.setSender(ctx.address);
  tx.setGasPrice(await refGasPrice()); // skip build's own reference-gas-price round trip
  // Gas sponsorship: name the sponsor as gas owner with an empty payment so gas draws from the sponsor's SUI address balance and the user needs zero SUI (sponsor co-signs the same bytes below).
  // Off (no sponsor key) leaves the user as their own gas payer (funded at onboarding).
  if (SPONSOR_ENABLED) {
    applySponsorGas(tx);
    await applySponsorExpiration(tx); // empty-payment gas needs a ValidDuring expiration (see above)
  }
  tx.setGasBudget(PLAY_GAS_BUDGET); // pin a generous budget so tx.build skips its gas-sizing dry-run (~0.5s)
  // Hard timeouts so a stalled node/Privy connection surfaces cleanly instead of hanging forever; build/sign make no chain change, so their timeouts are unambiguous failures.
  const txBytes = await withTimeout(tx.build({ client: suiClient }), 15_000, 'tx build');
  const userSig = await withTimeout(signSuiTxWithPrivy({ walletId: ctx.walletId, publicKey: ctx.publicKey, txBytes }), 15_000, 'privy sign');
  // A sponsored tx carries both signatures (sender, then gas owner; signAsSponsor is a local ed25519 sign); unsponsored submits just the user signature.
  const signature = SPONSOR_ENABLED ? [userSig, await signAsSponsor(txBytes)] : userSig;

  // The digest is fixed by the signed bytes; a timed-out submit is confirmed against it (may still be landing) rather than mistaken for failure.
  const digest = TransactionDataBuilder.getDigestFromBytes(txBytes);
  const res = await submitSponsored(txBytes, signature, digest);
  return toExecResult(res, 'privy play');
}

// Wallet-connect (custodial) play: the server holds this user's play wallet, so signing is a plain local ed25519 sign, no Privy round trip; otherwise identical to the privy branch.
// Per-user owned coins are serialized upstream (withUserLock) so concurrent same-user txs never equivocate; different users' custodial wallets share no owned objects.
async function executeAsCustodialWallet(tx: Transaction, ctx: UserContext): Promise<ExecResult> {
  if (!ctx.playWalletSecret) {
    throw new Error('wallet play: custodial key not provisioned (missing playWalletSecret)');
  }
  const keypair = loadCustodialKeypair(ctx.playWalletSecret);
  tx.setSender(ctx.address);
  tx.setGasPrice(await refGasPrice());
  if (SPONSOR_ENABLED) {
    applySponsorGas(tx);
    await applySponsorExpiration(tx); // empty-payment gas needs a ValidDuring expiration (see above)
  }
  tx.setGasBudget(PLAY_GAS_BUDGET);
  const txBytes = await withTimeout(tx.build({ client: suiClient }), 15_000, 'tx build');
  const { signature: userSig } = await keypair.signTransaction(txBytes);
  const signature = SPONSOR_ENABLED ? [userSig, await signAsSponsor(txBytes)] : userSig;

  const digest = TransactionDataBuilder.getDigestFromBytes(txBytes);
  const res = await submitSponsored(txBytes, signature, digest);
  return toExecResult(res, 'wallet play');
}
