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

import { Transaction, coinWithBalance, type TransactionObjectArgument } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';

import { suiClient, grpcErrorText } from './client.ts';
import { DUSDC_TYPE } from './config.ts';
import {
  REAL_ACCOUNT_PACKAGE,
  REAL_ACCOUNT_REGISTRY_ID,
  REAL_PREDICT_PACKAGE,
  REAL_PROTOCOL_CONFIG_ID,
  REAL_ORACLE_REGISTRY_ID,
  REAL_ACCUMULATOR_ROOT,
  REAL_CLOCK,
  REAL_BTC_ASSET,
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

// === Money flow + mint/redeem/withdraw (Phase 4, deepbook_predict::expiry_market + account::account) ===
//
// The 3-step internal-balance dance (L-007): deposit a real Coin<DUSDC> into the wrapper's internal
// balance, mint draws from that balance, redeem credits it back, withdraw pulls a spendable coin out.
// A cash-out leaves the payout in the wrapper's internal balance (the user's chips), same as the fork
// keeps redeemed chips in the manager's BalanceManager; the balance read sums wallet + wrapper, and a
// wallet withdraw is the separate action that pulls chips back to the external address.
//
// All values source-verified against the vendored .move (constants/order/order_events/range_codec/
// strike_exposure*/expiry_market) + live chain: prices/strikes/probability/leverage are 1e9-scaled;
// quantity/premium/payout are 6dp DUSDC; tick_size(BTC)=1e7 ($0.01), admission_tick_size=1e9 ($1),
// max_admission_leverage=3e9 (3.0x). min_net_premium=1e6 ($1) is the real per-play floor (net_premium
// = entry_value/leverage), so the tiny-amount economy floors at ~$1, not the intake's $0.01 (see L-011).

// Sentinel ticks (constants.move): pos_inf_tick = (1<<30)-1, neg_inf lower = 0.
export const POS_INF_TICK = (1n << 30n) - 1n;
export const NEG_INF_TICK = 0n;
// Quantity lot granularity (constants::position_lot_size, 6dp) and the 1e9-scaled leverage unit (L=1).
export const POSITION_LOT_SIZE = 10_000n;
export const LEVERAGE_ONE = 1_000_000_000n;
// Uncapped slippage-guard sentinel (std::u64::max_value!()). Start disabled, tighten once proven.
export const U64_MAX = (1n << 64n) - 1n;

// Snap a 1e9-scaled price down to a finite absolute tick aligned to admission_tick_size. New finite
// mint boundaries must align to admission (assert_admitted_mint_ticks), and tick = raw / tick_size
// (range_codec::strikes_from_ticks). Both tickSize and admissionTickSize are 1e9-scaled raw units.
export function priceToTick(price1e9: bigint, tickSize: bigint, admissionTickSize: bigint): bigint {
  if (price1e9 <= 0n) return NEG_INF_TICK;
  const snapped = (price1e9 / admissionTickSize) * admissionTickSize;
  const tick = snapped / tickSize;
  // Keep finite ticks strictly inside 1..pos_inf_tick-1 (order shape validity).
  if (tick <= 0n) return 1n;
  if (tick >= POS_INF_TICK) return POS_INF_TICK - 1n;
  return tick;
}

export type Side = 'up' | 'down';

// Binary up = (strike, +inf], binary down = (0, strike]. Returns the (lower, higher) tick pair.
export function ticksForBinary(
  side: Side,
  strike1e9: bigint,
  tickSize: bigint,
  admissionTickSize: bigint,
): { lowerTick: bigint; higherTick: bigint } {
  const strikeTick = priceToTick(strike1e9, tickSize, admissionTickSize);
  return side === 'up'
    ? { lowerTick: strikeTick, higherTick: POS_INF_TICK }
    : { lowerTick: NEG_INF_TICK, higherTick: strikeTick };
}

// A vertical range (lower, higher]. Both edges snap to admission; higher is bumped one admission step
// above lower if they collapse to the same tick, so lower_tick < higher_tick holds.
export function ticksForRange(
  lower1e9: bigint,
  higher1e9: bigint,
  tickSize: bigint,
  admissionTickSize: bigint,
): { lowerTick: bigint; higherTick: bigint } {
  const lowerTick = priceToTick(lower1e9, tickSize, admissionTickSize);
  let higherTick = priceToTick(higher1e9, tickSize, admissionTickSize);
  const step = admissionTickSize / tickSize; // ticks per admission boundary
  if (higherTick <= lowerTick) higherTick = lowerTick + (step > 0n ? step : 1n);
  if (higherTick >= POS_INF_TICK) higherTick = POS_INF_TICK - 1n;
  return { lowerTick, higherTick };
}

const btcFeeds = () => {
  const a = REAL_BTC_ASSET;
  if (!a) throw new Error('predict-real: no BTC_USD asset configured (real mode only)');
  return a.feeds;
};

// Build a PTB-local live Pricer bound to `marketId`, from the 4 Propbook feeds. Must be built fresh in
// the same PTB and passed by-ref into mint/redeem_live. Returns the Pricer hot value.
export function buildLoadPricer(tx: Transaction, marketId: string): TransactionObjectArgument {
  const f = btcFeeds();
  return tx.moveCall({
    target: realTarget(REAL_PREDICT_PACKAGE, 'expiry_market', 'load_live_pricer'),
    arguments: [
      tx.object(marketId),
      tx.object(REAL_PROTOCOL_CONFIG_ID),
      tx.object(REAL_ORACLE_REGISTRY_ID),
      tx.object(f.pyth),
      tx.object(f.bsSpot),
      tx.object(f.bsForward),
      tx.object(f.bsSvi),
      tx.object(REAL_CLOCK),
    ],
  });
}

// deposit_funds<DUSDC>: fold a real Coin<DUSDC> into the wrapper's internal balance (must precede mint).
export function buildDepositFunds(
  tx: Transaction,
  wrapper: TransactionObjectArgument,
  auth: TransactionObjectArgument,
  coin: TransactionObjectArgument,
): void {
  tx.moveCall({
    target: realTarget(REAL_ACCOUNT_PACKAGE, 'account', 'deposit_funds'),
    typeArguments: [DUSDC_TYPE],
    arguments: [wrapper, auth, coin, tx.object(REAL_ACCUMULATOR_ROOT), tx.object(REAL_CLOCK)],
  });
}

// withdraw_funds<DUSDC>: pull a spendable Coin<DUSDC> of `amountRaw` (6dp) out of the internal balance.
// Returns the coin argument to transfer/merge. Chainable right after a redeem in the same PTB.
export function buildWithdrawFunds(
  tx: Transaction,
  wrapper: TransactionObjectArgument,
  auth: TransactionObjectArgument,
  amountRaw: bigint,
): TransactionObjectArgument {
  return tx.moveCall({
    target: realTarget(REAL_ACCOUNT_PACKAGE, 'account', 'withdraw_funds'),
    typeArguments: [DUSDC_TYPE],
    arguments: [wrapper, auth, tx.pure.u64(amountRaw), tx.object(REAL_ACCUMULATOR_ROOT), tx.object(REAL_CLOCK)],
  });
}

// mint_exact_amount: size the largest lot-rounded position whose net premium fits `amountRaw` (the
// premium budget in 6dp; fees are charged on top, so deposit must cover amount + fee headroom). Returns
// the minted order id (u256) via events, not the command return. leverage1e9 is 1e9-scaled (never
// clamped, L-009). max_cost/max_probability default off (U64_MAX), tighten later.
export type MintExactAmountArgs = {
  marketId: string;
  wrapper: TransactionObjectArgument;
  auth: TransactionObjectArgument;
  pricer: TransactionObjectArgument;
  lowerTick: bigint;
  higherTick: bigint;
  amountRaw: bigint;
  minQuantityRaw: bigint;
  leverage1e9: bigint;
};
export function buildMintExactAmount(tx: Transaction, a: MintExactAmountArgs): void {
  tx.moveCall({
    target: realTarget(REAL_PREDICT_PACKAGE, 'expiry_market', 'mint_exact_amount'),
    arguments: [
      tx.object(a.marketId),
      a.wrapper,
      a.auth,
      tx.object(REAL_PROTOCOL_CONFIG_ID),
      a.pricer,
      tx.pure.u64(a.lowerTick),
      tx.pure.u64(a.higherTick),
      tx.pure.u64(a.amountRaw),
      tx.pure.u64(a.minQuantityRaw),
      tx.pure.u64(a.leverage1e9),
      tx.object(REAL_ACCUMULATOR_ROOT),
      tx.object(REAL_CLOCK),
    ],
  });
}

// mint_exact_quantity: fixed payout quantity (6dp, lot-aligned) with slippage guards. Used when a game
// wants an exact max payout (e.g. LUCKY's solved quantity) rather than a premium budget.
export type MintExactQuantityArgs = {
  marketId: string;
  wrapper: TransactionObjectArgument;
  auth: TransactionObjectArgument;
  pricer: TransactionObjectArgument;
  lowerTick: bigint;
  higherTick: bigint;
  quantityRaw: bigint;
  leverage1e9: bigint;
  maxCost?: bigint;
  maxProbability?: bigint;
};
export function buildMintExactQuantity(tx: Transaction, a: MintExactQuantityArgs): void {
  tx.moveCall({
    target: realTarget(REAL_PREDICT_PACKAGE, 'expiry_market', 'mint_exact_quantity'),
    arguments: [
      tx.object(a.marketId),
      a.wrapper,
      a.auth,
      tx.object(REAL_PROTOCOL_CONFIG_ID),
      a.pricer,
      tx.pure.u64(a.lowerTick),
      tx.pure.u64(a.higherTick),
      tx.pure.u64(a.quantityRaw),
      tx.pure.u64(a.leverage1e9),
      tx.pure.u64(a.maxCost ?? U64_MAX),
      tx.pure.u64(a.maxProbability ?? U64_MAX),
      tx.object(REAL_ACCUMULATOR_ROOT),
      tx.object(REAL_CLOCK),
    ],
  });
}

// redeem_live: owner-authed mark-to-market close (partial ok). Payout is credited into the wrapper
// internal balance. Needs a fresh Pricer in the same PTB.
export function buildRedeemLive(
  tx: Transaction,
  a: { marketId: string; wrapper: TransactionObjectArgument; auth: TransactionObjectArgument; pricer: TransactionObjectArgument; orderId: bigint; closeQuantityRaw: bigint },
): void {
  tx.moveCall({
    target: realTarget(REAL_PREDICT_PACKAGE, 'expiry_market', 'redeem_live'),
    arguments: [
      tx.object(a.marketId),
      a.wrapper,
      a.auth,
      tx.object(REAL_PROTOCOL_CONFIG_ID),
      a.pricer,
      tx.pure.u256(a.orderId),
      tx.pure.u64(a.closeQuantityRaw),
      tx.object(REAL_ACCUMULATOR_ROOT),
      tx.object(REAL_CLOCK),
    ],
  });
}

// redeem_settled: permissionless (mints its own app Auth), full-close only, no Pricer. The settle path
// uses this to sweep a settled payout into the user's wrapper internal balance on their behalf.
export function buildRedeemSettled(
  tx: Transaction,
  a: { marketId: string; wrapperId: string; orderId: bigint; closeQuantityRaw: bigint },
): void {
  tx.moveCall({
    target: realTarget(REAL_PREDICT_PACKAGE, 'expiry_market', 'redeem_settled'),
    arguments: [
      tx.object(a.marketId),
      tx.object(REAL_ACCOUNT_REGISTRY_ID),
      tx.object(a.wrapperId),
      tx.object(REAL_PROTOCOL_CONFIG_ID),
      tx.object(REAL_ORACLE_REGISTRY_ID),
      tx.object(btcFeeds().pyth),
      tx.pure.u256(a.orderId),
      tx.pure.u64(a.closeQuantityRaw),
      tx.object(REAL_ACCUMULATOR_ROOT),
      tx.object(REAL_CLOCK),
    ],
  });
}

// === Play-shaped composition (one PTB) ===

export type MintPlayParams = {
  marketId: string;
  wrapperId: string; // the derived wrapper id (== derived address)
  wrapperExists: boolean; // false -> new+share is folded into this PTB
  stakeRaw: bigint; // DUSDC deposited into the wrapper (chips the sender holds)
  amountRaw: bigint; // net-premium budget for mint_exact_amount (<= stake, leaving fee headroom)
  minQuantityRaw: bigint;
  leverage1e9: bigint;
  lowerTick: bigint;
  higherTick: bigint;
};

// Assemble the whole mint play into ONE PTB: [create wrapper] -> deposit stake -> load Pricer -> mint.
// A first-ever play threads the freshly `new`'d wrapper value through deposit + mint and shares it
// last (a same-PTB shared object cannot be re-referenced by id, but the value can be used by-ref then
// shared). A returning play passes the existing shared wrapper by id. Signing/sponsorship + event
// parsing are the caller's (Phase 8/10); this only builds the PTB. Each account op takes its OWN fresh
// Auth (generate_auth is cheap and never reused).
export function buildMintPlay(tx: Transaction, p: MintPlayParams): void {
  const wrapper: TransactionObjectArgument = p.wrapperExists
    ? tx.object(p.wrapperId)
    : tx.moveCall({
        target: realTarget(REAL_ACCOUNT_PACKAGE, 'account_registry', 'new'),
        arguments: [tx.object(REAL_ACCOUNT_REGISTRY_ID)],
      });

  const coin = coinWithBalance({ type: DUSDC_TYPE, balance: p.stakeRaw })(tx);
  buildDepositFunds(tx, wrapper, buildAuth(tx), coin);

  const pricer = buildLoadPricer(tx, p.marketId);
  buildMintExactAmount(tx, {
    marketId: p.marketId,
    wrapper,
    auth: buildAuth(tx),
    pricer,
    lowerTick: p.lowerTick,
    higherTick: p.higherTick,
    amountRaw: p.amountRaw,
    minQuantityRaw: p.minQuantityRaw,
    leverage1e9: p.leverage1e9,
  });

  if (!p.wrapperExists) {
    tx.moveCall({ target: realTarget(REAL_ACCOUNT_PACKAGE, 'account', 'share'), arguments: [wrapper] });
  }
}

// Live cash-out play (one PTB): load Pricer -> redeem_live. Payout lands in the wrapper internal
// balance (the user's chips); no withdraw so the game loop is one tx.
export function buildRedeemLivePlay(
  tx: Transaction,
  p: { marketId: string; wrapperId: string; orderId: bigint; closeQuantityRaw: bigint },
): void {
  const pricer = buildLoadPricer(tx, p.marketId);
  buildRedeemLive(tx, {
    marketId: p.marketId,
    wrapper: tx.object(p.wrapperId),
    auth: buildAuth(tx),
    pricer,
    orderId: p.orderId,
    closeQuantityRaw: p.closeQuantityRaw,
  });
}

// Withdraw chips from the wrapper internal balance back to `to` (the wallet-screen action, not the
// per-play loop). Owner-authed, so it runs under executeForUser.
export function buildWithdrawToWallet(
  tx: Transaction,
  p: { wrapperId: string; amountRaw: bigint; to: string },
): void {
  const coin = buildWithdrawFunds(tx, tx.object(p.wrapperId), buildAuth(tx), p.amountRaw);
  tx.transferObjects([coin], tx.pure.address(p.to));
}

// Read the wrapper's total DUSDC (stored + unsettled accumulator funds), 6dp. Sums with the wallet
// balance to give the true spendable chips.
export async function readWrapperBalanceRaw(wrapperId: string, owner: string): Promise<bigint> {
  const tx = new Transaction();
  const account = tx.moveCall({
    target: realTarget(REAL_ACCOUNT_PACKAGE, 'account', 'load_account'),
    arguments: [tx.object(wrapperId)],
  });
  tx.moveCall({
    target: realTarget(REAL_ACCOUNT_PACKAGE, 'account', 'balance'),
    typeArguments: [DUSDC_TYPE],
    arguments: [account, tx.object(REAL_ACCUMULATOR_ROOT), tx.object(REAL_CLOCK)],
  });
  const results = await simulateRead(tx, owner, 'wrapper balance read failed');
  const rv = results[results.length - 1]?.returnValues?.[0]?.bcs;
  return decodeU64(rv);
}

// === Event parsers (executed-tx events: { type, parsedJson }, mirrors execute.ts ExecResult) ===

export type RealEvent = { type: string; parsedJson: Record<string, unknown> | null };

const OrderMintedSuffix = '::order_events::OrderMinted';
const LiveRedeemedSuffix = '::order_events::LiveOrderRedeemed';
const SettledRedeemedSuffix = '::order_events::SettledOrderRedeemed';
const LiquidatedRedeemedSuffix = '::order_events::LiquidatedOrderRedeemed';

const evStr = (j: Record<string, unknown>, k: string): string => {
  const v = j[k];
  if (typeof v !== 'string' && typeof v !== 'number') throw new Error(`OrderEvent missing ${k}`);
  return String(v);
};
const evBig = (j: Record<string, unknown>, k: string): bigint => BigInt(evStr(j, k));
const evOpt = (j: Record<string, unknown>, k: string): bigint | null => {
  const v = j[k];
  if (v == null) return null;
  // Option<u256> serializes as the value or null in the json view.
  if (typeof v === 'object') return null;
  return BigInt(String(v));
};

export type MintResult = {
  orderId: bigint;
  quantityRaw: bigint;
  leverage1e9: bigint;
  entryProbability1e9: bigint;
  netPremiumRaw: bigint;
  costRaw: bigint; // net premium + all fees = the all-in DUSDC drawn from the wrapper
  lowerTick: bigint;
  higherTick: bigint;
  marketId: string;
};

export function parseMint(events: RealEvent[]): MintResult {
  const e = events.find((x) => x.type.endsWith(OrderMintedSuffix));
  if (!e?.parsedJson) throw new Error('missing OrderMinted event');
  const j = e.parsedJson;
  const netPremium = evBig(j, 'net_premium');
  const fees = evBig(j, 'trading_fee') + evBig(j, 'builder_fee') + evBig(j, 'penalty_fee');
  return {
    orderId: evBig(j, 'order_id'),
    quantityRaw: evBig(j, 'quantity'),
    leverage1e9: evBig(j, 'leverage'),
    entryProbability1e9: evBig(j, 'entry_probability'),
    netPremiumRaw: netPremium,
    costRaw: netPremium + fees,
    lowerTick: evBig(j, 'lower_tick'),
    higherTick: evBig(j, 'higher_tick'),
    marketId: evStr(j, 'expiry_market_id'),
  };
}

export type RedeemResult = {
  orderId: bigint;
  payoutRaw: bigint; // net DUSDC credited to the wrapper (0 for a liquidated tombstone)
  settled: boolean;
  liquidated: boolean;
  quantityClosedRaw: bigint;
  replacementOrderId: bigint | null;
};

// Parse whichever redeem event fired. Live redeem -> LiveOrderRedeemed (redeem_amount minus fees);
// settled -> SettledOrderRedeemed (payout_amount); a liquidated position -> LiquidatedOrderRedeemed
// (zero payout). Both redeem paths can emit the liquidated variant for a knocked-out order.
export function parseRedeem(events: RealEvent[]): RedeemResult {
  const liq = events.find((x) => x.type.endsWith(LiquidatedRedeemedSuffix));
  if (liq?.parsedJson) {
    const j = liq.parsedJson;
    return { orderId: evBig(j, 'order_id'), payoutRaw: 0n, settled: false, liquidated: true, quantityClosedRaw: evBig(j, 'quantity_closed'), replacementOrderId: null };
  }
  const live = events.find((x) => x.type.endsWith(LiveRedeemedSuffix));
  if (live?.parsedJson) {
    const j = live.parsedJson;
    const gross = evBig(j, 'redeem_amount');
    const fees = evBig(j, 'trading_fee') + evBig(j, 'builder_fee') + evBig(j, 'penalty_fee');
    return {
      orderId: evBig(j, 'order_id'),
      payoutRaw: gross > fees ? gross - fees : 0n,
      settled: false,
      liquidated: false,
      quantityClosedRaw: evBig(j, 'quantity_closed'),
      replacementOrderId: evOpt(j, 'replacement_order_id'),
    };
  }
  const settled = events.find((x) => x.type.endsWith(SettledRedeemedSuffix));
  if (settled?.parsedJson) {
    const j = settled.parsedJson;
    return { orderId: evBig(j, 'order_id'), payoutRaw: evBig(j, 'payout_amount'), settled: true, liquidated: false, quantityClosedRaw: evBig(j, 'quantity_closed'), replacementOrderId: null };
  }
  throw new Error('no redeem event found (Live/Settled/Liquidated)');
}
