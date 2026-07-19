// The one server-side wrapper for Mysten's REAL DeepBook Predict (testnet/mainnet): per-owner derived account::AccountWrapper, fresh Auth per tx, a 3-step internal-balance deposit/mint/redeem/withdraw dance, unified tick binary+range API, per-PTB Pricer from 4 Propbook feeds, real continuous leverage (L-007).
// Ids come from config-real.ts, never hardcoded. Keep every real builder here so a mainnet re-point is a config swap, not a rewrite.

import { Transaction, coinWithBalance, type TransactionObjectArgument } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';

import { suiClient, graphqlClient, grpcErrorText } from './client.ts';
import { DUSDC_TYPE } from './config.ts';
import {
  REAL_ACCOUNT_PACKAGE,
  REAL_ACCOUNT_REGISTRY_ID,
  REAL_PREDICT_PACKAGE,
  REAL_PROTOCOL_CONFIG_ID,
  REAL_ORACLE_REGISTRY_ID,
  REAL_POOL_VAULT_ID,
  REAL_ACCUMULATOR_ROOT,
  REAL_CLOCK,
  REAL_BTC_ASSET,
  realTarget,
} from './config-real.ts';

// gRPC throws "<id> not found" where JSON-RPC returned empty data, so a "gone -> null" read must catch
// it; grpcErrorText decodes the percent-encoded transport message (L-003).
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

// Read-only PTB via gRPC simulate (devInspect replacement): sets the sender, disables checks so
// non-entry getters return values, throws labelled on failure.
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
// One canonical AccountWrapper per PIPS user, derived from the address under the shared AccountRegistry (the wrapper's object id IS its derived address, matches the fork's per-user PredictManager).
// Creation is a one-PTB new + share; every later call regenerates Auth fresh via generate_auth(ctx) and never stores it. Predict is already authorized via account_registry::authorize_app<PredictApp>, do not redo.

export type WrapperResolution = {
  wrapperId: string; // the derived AccountWrapper object id (== derived address)
  exists: boolean; // true once new+share has run; false means the play PTB must prepend buildCreateWrapper
};

// Derive the wrapper address + existence for `owner` in one simulate round trip; the address is
// deterministic (pure function of registry root + owner), existence flips true after create.
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

