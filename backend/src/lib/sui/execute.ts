// Transaction execution. Operator txs (price pushes, oracle ops, DUSDC/SUI funding) sign with
// the operator key. User plays split by AUTH_MODE: dev mode signs + submits with the operator
// key (the backend IS the user); privy mode signs with the user's embedded ed25519 wallet via
// Privy rawSign under a session signer, then submits. In privy mode a dedicated gas sponsor
// co-signs so the user pays no gas (sponsor.ts). Both modes finalize server-side, no client round trip.

import { Transaction, SerialTransactionExecutor, TransactionDataBuilder } from '@mysten/sui/transactions';

import type { User } from '../../../prisma/generated/client.js';
import { AUTH_MODE, PLAY_GAS_BUDGET } from '../../config/main-config.ts';
import { suiClient } from './client.ts';
import { operatorKeypair, settlementKeypair, treasuryKeypair, treasuryAddress } from './signer.ts';
import { signSuiTxWithPrivy } from './privy.ts';
import { loadCustodialKeypair } from './custodial.ts';
import { SPONSOR_ENABLED, applySponsorGas, signAsSponsor, ensureSponsorAccumulator, isSponsorGasError } from './sponsor.ts';

export type ExecResult = {
  digest: string;
  objectChanges: Array<{ type: string; objectId?: string; objectType?: string }>;
  events: Array<{ type: string; parsedJson: Record<string, unknown> | null }>;
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

// Dedicated serial executor for the settle-redeem sweep, on its OWN wallet + gas coin. The redeem is
// permissionless (no oracle cap), so it does not have to sign as the operator, and isolating it here
// is the whole stability win: a slow or backed-up redeem can no longer head-of-line block the
// operator's price-push + oracle-nudge lane (which share the operator's single serial gas coin). Null
// when no settlement wallet is configured, in which case redeems fall back to the operator executor.
const settlementExecutor = settlementKeypair
  ? new SerialTransactionExecutor({ client: suiClient, signer: settlementKeypair, defaultGasBudget: 1_000_000_000n })
  : null;

// A hard ceiling on any single operator tx. Operator txs normally finalize in ~1-3s through the
// serial executor, but on the remote single-validator node a submit can occasionally stall. Without
// a bound, one stalled tx hangs whatever worker awaited it: the settle worker's isRunning flag would
// stay set and NO further settle tick could run, stranding every expired play on SETTLING forever.
// On timeout we stop waiting (the tx may still land, which is fine: a nudge/push is idempotent and a
// settle redeem is retried next tick) so the worker frees up and recovers on its own.
const OPERATOR_TX_TIMEOUT_MS = 25_000;

// User play submit budget, and how long to keep confirming a timed-out submit by its digest before
// concluding the tx never finalized. A submit that outruns SUBMIT_TIMEOUT_MS may STILL be landing on
// the node, so we do not treat the timeout as failure: we reconcile against the precomputed digest
// for up to SUBMIT_RECONCILE_MS. On a healthy node a submit returns in ~1-3s and neither budget is
// approached; this only engages when the node is badly degraded.
const SUBMIT_TIMEOUT_MS = 25_000;
const SUBMIT_RECONCILE_MS = 20_000;

// Stale owned-object cache. The serial executor chains owned-object versions from each tx's effects
// instead of re-reading the node, which is the whole latency win. But this backend is NOT the only
// thing signing as the operator: the deployed backend runs the operator workers + onboarding too,
// against the same chain with the same key. When that other signer advances a shared owned object
// (the operator gas coin, the DUSDC TreasuryCap), our cache still holds the previous version, so the
// node rejects the BUILD at input-object check ("object ... unavailable for consumption, current
// version ..."). The tx never executes, so a rebuild from fresh node state is always safe: it cannot
// double-spend. resetCache() drops the stale owned + gas-coin entries (and waits out our own last
// tx); the next executeTransaction re-resolves versions fresh from the node. We bound the retries and
// jitter the backoff so a brief race with the other operator resolves instead of 500ing a login.
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

// Sign + submit as the operator through the serial executor. Throws on a reverted/failed tx (or a
// timeout). Retries a stale-object-cache rejection after resetting the cache (see above), since the
// rejected build never ran. A genuine revert (Move abort) does not match isStaleObjectError and
// surfaces on the first attempt. objectChanges is reduced to the created objects (with their Move
// type), which is all any caller reads (the new oracle / manager id).
//
// opts.retries lets a background, latency-tolerant caller (settle, the oracle nudge) be far more
// patient about the stale-object race. When a SECOND signer shares this operator key (the deployed
// backend operating the same node, see the cache note above), the gas coin's version churns under us;
// a few quick retries can all land inside the same busy burst and give up. More attempts with a
// longer, jittered backoff straddle the gaps between the other signer's txs, so the re-resolved build
// finally lands. User-facing plays keep the snappy default so a mint never hangs on this.
//
// opts.freshFirst forces a node re-resolution of the operator's owned objects (gas coin, oracle cap)
// BEFORE the first attempt, not just after a failure. With a competing signer the executor's cached
// gas/cap version is usually already stale by the time a settle fires, so attempt 0 is wasted on a
// version the node has moved past. Re-reading first means the very first build carries the current
// version and lands in the gap, instead of burning a retry to discover it is stale.
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
      // Bounded so a wedged waitForLastTransaction can't hang the retry; failure to reset is non-fatal,
      // the next build still re-resolves against the node.
      await withTimeout(executor.resetCache(), 8_000, 'resetCache').catch(() => { });
      // Backoff grows and carries a wide jitter so retries desync from a competing operator's ~2s
      // rhythm instead of bunching inside its busy window. Capped so a patient call stays bounded.
      await new Promise((r) => setTimeout(r, Math.min(1200, 150 * (attempt + 1)) + Math.floor(Math.random() * 300)));
    }
  }
}

