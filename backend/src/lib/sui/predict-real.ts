// The one server-side wrapper for Mysten's REAL DeepBook Predict (testnet, IS_REAL_PREDICT). It is a
// sibling of the fork's predict.ts: same conventions (PTB builders, simulateTransaction devInspect
// reads, event parsers) but the real protocol's structurally different shape (L-007): a per-owner
// derived account::AccountWrapper, a fresh Auth per tx, a 3-step internal-balance deposit->mint->
// redeem->withdraw dance, a unified tick binary+range API, a per-PTB Pricer from 4 Propbook feeds,
// and real continuous leverage. Ids come from config-real.ts, never hardcoded. localnet/devnet never
// reach this module (they stay on predict.ts).
//
// This file grows across the wave: Phase 3 = account wrapper lifecycle (here); Phase 4 = money flow +
// mint/redeem/withdraw; Phase 5+ discovery/settle. Keep every real builder here so a mainnet re-point
// is a config swap, not a rewrite.

import { Transaction, type TransactionObjectArgument } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';

import { suiClient, grpcErrorText } from './client.ts';
import {
  REAL_ACCOUNT_PACKAGE,
  REAL_ACCOUNT_REGISTRY_ID,
  realTarget,
} from './config-real.ts';

// gRPC throws "<id> not found" where JSON-RPC returned empty data; reads that mean "gone -> null"
// catch it. grpcErrorText decodes the percent-encoded transport message (L-003).
const isNotFound = (e: unknown): boolean => grpcErrorText(e).includes('not found');

// Decode a simulate u64 return value (little-endian BCS) into a bigint.
export const decodeU64 = (bytes: Uint8Array | number[] | null): bigint => {
  if (!bytes) throw new Error('missing return value bytes');
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
};

const decodeBool = (bytes: Uint8Array | number[] | null): boolean => {
  if (!bytes || bytes.length === 0) throw new Error('missing bool return value');
  return bytes[0] !== 0;
};

// A BCS-encoded Sui address return value -> normalized 0x hex.
const decodeAddress = (bytes: Uint8Array | number[] | null): string => {
  if (!bytes) throw new Error('missing address return value');
  return bcs.Address.parse(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
};

// Read-only PTB via gRPC simulate (devInspect replacement), mirroring predict.ts: sets the sender,
// disables checks so non-entry getters return values, throws labelled on failure.
type SimReturnValues = { returnValues: { bcs: Uint8Array | null }[] }[];
async function simulateRead(tx: Transaction, sender: string, label: string): Promise<SimReturnValues> {
  tx.setSender(sender);
  const res = await suiClient.simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
    checksEnabled: false,
  });
  if (res.$kind !== 'Transaction') {
    throw new Error(`${label}: ${res.FailedTransaction?.status?.error?.message ?? 'simulate error'}`);
  }
  return (res.commandResults ?? []) as SimReturnValues;
}

// === Account wrapper lifecycle (Phase 3, account::account + account::account_registry) ===
//
// One canonical AccountWrapper per PIPS user, deterministically derived from the user's address under
// the shared AccountRegistry (per-user isolation, matches the fork's per-user PredictManager). The
// wrapper's object id IS its derived address. `derived_wrapper_address`/`derived_wrapper_exists` are
// pure reads; creation is a one-PTB `new` + `share` signed by the user (new derives for ctx.sender()).
// Every later call regenerates Auth fresh via generate_auth(ctx) and NEVER stores it. Predict is
// already authorized via account_registry::authorize_app<PredictApp> (deployment wiring), do NOT redo.

export type WrapperResolution = {
  wrapperId: string; // the derived AccountWrapper object id (== derived address)
  exists: boolean; // true once new+share has run; false means the play PTB must prepend buildCreateWrapper
};

// Derive the wrapper address + existence for `owner` in ONE simulate round trip. The address is
// deterministic (a pure function of the registry root + owner), existence flips to true after create.
export async function readWrapper(owner: string): Promise<WrapperResolution> {
  const tx = new Transaction();
  tx.moveCall({
    target: realTarget(REAL_ACCOUNT_PACKAGE, 'account_registry', 'derived_wrapper_address'),
    arguments: [tx.object(REAL_ACCOUNT_REGISTRY_ID), tx.pure.address(owner)],
  });
  tx.moveCall({
    target: realTarget(REAL_ACCOUNT_PACKAGE, 'account_registry', 'derived_wrapper_exists'),
    arguments: [tx.object(REAL_ACCOUNT_REGISTRY_ID), tx.pure.address(owner)],
  });
  const results = await simulateRead(tx, owner, 'wrapper resolve failed');
  const addr = results[0]?.returnValues?.[0]?.bcs;
  const exists = results[1]?.returnValues?.[0]?.bcs;
  if (!addr || !exists) throw new Error('wrapper resolve returned no values');
  return { wrapperId: decodeAddress(addr), exists: decodeBool(exists) };
}

// True iff the wrapper object still lives on chain (self-heal check for a cached id). getObject gives a
// clean not-found; a real node/chain error rethrows so an outage is not misread as "gone".
export async function wrapperExists(wrapperId: string): Promise<boolean> {
  try {
    await suiClient.getObject({ objectId: wrapperId });
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

// Resolve the user's wrapper, honoring an optional hot-path cache (User.predictWrapperId). A cache hit
// skips the chain read entirely; a miss (or a cache that fails the self-heal check) re-derives from
// chain. Returns the id to use + whether the play PTB must create it first.
//   - cachedId present  -> trust it, return {exists:true} with zero chain reads (the fast path).
//   - cachedId absent    -> one simulate deriving address + existence.
// The caller persists wrapperId to the cache after a successful create, and clears the cache + calls
// this again with no cachedId if a later mint/redeem aborts wrapper-not-found (self-heal).
export async function resolveWrapper(owner: string, cachedId?: string | null): Promise<WrapperResolution> {
  if (cachedId) return { wrapperId: cachedId, exists: true };
  return readWrapper(owner);
}

// Build the one-PTB wrapper creation: new(registry) -> share(wrapper). `new` derives for ctx.sender(),
// so the tx MUST be signed by the user (executeForUser: privy = the user's wallet, dev = the operator).
// The wrapper id is the deterministic derived address (readWrapper), so callers don't parse effects.
export function buildCreateWrapper(tx: Transaction): void {
  const wrapper = tx.moveCall({
    target: realTarget(REAL_ACCOUNT_PACKAGE, 'account_registry', 'new'),
    arguments: [tx.object(REAL_ACCOUNT_REGISTRY_ID)],
  });
  tx.moveCall({
    target: realTarget(REAL_ACCOUNT_PACKAGE, 'account', 'share'),
    arguments: [wrapper],
  });
}

// Generate a fresh owner Auth hot potato from the tx sender. MUST be called per-tx and consumed in the
// same PTB (never stored/reused, L-007). ctx is runtime-supplied, so no PTB argument.
export function buildAuth(tx: Transaction): TransactionObjectArgument {
  return tx.moveCall({ target: realTarget(REAL_ACCOUNT_PACKAGE, 'account', 'generate_auth'), arguments: [] });
}