// True iff the wrapper object still lives on chain (self-heal check for a cached id); a real
// node/chain error rethrows so an outage isn't misread as "gone".
export async function wrapperExists(wrapperId: string): Promise<boolean> {
  try {
    await suiClient.getObject({ objectId: wrapperId });
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

// Resolves the user's wrapper via an optional hot-path cache (User.predictWrapperId): a cachedId trusts it with zero chain reads, else one simulate derives address + existence.
// The caller persists wrapperId after a successful create, and clears it + retries with no cachedId if a later mint/redeem aborts wrapper-not-found (self-heal).
export async function resolveWrapper(owner: string, cachedId?: string | null): Promise<WrapperResolution> {
  if (cachedId) return { wrapperId: cachedId, exists: true };
  return readWrapper(owner);
}

// Build the one-PTB wrapper creation: new(registry) -> share(wrapper). new derives for ctx.sender(), so the tx MUST be signed by the user (executeForUser: privy = the user's wallet, dev = the operator).
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

// Generate a fresh owner Auth hot potato from the tx sender; must be called per-tx and consumed in the
// same PTB, never stored/reused (L-007). ctx is runtime-supplied, so no PTB argument.
export function buildAuth(tx: Transaction): TransactionObjectArgument {
  return tx.moveCall({ target: realTarget(REAL_ACCOUNT_PACKAGE, 'account', 'generate_auth'), arguments: [] });
}

// === Money flow + mint/redeem/withdraw (Phase 4, deepbook_predict::expiry_market + account::account) ===
// The 3-step internal-balance dance (L-007): deposit folds a real Coin<DUSDC> into the wrapper's internal balance, mint draws from it, redeem credits it back, withdraw pulls a spendable coin out.
// Values verified against the vendored .move + live chain: prices/strikes/probability/leverage are 1e9-scaled, quantity/premium/payout 6dp; BTC tick_size=1e7, admission_tick_size=1e9, max_admission_leverage=3e9. min_net_premium=1e6 ($1) floors the tiny-amount economy at ~$1, not the intake's $0.01 (L-011).

// Sentinel ticks (constants.move): pos_inf_tick = (1<<30)-1, neg_inf lower = 0.
export const POS_INF_TICK = (1n << 30n) - 1n;
export const NEG_INF_TICK = 0n;
// Quantity lot granularity (constants::position_lot_size, 6dp) and the 1e9-scaled leverage unit (L=1).
export const POSITION_LOT_SIZE = 10_000n;
export const LEVERAGE_ONE = 1_000_000_000n;
// Uncapped slippage-guard sentinel (std::u64::max_value!()). Start disabled, tighten once proven.
export const U64_MAX = (1n << 64n) - 1n;

// Snap a 1e9-scaled price down to a finite absolute tick aligned to admission_tick_size (assert_admitted_mint_ticks); tick = raw / tick_size (range_codec::strikes_from_ticks), both args 1e9-scaled raw units.
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

// A vertical range (lower, higher]: both edges snap to admission, higher is bumped one admission step
// above lower if they'd collapse to the same tick (keeps lower_tick < higher_tick).
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

// Build a PTB-local live Pricer bound to `marketId` from the 4 Propbook feeds; must be built fresh in
// the same PTB and passed by-ref into mint/redeem_live.
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

// withdraw_funds<DUSDC>: pull a spendable Coin<DUSDC> of amountRaw (6dp) out of the internal balance,
// chainable right after a redeem in the same PTB.
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

// mint_exact_amount: sizes the largest lot-rounded position whose net premium fits amountRaw (fees charge on top, so deposit must cover amount + fee headroom); the minted order id (u256) comes via events, not the command return.
// leverage1e9 is 1e9-scaled and never clamped (L-009); max_cost/max_probability default off (U64_MAX), tighten later.
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

// mint_exact_quantity: fixed payout quantity (6dp, lot-aligned) with slippage guards, used when a game
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

// redeem_live: owner-authed mark-to-market close (partial ok); payout credits into the wrapper internal
// balance, needs a fresh Pricer in the same PTB.
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

// redeem_settled: permissionless (mints its own app Auth), full-close only, no Pricer; the settle path
// uses this to sweep a settled payout into the user's wrapper on their behalf.
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

// plp::rebalance_expiry_cash: permissionlessly funds the routed market's payout backing from the pool vault's idle liquidity (or initial-funds a freshly rolled market). Mint only ASSERTS backing, never pulls pool cash, so a just-rolled or drained market is un-mintable until rebalanced.
// All shared inputs, no Auth, so it folds into a sponsored mint PTB ahead of the mint (no-op when already at target); only added on the backing-abort retry, never the healthy path (keeps the pool vault off the common mint's mutable-input set). Refs plp.move.
export function buildRebalanceExpiryCash(tx: Transaction, marketId: string): void {
  tx.moveCall({
    target: realTarget(REAL_PREDICT_PACKAGE, 'plp', 'rebalance_expiry_cash'),
    arguments: [
      tx.object(REAL_POOL_VAULT_ID),
      tx.object(marketId),
      tx.object(REAL_PROTOCOL_CONFIG_ID),
      tx.object(REAL_ORACLE_REGISTRY_ID),
      tx.object(btcFeeds().pyth),
      tx.object(REAL_CLOCK),
    ],
  });
}

// === Play-shaped composition (one PTB) ===

export type MintPlayParams = {
  marketId: string;
  wrapperId: string; // the derived wrapper id (== derived address)
  wrapperExists: boolean; // false -> new+share is folded into this PTB
  // Fund the market's payout backing from the pool vault before minting (plp::rebalance_expiry_cash).
  // Set ONLY on a retry after the mint aborted on expiry_cash::assert_backing, so fund+mint lands atomically and the healthy path never touches the pool vault.
  rebalanceBacking?: boolean;
  depositRaw: bigint; // wallet DUSDC to fold into the internal balance first (0 = mint from existing chips)
  amountRaw: bigint; // net-premium budget for mint_exact_amount (<= internal balance, leaving fee headroom)
  minQuantityRaw: bigint;
  leverage1e9: bigint;
  lowerTick: bigint;
  higherTick: bigint;
  // House rake (seam in lib/sui/house.ts): when rakeRaw > 0, peel it from the wrapper's internal balance AFTER the mint and send it to revenueAddress, all in this one atomic PTB.
  // The deposit tops the wrapper to the full stake and the mint consumes ~net, so >= rake is always left to withdraw; rakeRaw = 0 (or no revenueAddress) is a clean no-op.
  rakeRaw?: bigint;
  revenueAddress?: string;
};

// Assembles the whole mint play into one PTB: [create wrapper] -> [deposit shortfall] -> load Pricer -> mint. A first-ever play threads the freshly new'd wrapper by-ref through deposit + mint and shares it last (a same-PTB shared object can't be re-referenced by id once shared); a returning play passes the existing wrapper by id.
// mint_exact_amount draws from the wrapper's INTERNAL balance, so depositRaw only tops up the shortfall (a wrapper already holding chips from a cash-out can mint with no deposit); each account op takes its own fresh Auth. Signing/sponsorship + event parsing are the caller's.
export function buildMintPlay(tx: Transaction, p: MintPlayParams): void {
  const wrapper: TransactionObjectArgument = p.wrapperExists
    ? tx.object(p.wrapperId)
    : tx.moveCall({
        target: realTarget(REAL_ACCOUNT_PACKAGE, 'account_registry', 'new'),
        arguments: [tx.object(REAL_ACCOUNT_REGISTRY_ID)],
      });

  // Backing self-heal (retry only): tops the market's payout backing before the mint asserts it;
  // mutations within one PTB are visible to later commands, so the mint below sees the funded cash_balance.
  if (p.rebalanceBacking) buildRebalanceExpiryCash(tx, p.marketId);

  if (p.depositRaw > 0n) {
    const coin = coinWithBalance({ type: DUSDC_TYPE, balance: p.depositRaw })(tx);
    buildDepositFunds(tx, wrapper, buildAuth(tx), coin);
  }

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

  // House rake: withdraw from the wrapper's internal balance (fresh Auth) and send to the revenue wallet
  // before the wrapper is shared (see MintPlayParams.rakeRaw); no-op when rakeRaw=0 or no revenueAddress.
  if (p.rakeRaw && p.rakeRaw > 0n && p.revenueAddress) {
    const coin = buildWithdrawFunds(tx, wrapper, buildAuth(tx), p.rakeRaw);
    tx.transferObjects([coin], tx.pure.address(p.revenueAddress));
  }

  if (!p.wrapperExists) {
    tx.moveCall({ target: realTarget(REAL_ACCOUNT_PACKAGE, 'account', 'share'), arguments: [wrapper] });
  }
}

// Live cash-out play (one PTB): load Pricer -> redeem_live; payout lands in the wrapper internal
// balance (the user's chips), no withdraw so the game loop is one tx.
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
// per-play loop); owner-authed, runs under executeForUser.
export function buildWithdrawToWallet(
  tx: Transaction,
  p: { wrapperId: string; amountRaw: bigint; to: string },
): void {
  const coin = buildWithdrawFunds(tx, tx.object(p.wrapperId), buildAuth(tx), p.amountRaw);
  tx.transferObjects([coin], tx.pure.address(p.to));
}

// The user's chips held inside their wrapper (6dp), 0 if never created; resolves the wrapper
// (cache-aware) then reads its internal balance, the DTO sums this with the wallet.
export async function readUserChipsRaw(owner: string, cachedWrapperId?: string | null): Promise<bigint> {
  const w = await resolveWrapper(owner, cachedWrapperId);
  if (!w.exists) return 0n;
  return readWrapperBalanceRaw(w.wrapperId, owner);
}

// Read the wrapper's total DUSDC (stored + unsettled accumulator funds), 6dp; sums with the wallet
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

// Simulated mint: nothing signs, nothing lands, but the emitted OrderMinted carries the pricer's real
// entry_probability and cost. The one pre-tap window into the package-private pricing (L-012 workaround);
// the sender's wallet must hold the deposit DUSDC (the treasury does). Null when the band would abort.
export async function simulateMint(p: {
  marketId: string;
  lowerTick: bigint;
  higherTick: bigint;
  amountRaw: bigint;
  depositRaw: bigint; // must exceed amountRaw: the mint draws its fees on top of the amount budget
  leverage1e9: bigint;
  sender: string;
  wrapperId: string;
  wrapperExists: boolean;
}): Promise<MintResult | null> {
  try {
    const tx = new Transaction();
    buildMintPlay(tx, {
      marketId: p.marketId,
      wrapperId: p.wrapperId,
      wrapperExists: p.wrapperExists,
      depositRaw: p.depositRaw,
      amountRaw: p.amountRaw,
      minQuantityRaw: POSITION_LOT_SIZE,
      leverage1e9: p.leverage1e9,
      lowerTick: p.lowerTick,
      higherTick: p.higherTick,
      rakeRaw: 0n,
    });
    tx.setSender(p.sender);
    const res = await suiClient.simulateTransaction({ transaction: tx, include: { events: true }, checksEnabled: false });
    if (res.$kind !== 'Transaction') return null;
    const t = res.Transaction as unknown as {
      status?: { success?: boolean };
      events?: Array<{ eventType?: string; json?: unknown }>;
    };
    if (!t.status?.success) return null;
    const events = (t.events ?? []).map((e) => ({ type: e.eventType ?? '', parsedJson: (e.json ?? null) as Record<string, unknown> | null }));
    return parseMint(events);
  } catch {
    return null;
  }
}

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
  settlementPrice1e9: bigint | null; // only on a settled redeem (SettledOrderRedeemed.settlement_price)
};

// Parse whichever redeem event fired: live -> LiveOrderRedeemed (redeem_amount minus fees), settled -> SettledOrderRedeemed (payout_amount), liquidated -> LiquidatedOrderRedeemed (zero payout).
// Both redeem paths can emit the liquidated variant for a knocked-out order.
export function parseRedeem(events: RealEvent[]): RedeemResult {
  const liq = events.find((x) => x.type.endsWith(LiquidatedRedeemedSuffix));
  if (liq?.parsedJson) return redeemFromJson(liq.parsedJson, 'liquidated');
  const live = events.find((x) => x.type.endsWith(LiveRedeemedSuffix));
  if (live?.parsedJson) return redeemFromJson(live.parsedJson, 'live');
  const settled = events.find((x) => x.type.endsWith(SettledRedeemedSuffix));
  if (settled?.parsedJson) return redeemFromJson(settled.parsedJson, 'settled');
  throw new Error('no redeem event found (Live/Settled/Liquidated)');
}

// One parser for all three redeem event shapes (shared by parseRedeem + the GraphQL reconcile scan).
function redeemFromJson(j: Record<string, unknown>, kind: 'live' | 'settled' | 'liquidated'): RedeemResult {
  if (kind === 'liquidated') {
    return { orderId: evBig(j, 'order_id'), payoutRaw: 0n, settled: false, liquidated: true, quantityClosedRaw: evBig(j, 'quantity_closed'), replacementOrderId: null, settlementPrice1e9: null };
  }
  if (kind === 'live') {
    const gross = evBig(j, 'redeem_amount');
    const fees = evBig(j, 'trading_fee') + evBig(j, 'builder_fee') + evBig(j, 'penalty_fee');
    return {
      orderId: evBig(j, 'order_id'),
      payoutRaw: gross > fees ? gross - fees : 0n,
      settled: false,
      liquidated: false,
      quantityClosedRaw: evBig(j, 'quantity_closed'),
      replacementOrderId: evOpt(j, 'replacement_order_id'),
      settlementPrice1e9: null,
    };
  }
  return {
    orderId: evBig(j, 'order_id'),
    payoutRaw: evBig(j, 'payout_amount'),
    settled: true,
    liquidated: false,
    quantityClosedRaw: evBig(j, 'quantity_closed'),
    replacementOrderId: null,
    settlementPrice1e9: evBig(j, 'settlement_price'),
  };
}

// === Discovery via chain reads (Phase 5, plp::PoolVault + expiry_market getters) ===
// No HTTP discovery API exists (L-006), the market set comes from direct chain reads: PoolVault json inlines the live market id vector (L-003), ExpiryMarket json carries coarse routing fields.
// The economic getters (tick_size, admission_tick_size, max_admission_leverage, liquidation_ltv) come from a devInspect batch since max_admission_leverage isn't a stored field.

// Coarse per-market info read straight from ExpiryMarket json (no devInspect); enough to filter to
// cadence + underlying + liveness before paying for the economics read.
export type RealMarketCoarse = {
  marketId: string;
  underlyingId: number;
  expiryMs: number;
  settled: boolean;
  mintPaused: boolean;
};

// The economic constants a play/solver needs, read via a single devInspect getter batch (1e9- or
// raw-scaled per L-011); the caller keeps them on the market record so the solver never hardcodes them.
export type RealMarketEconomics = {
  tickSizeRaw: bigint; // raw-price tick divisor (BTC 1e7 = $0.01)
  admissionTickSizeRaw: bigint; // coarser mint-boundary step (BTC 1e9 = $1)
  maxLeverage1e9: bigint; // max_admission_leverage (BTC 3e9 = 3.0x)
  liquidationLtv1e9: bigint; // liquidation_ltv (BTC 0.85e9)
};

type MarketJson = {
  propbook_underlying_id?: string | number;
  expiry?: string | number;
  settlement_price?: unknown; // null while unsettled
  mint_paused?: boolean;
};

// Read the PoolVault's live market id vector. Flat under expiry_accounting.active_expiry_markets.
export async function readActiveMarketIds(): Promise<string[]> {
  const res = await suiClient.core.getObject({ objectId: REAL_POOL_VAULT_ID, include: { json: true } });
  const j = res.object?.json as { expiry_accounting?: { active_expiry_markets?: string[] } } | undefined;
  return j?.expiry_accounting?.active_expiry_markets ?? [];
}

// Coarse read of one ExpiryMarket from its json; null if the object is gone (rare mid-roll race).
export async function readMarketCoarse(marketId: string): Promise<RealMarketCoarse | null> {
  try {
    const res = await suiClient.core.getObject({ objectId: marketId, include: { json: true } });
    const j = res.object?.json as MarketJson | undefined;
    if (!j) return null;
    return {
      marketId,
      underlyingId: Number(j.propbook_underlying_id),
      expiryMs: Number(j.expiry),
      settled: j.settlement_price != null,
      mintPaused: j.mint_paused === true,
    };
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

// devInspect the 4 economic getters for one market in a single simulate round trip.
export async function readMarketEconomics(marketId: string): Promise<RealMarketEconomics> {
  const tx = new Transaction();
  for (const fn of ['tick_size', 'admission_tick_size', 'max_admission_leverage', 'liquidation_ltv']) {
    tx.moveCall({ target: realTarget(REAL_PREDICT_PACKAGE, 'expiry_market', fn), arguments: [tx.object(marketId)] });
  }
  // Any sender works for a checks-disabled read; the market id is a valid on-chain address to use.
  const r = await simulateRead(tx, marketId, `market economics read failed (${marketId})`);
  return {
    tickSizeRaw: decodeU64(r[0]?.returnValues?.[0]?.bcs ?? null),
    admissionTickSizeRaw: decodeU64(r[1]?.returnValues?.[0]?.bcs ?? null),
    maxLeverage1e9: decodeU64(r[2]?.returnValues?.[0]?.bcs ?? null),
    liquidationLtv1e9: decodeU64(r[3]?.returnValues?.[0]?.bcs ?? null),
  };
}

// Cadence classification from the expiry timestamp (higher-rank-overlap dedup means a 1m expiry never
// coincides with 5m/1h, cont/01 §4): 1h = %3_600_000, 5m = %300_000, else 1m.
export function isMinuteExpiry(expiryMs: number): boolean {
  return expiryMs % 300_000 !== 0 && expiryMs % 60_000 === 0;
}

// === Live spot for the chart (Phase 6) ===
// We never push prices in real mode (L-006), Mysten/Block Scholes push the Propbook feeds and we READ the live BS spot (the same feed load_live_pricer marks against) each poll and stamp it on the market set.
// game-price.ts eases that on-chain spot as the chart feed in BOTH modes; the BS spot feed json exposes lane.latest.value.spot (1e9-scaled) + a freshness ms.

export type SpotRead = { spot1e9: bigint; updatedMs: number };

// Read the live BTC BS spot (1e9-scaled) + its update timestamp; null if unreadable/unreachable (the
// caller keeps the last known spot rather than dropping the market).
export async function readBtcSpot(): Promise<SpotRead | null> {
  try {
    const res = await suiClient.core.getObject({ objectId: btcFeeds().bsSpot, include: { json: true } });
    const latest = (res.object?.json as { lane?: { latest?: { value?: { spot?: string }; update_timestamp_ms?: string } } } | undefined)?.lane?.latest;
    const spot = latest?.value?.spot;
    if (spot == null) return null;
    return { spot1e9: BigInt(spot), updatedMs: Number(latest?.update_timestamp_ms ?? 0) };
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

// === Settle support (Phase 7): order-id decode, market settlement read, redeem reconcile ===
// The u256 order id is a packed record (order.move), quantity + strike ticks decode from it alone, so the settle worker derives the full-close quantity straight from the stored order id.
// redeem_settled is permissionless + full-close, so a failed settle reconciles against the chain's own redeem event instead of looping a doomed retry (mirrors the fork's settleDuePlays).

// order.move packed-id layout (offsets/masks copied from the source, do not re-derive).
const ORDER_QUANTITY_LOTS_OFFSET = 164n;
const ORDER_LOWER_TICK_OFFSET = 70n;
const ORDER_HIGHER_TICK_OFFSET = 40n;
const TICK_MASK = (1n << 30n) - 1n;
const U32_MASK = (1n << 32n) - 1n;

export type DecodedOrder = { quantityRaw: bigint; lowerTick: bigint; higherTick: bigint };

// Decode the immutable terms from a packed order id: quantity is a complemented lot count
// (U32_MASK - lots), undo then scale by position_lot_size; ticks are plain masked fields.
export function decodeOrderId(orderId: bigint): DecodedOrder {
  const quantityLots = U32_MASK - ((orderId >> ORDER_QUANTITY_LOTS_OFFSET) & U32_MASK);
  return {
    quantityRaw: quantityLots * POSITION_LOT_SIZE,
    lowerTick: (orderId >> ORDER_LOWER_TICK_OFFSET) & TICK_MASK,
    higherTick: (orderId >> ORDER_HIGHER_TICK_OFFSET) & TICK_MASK,
  };
}

// True only when the frozen settlement price puts a position a full tick OUTSIDE its (lower, higher] band, a
// loss that pays 0 under every boundary convention (leverage/liquidation can only zero a would-be win, never
// revive a loss). The settle worker uses this to finalize such losses with no redeem tx, saving the gas.
// Deliberately conservative: returns false for a win, an on-boundary or within-a-tick price, a non-positive
// price, or a missing tick size, so the caller always redeems in every non-loss case and a winner is never
// skipped. Ticks are from decodeOrderId (lowerTick 0 = -inf, higherTick == pos_inf_tick = +inf); prices are
// 1e9-scaled and a strike is tick-aligned, so its price is exactly tick * tickSize.
export function isSettledDefiniteLoss(order: DecodedOrder, settlementPrice1e9: bigint, tickSizeRaw: bigint): boolean {
  if (settlementPrice1e9 <= 0n || tickSizeRaw <= 0n) return false;
  // Below a finite lower strike by at least one tick: a win needs price strictly above lower.
  if (order.lowerTick > 0n && settlementPrice1e9 <= order.lowerTick * tickSizeRaw - tickSizeRaw) return true;
  // Above a finite higher strike by at least one tick: a win needs price at or below higher.
  if (order.higherTick < TICK_MASK && settlementPrice1e9 >= order.higherTick * tickSizeRaw + tickSizeRaw) return true;
  return false;
}

// Read a market's settlement state from json (settlement_price is null until frozen); null if the
// market object is gone (orphaned play), so the caller can give up.
export type MarketSettlement = { settled: boolean; settlementPrice1e9: bigint | null };
export async function readMarketSettlement(marketId: string): Promise<MarketSettlement | null> {
  try {
    const res = await suiClient.core.getObject({ objectId: marketId, include: { json: true } });
    const j = res.object?.json as { settlement_price?: string | null } | undefined;
    if (!j) return null;
    return { settled: j.settlement_price != null, settlementPrice1e9: j.settlement_price != null ? BigInt(j.settlement_price) : null };
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

// Find the on-chain redeem for one order id on a wrapper: the settle backstop uses this to recover the true payout when redeem_settled aborts because the position is already gone (a live cash-out or a lost DB write).
// An order id pins the position uniquely, so scan the wrapper's txs newest-first (bounded pages); fullnode gRPC v2 has no tx-history scan, so this is GraphQL (L-002).
const TX_BY_OBJECT_QUERY = `query($obj: SuiAddress!, $last: Int!, $before: String) {
  transactions(last: $last, before: $before, filter: { affectedObject: $obj }) {
    pageInfo { hasPreviousPage startCursor }
    nodes { digest effects { events { nodes { contents { json type { repr } } } } } }
  }
}`;
type TxScanResult = {
  transactions: {
    pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
    nodes: { digest: string; effects: { events: { nodes: { contents: { json: Record<string, unknown> | null; type: { repr: string } | null } | null }[] } | null } | null }[];
  };
};

export type OnChainRedeem = { payoutRaw: bigint; settled: boolean; liquidated: boolean; digest: string };

// Scan one GraphQL tx page (oldest-first) reversed so the most recent matching redeem wins; pure so
// the GraphQL parse is unit-testable against a captured response.
export function matchRealRedeemInPage(nodes: TxScanResult['transactions']['nodes'], orderId: bigint): OnChainRedeem | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const t = nodes[i];
    for (const e of t.effects?.events?.nodes ?? []) {
      const repr = e.contents?.type?.repr ?? '';
      const kind: 'settled' | 'live' | 'liquidated' | null = repr.endsWith(SettledRedeemedSuffix)
        ? 'settled'
        : repr.endsWith(LiveRedeemedSuffix)
          ? 'live'
          : repr.endsWith(LiquidatedRedeemedSuffix)
            ? 'liquidated'
            : null;
      const j = e.contents?.json ?? null;
      if (!kind || !j) continue;
      if (String(j.order_id) !== orderId.toString()) continue;
      const r = redeemFromJson(j, kind);
      return { payoutRaw: r.payoutRaw, settled: r.settled, liquidated: r.liquidated, digest: t.digest };
    }
  }
  return null;
}

export async function findRealRedeem(wrapperId: string, orderId: bigint): Promise<OnChainRedeem | null> {
  let before: string | null = null;
  for (let page = 0; page < 6; page++) {
    const res: { data?: unknown } = await graphqlClient.query({ query: TX_BY_OBJECT_QUERY, variables: { obj: wrapperId, last: 50, before } });
    const conn = (res.data as TxScanResult | undefined)?.transactions;
    if (!conn) break;
    const hit = matchRealRedeemInPage(conn.nodes, orderId);
    if (hit) return hit;
    if (!conn.pageInfo.hasPreviousPage || !conn.pageInfo.startCursor) break;
    before = conn.pageInfo.startCursor;
  }
  return null;
}