// Sign + submit as the operator (price pushes, oracle ops, settle-nudge, DUSDC/SUI funding/mint).
export function executeAsOperator(tx: Transaction, label: string, opts?: { retries?: number; freshFirst?: boolean }): Promise<ExecResult> {
  return runViaExecutor(operatorExecutor, tx, label, opts);
}

// Sign + submit the permissionless settle-redeem sweep on the dedicated settlement wallet so it runs
// on its own gas coin and cannot block the operator's price/nudge lane. Falls back to the operator
// executor when no settlement wallet is configured (legacy single-wallet behaviour).
export function executeAsSettlement(tx: Transaction, label: string, opts?: { retries?: number; freshFirst?: boolean }): Promise<ExecResult> {
  return runViaExecutor(settlementExecutor ?? operatorExecutor, tx, label, opts);
}

// Cache the network's reference gas price (per-epoch, near-constant on localnet). Setting it on the
// tx lets tx.build skip its own getReferenceGasPrice round trip. We also pin the gas budget
// (PLAY_GAS_BUDGET) so build skips its gas-sizing dry-run round trip: a mint's gross gas is ~0.21 SUI,
// well under the pinned 0.5, and under sponsorship the storage rebate just credits the sponsor.
let gasPriceCache: { price: bigint; at: number } | null = null;
async function refGasPrice(): Promise<bigint> {
  const now = Date.now();
  if (gasPriceCache && now - gasPriceCache.at < 60_000) return gasPriceCache.price;
  const price = BigInt((await suiClient.getReferenceGasPrice()).referenceGasPrice);
  gasPriceCache = { price, at: now };
  return price;
}

// A sponsored play draws gas from the sponsor's SUI address balance (empty gas payment). Sui's
// replay protection then requires the tx to carry EITHER an address-owned input OR a ValidDuring
// expiration (at most two epochs wide). Every Predict tx we build is all shared-object inputs
// (manager, predict, oracle, clock, plus the freshly created manager), so it has no owned input,
// and unlike the generic core resolver the gRPC client's resolver does NOT auto-add the expiration
// at build(). Without it the node rejects at input-object check: "Invalid transaction expiration:
// Transactions must either have address-owned inputs, or a ValidDuring expiration with at most two
// epochs of validity", which was looping manager creation (and would block every sponsored play).
// So we set a fresh single-epoch ValidDuring ourselves. Epoch + chain id are cached: devnet/localnet
// epochs are long, and a stale-by-one epoch stays valid because the window spans [epoch, epoch+1].
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

// Tagged so callers can tell a budget overrun (the call may still be completing on the node) apart
// from a real rejection (a clean revert that definitively did not land). The message format is kept
// identical to the previous generic Error, so any message-based matching still works.
class TimeoutError extends Error { }

// Reject if a promise outruns its budget, so a stuck network call can never hang a request. The
// underlying call is not aborted (it may still complete on the node), the caller just stops waiting.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// Submit a user play, reconciling an ambiguous submit by its precomputed digest before deciding the
// outcome. A submit that merely TIMED OUT may still be finalizing on the node, so instead of treating
// it as failure (which would mark the play 'error' and falsely claim the chips are safe while a real
// position exists), we confirm the digest with waitForTransaction. A clean rejection (a real revert,
// not a timeout) is surfaced immediately, there is nothing to reconcile. If the digest never appears
// within the reconcile window, the tx genuinely did not finalize and the original failure stands.
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
    // The submit outran its budget. Don't rebuild or resubmit (the tx could be landing, a fresh tx
    // would double-mint); confirm THIS digest instead. waitForTransaction self-bounds via `timeout`.
    return await suiClient.waitForTransaction({
      digest,
      timeout: SUBMIT_RECONCILE_MS,
      include: { effects: true, objectTypes: true, events: true },
    });
  }
}

// Normalize a gRPC execute/wait result (with effects/objectTypes/events included) into ExecResult,
// throwing a labelled error on a failed/reverted tx. Mirrors the serial-executor parse in
// runViaExecutor: created objects carry their Move type, events map to {type, parsedJson}.
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

// Submit a sponsored user tx, self-healing an empty gas accumulator. If the node rejects the submit
// with the sponsor's address-balance reservation error (the accumulator ran dry, e.g. right after a
// devnet wipe), top it up and retry the SAME bytes once: the reservation is checked at input
// validation BEFORE execution, so a rejected tx never ran and is safe to resubmit unchanged. Any
// other error (or a second reservation failure) surfaces normally.
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

// DUSDC payouts (onboarding chips + the Request DUSDC faucet) sign with the treasury wallet, which
// pays its own gas from its own SUI. We use the proven build-sign-submit path (the same one withdraw
// uses with coinWithBalance), not the serial executor, and serialize calls through one in-process
// chain so two concurrent payouts never select the same treasury gas/DUSDC coin and equivocate. Low
// frequency (onboarding once per user, faucet cooldown-gated), so a per-tx build round trip is fine.
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

// What signing a user's play needs. `provider` selects the path; privy needs walletId/publicKey,
// wallet-connect needs the encrypted custodial secret.
export type UserContext = {
  provider: 'dev' | 'privy' | 'wallet';
  address: string;
  walletId?: string | null;
  publicKey?: string | null;
  playWalletSecret?: string | null;
};

// The canonical context builder, so every caller (plays, cashout, withdraw, manager create) signs the
// same way for a given user. Read straight off the user row.
export const userContext = (user: User): UserContext => ({
  provider: (user.provider as UserContext['provider']) ?? 'dev',
  address: user.address,
  walletId: user.privyWalletId,
  publicKey: user.suiPublicKey,
  playWalletSecret: user.playWalletSecret,
});

// Execute a user's play. wallet-connect signs with the server-held custodial key; otherwise dev signs
// as the operator (same serial executor, one gas coin) and privy signs the intent digest with the
// user's embedded wallet via Privy rawSign. All finalize server-side, no client round trip.
export async function executeForUser(tx: Transaction, ctx: UserContext): Promise<ExecResult> {
  if (ctx.provider === 'wallet') {
    return executeAsCustodialWallet(tx, ctx);
  }
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
  // Gas sponsorship: name the sponsor as gas owner with an empty payment, so gas is drawn from the
  // sponsor's SUI address balance and the user needs zero SUI. The sponsor co-signs the same bytes
  // below. Off (no sponsor key) leaves the user as their own gas payer (funded at onboarding).
  if (SPONSOR_ENABLED) {
    applySponsorGas(tx);
    await applySponsorExpiration(tx); // empty-payment gas needs a ValidDuring expiration (see above)
  }
  tx.setGasBudget(PLAY_GAS_BUDGET); // pin a generous budget so tx.build skips its gas-sizing dry-run (~0.5s)
  // Hard timeouts so a stalled node/Privy connection surfaces a clean error instead of leaving the
  // play pending forever. Build/sign make no chain change, so their timeouts are unambiguous failures.
  const txBytes = await withTimeout(tx.build({ client: suiClient }), 15_000, 'tx build');
  const userSig = await withTimeout(signSuiTxWithPrivy({ walletId: ctx.walletId, publicKey: ctx.publicKey, txBytes }), 15_000, 'privy sign');
  // A sponsored tx carries both signatures (sender first, then gas owner); signAsSponsor is a local
  // ed25519 sign with no network. Unsponsored submits the single user signature.
  const signature = SPONSOR_ENABLED ? [userSig, await signAsSponsor(txBytes)] : userSig;

  // The digest is fixed by the signed bytes, so compute it before submitting. A timed-out submit is
  // then confirmed against it (the tx may still be landing) rather than mistaken for a failure.
  const digest = TransactionDataBuilder.getDigestFromBytes(txBytes);
  const res = await submitSponsored(txBytes, signature, digest);
  return toExecResult(res, 'privy play');
}

// Wallet-connect (custodial) play execution. The server holds this user's play wallet, so signing is a
// plain local ed25519 sign, no Privy round trip. Otherwise identical to the privy branch: user as
// sender, optional gas sponsorship, pinned budget, digest-reconciled submit. Per-user owned coins are
// serialized upstream (withUserLock), so concurrent same-user txs never equivocate; different users'
// custodial wallets share no owned objects.
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
