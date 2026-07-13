// The one server-side Predict wrapper. Every Predict moveCall on the backend is built
// here so a mainnet re-point or id change touches only config.ts. It holds both the
// OPERATOR surface the workers use (oracle lifecycle + price pushes + reads) and the USER
// trade surface (preview + mint/redeem/manager/deposit PTB builders) the play flow uses.
// All on-chain prices/strikes are 1e9-scaled; coin amounts and quantities are 6dp.

import { Transaction, type TransactionObjectArgument } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';

import { suiClient, graphqlClient, grpcErrorText } from './client.ts';
import { operatorAddress } from './signer.ts';
import {
  ADMIN_CAP_ID,
  CLOCK,
  DUSDC_TYPE,
  PREDICT_ID,
  REGISTRY_ID,
  target,
  usd1e9,
} from './config.ts';
import { IMPLIED_VOL } from '../../config/main-config.ts';

// Flat SVI surface calibrated to IMPLIED_VOL (the move the option is priced for over a round). With
// rho=m=0 the total variance is w(k) = a + b*sqrt(k^2 + sigma^2); sigma dwarfs our ~+-12% strike
// range, so w stays ~= a + b*sigma = IMPLIED_VOL^2, flat across the strikes we actually trade. `a`
// is the variance floor that keeps w strictly positive (dodges EZeroVariance / EZeroForward). Pushed
// once per oracle right after activate; afterwards we only stream prices. The magnitude is the whole
// game: the old 0.04/0.1/0.6 was w=0.10 (~31.6% vol), ~50x the realized move, so binaries barely
// twitched and the big multipliers sat unreachably far OTM. See IMPLIED_VOL in main-config.
const W0 = IMPLIED_VOL * IMPLIED_VOL; // ATM total variance to expiry
const SVI_SIGMA = 0.6; // smoothing width, >> our strike range so the surface is flat where we trade
const SVI = {
  a: usd1e9(W0 * 0.5),
  b: usd1e9((W0 * 0.5) / SVI_SIGMA),
  sigma: usd1e9(SVI_SIGMA),
};

// === Oracle lifecycle (PTB builders) ===

// Mint a fresh OracleSVICap. Caller transfers it to the operator. Distinct caps let
// price pushes run on separate lanes without version races (gotcha #5).
export function buildCreateOracleCap(tx: Transaction): void {
  const cap = tx.moveCall({ target: target('registry', 'create_oracle_cap'), arguments: [tx.object(ADMIN_CAP_ID)] });
  tx.transferObjects([cap], tx.pure.address(operatorAddress));
}

// Create a new oracle on the registry + vault grid. The oracle is shared inside this
// call, so its id is read from the tx object changes (it cannot be wired in the same PTB).
export function buildCreateOracle(
  tx: Transaction,
  capId: string,
  underlying: string,
  expiryMs: number,
  minStrike: bigint,
  tickSize: bigint,
): void {
  tx.moveCall({
    target: target('registry', 'create_oracle'),
    arguments: [
      tx.object(REGISTRY_ID),
      tx.object(PREDICT_ID),
      tx.object(ADMIN_CAP_ID),
      tx.object(capId),
      tx.pure.string(underlying),
      tx.pure.u64(BigInt(expiryMs)),
      tx.pure.u64(minStrike),
      tx.pure.u64(tickSize),
    ],
  });
}

// Bring a freshly created oracle live in one PTB: authorize the cap (create_oracle leaves
// authorized_caps empty, gotcha #2), activate, seed the SVI surface, push the first price.
export function buildActivateOracle(tx: Transaction, oracleId: string, capId: string, spotUsd: number): void {
  tx.moveCall({
    target: target('registry', 'register_oracle_cap'),
    arguments: [tx.object(oracleId), tx.object(ADMIN_CAP_ID), tx.object(capId)],
  });
  tx.moveCall({ target: target('oracle', 'activate'), arguments: [tx.object(oracleId), tx.object(capId), tx.object(CLOCK)] });
  const zero = () => tx.moveCall({ target: target('i64', 'from_parts'), arguments: [tx.pure.u64(0n), tx.pure.bool(false)] });
  const svi = tx.moveCall({
    target: target('oracle', 'new_svi_params'),
    arguments: [tx.pure.u64(SVI.a), tx.pure.u64(SVI.b), zero(), zero(), tx.pure.u64(SVI.sigma)],
  });
  tx.moveCall({ target: target('oracle', 'update_svi'), arguments: [tx.object(oracleId), tx.object(capId), svi, tx.object(CLOCK)] });
  appendPriceUpdate(tx, oracleId, capId, spotUsd);
}

// Push a single oracle's price into an existing PTB. forward == spot (flat term structure,
// matches the bootstrap). At/after expiry this same call freezes settlement instead.
export function appendPriceUpdate(tx: Transaction, oracleId: string, capId: string, spotUsd: number): void {
  const price = usd1e9(spotUsd);
  const pd = tx.moveCall({ target: target('oracle', 'new_price_data'), arguments: [tx.pure.u64(price), tx.pure.u64(price)] });
  tx.moveCall({ target: target('oracle', 'update_prices'), arguments: [tx.object(oracleId), tx.object(capId), pd, tx.object(CLOCK)] });
}

// Reclaim a settled oracle's dense strike matrix down to constant-size state. Operator-only
// and only valid once the oracle is settled. Frees storage rebate on gas-scarce testnet.
export function buildCompactSettled(tx: Transaction, oracleId: string, capId: string): void {
  tx.moveCall({
    target: target('predict', 'compact_settled_oracle'),
    arguments: [tx.object(PREDICT_ID), tx.object(oracleId), tx.object(capId)],
  });
}

// === Reads ===

export type OracleState = {
  oracleId: string;
  underlying: string;
  expiryMs: number;
  active: boolean;
  settled: boolean;
  spot1e9: bigint;
  settlementPrice1e9: bigint | null;
  timestampMs: number;
  authorizedCapIds: string[]; // the OracleSVICap ids allowed to push/settle this oracle
};

// gRPC's `json` object view is flatter than JSON-RPC's `content.fields`: nested Move structs
// are inlined directly (no `.fields` wrapper).
type OracleFields = {
  underlying_asset: string;
  expiry: string;
  active: boolean;
  prices: { spot: string; forward: string };
  settlement_price: string | null;
  timestamp: string;
  authorized_caps?: { contents?: string[] };
};

// gRPC throws "<id> not found" where JSON-RPC returned empty object data. Reads that mean
// "gone -> null" catch this and return null instead of surfacing the throw. grpcErrorText decodes
// the percent-encoded transport message (the simulate path returns "Object%20..%20not%20found").
const isNotFound = (e: unknown): boolean => grpcErrorText(e).includes('not found');

// Run a read-only PTB via gRPC simulate (the devInspect replacement). Sets the sender, disables
// validation checks (so non-entry getters return values just like devInspect did), and throws a
// labelled error on failure. Returns command return-values (for u64 getters) and mapped events.
type SimReturnValues = { returnValues: { bcs: Uint8Array | null }[] }[];
async function simulateRead(
  tx: Transaction,
  sender: string,
  label: string,
  withEvents = false,
): Promise<{ commandResults: SimReturnValues; events: TradeEvent[] }> {
  tx.setSender(sender);
  const res = await suiClient.simulateTransaction({
    transaction: tx,
    include: withEvents ? { commandResults: true, events: true } : { commandResults: true },
    checksEnabled: false,
  });
  if (res.$kind !== 'Transaction') {
    throw new Error(`${label}: ${res.FailedTransaction?.status?.error?.message ?? 'simulate error'}`);
  }
  const events: TradeEvent[] = withEvents
    ? (res.Transaction.events ?? []).map((e) => ({ type: e.eventType, parsedJson: e.json ?? null }))
    : [];
  return { commandResults: (res.commandResults ?? []) as SimReturnValues, events };
}

// Read the current on-chain oracle state. Returns null if the object is gone or not an
// oracle. `active` is the stored flag; lifecycle status is derived against the clock by
// callers (expired = now >= expiry; settled = settlement_price set). `authorizedCapIds` is the
// on-chain set of caps allowed to push/settle it, so the settle path can find the right cap to
// nudge an oracle with even when it has fallen out of the in-memory ladder cache (a restart).
export async function readOracle(oracleId: string): Promise<OracleState | null> {
  let f: OracleFields | null;
  try {
    const obj = await suiClient.getObject({ objectId: oracleId, include: { json: true } });
    f = (obj.object?.json as unknown as OracleFields | null) ?? null;
  } catch (e) {
    if (isNotFound(e)) return null; // gRPC throws "not found" where JSON-RPC returned empty data
    throw e;
  }
  if (!f) return null;
  return {
    oracleId,
    underlying: f.underlying_asset,
    expiryMs: Number(f.expiry),
    active: f.active === true,
    settled: f.settlement_price != null,
    spot1e9: BigInt(f.prices.spot),
    settlementPrice1e9: f.settlement_price != null ? BigInt(f.settlement_price) : null,
    timestampMs: Number(f.timestamp),
    authorizedCapIds: f.authorized_caps?.contents ?? [],
  };
}

// The on-chain strike grid (min strike + tick, 1e9-scaled) the vault registered for an oracle, used
// by a follower backend (one that did not create the oracle, so it never cached the grid) to recover
// the EXACT grid instead of re-deriving it from the current spot (which drifts off the creation
// grid). The grid lives in Predict.oracle_config.oracle_grids, a Table<ID, OracleGrid> keyed by the
// oracle id. The table's own id is fixed for the deployment, so resolve it once; individual grids are
// immutable after create_oracle, so cache them forever (a follower sees at most a few hundred).
let oracleGridsTableIdP: Promise<string> | null = null;
async function oracleGridsTableId(): Promise<string> {
  if (!oracleGridsTableIdP) {
    oracleGridsTableIdP = (async () => {
      const res = await suiClient.getObject({ objectId: PREDICT_ID, include: { json: true } });
      const j = res.object?.json as { oracle_config?: { oracle_grids?: { id?: string } } } | null | undefined;
      const id = j?.oracle_config?.oracle_grids?.id;
      if (!id) throw new Error('oracle_grids table id not found on Predict');
      return id;
    })().catch((e) => {
      oracleGridsTableIdP = null; // let the next call retry the lookup
      throw e;
    });
  }
  return oracleGridsTableIdP;
}

const gridCache = new Map<string, { minStrike: bigint; tickSize: bigint }>();

export async function readOracleGrid(oracleId: string): Promise<{ minStrike: bigint; tickSize: bigint } | null> {
  const hit = gridCache.get(oracleId);
  if (hit) return hit;
  const parentId = await oracleGridsTableId();
  try {
    // gRPC's getDynamicField returns the field's BCS value; read the field wrapper object's flat
    // json view instead to keep the same `value.min_strike / value.tick_size` parse as before.
    const df = await suiClient.getDynamicField({
      parentId,
      name: { type: '0x2::object::ID', bcs: bcs.Address.serialize(oracleId).toBytes() },
    });
    const fo = await suiClient.getObject({ objectId: df.dynamicField.fieldId, include: { json: true } });
    const v = (fo.object?.json as { value?: { min_strike?: string; tick_size?: string } } | null | undefined)?.value;
    if (v?.min_strike == null || v.tick_size == null) return null;
    const grid = { minStrike: BigInt(v.min_strike), tickSize: BigInt(v.tick_size) };
    gridCache.set(oracleId, grid);
    return grid;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

// === User trade surface ===

export type Side = 'up' | 'down';

// A binary play: above/below a strike at the oracle's expiry. quantity is 6dp (max payout).
export type BinaryParams = {
  oracleId: string;
  expiryMs: number;
  strike1e9: bigint;
  side: Side;
  quantity: bigint;
};

// A range play: inside the (lower, higher) band. lower < higher asserted on-chain.
export type RangeParams = {
  oracleId: string;
  expiryMs: number;
  lower1e9: bigint;
  higher1e9: bigint;
  quantity: bigint;
};

export type TradeAmounts = { cost: bigint; payout: bigint };
export type TradeEvent = {
  type: string;
  parsedJson: Record<string, unknown> | null;
};

export type MintEventAmounts = {
  cost: bigint;
  quantity: bigint;
  managerId: string;
  oracleId: string;
};

export type RedeemEventAmounts = {
  payout: bigint;
  quantity: bigint;
  managerId: string;
  oracleId: string;
  settled: boolean;
};

const eventString = (json: Record<string, unknown>, key: string): string => {
  const value = json[key];
  if (typeof value !== 'string') throw new Error(`Predict event missing ${key}`);
  return value;
};

// The emitted Predict event is the accounting receipt. Preview calls are estimates against the
// pre-trade state; mint/redeem reprices after applying the trade's own position change, so only the
// event contains the exact amount that moved on-chain.
export function mintEventAmounts(events: TradeEvent[], kind: 'binary' | 'range'): MintEventAmounts {
  const suffix = kind === 'range' ? '::predict::RangeMinted' : '::predict::PositionMinted';
  const event = events.find((item) => item.type.endsWith(suffix));
  if (!event?.parsedJson) throw new Error(`Missing ${suffix.slice(2)} event`);
  return {
    cost: BigInt(eventString(event.parsedJson, 'cost')),
    quantity: BigInt(eventString(event.parsedJson, 'quantity')),
    managerId: eventString(event.parsedJson, 'manager_id'),
    oracleId: eventString(event.parsedJson, 'oracle_id'),
  };
}

export function redeemEventAmounts(events: TradeEvent[], kind: 'binary' | 'range'): RedeemEventAmounts {
  const suffix = kind === 'range' ? '::predict::RangeRedeemed' : '::predict::PositionRedeemed';
  const event = events.find((item) => item.type.endsWith(suffix));
  if (!event?.parsedJson) throw new Error(`Missing ${suffix.slice(2)} event`);
  return {
    payout: BigInt(eventString(event.parsedJson, 'payout')),
    quantity: BigInt(eventString(event.parsedJson, 'quantity')),
    managerId: eventString(event.parsedJson, 'manager_id'),
    oracleId: eventString(event.parsedJson, 'oracle_id'),
    settled: event.parsedJson.is_settled === true,
  };
}

// Find the on-chain redeem for one exact position key on a manager. The settle backstop uses this to
// reconcile a play whose position is already gone (a cash-out whose DB write was lost): recover the
// true payout + digest from the chain instead of retrying a redeem that can never succeed. A redeem is
// uniquely pinned by oracle + strike(s) + side + quantity, so we scan the manager's transactions
// newest-first (the lost redeem is among the most recent, settle runs seconds after expiry) and stop
// after a bounded number of pages so a genuinely-absent record fails fast instead of paging forever.
export type OnChainRedeem = { payout: bigint; quantity: bigint; settled: boolean; digest: string };
export type RedeemKey = { kind: 'binary'; params: BinaryParams } | { kind: 'range'; params: RangeParams };

// Does this event json describe the exact redeem we're reconciling? A redeem is uniquely pinned by
// oracle + strike(s) + side + quantity.
function redeemMatches(j: Record<string, unknown>, key: RedeemKey): boolean {
  if (j.oracle_id !== key.params.oracleId) return false;
  if (String(j.quantity) !== key.params.quantity.toString()) return false;
  if (key.kind === 'binary') {
    return j.is_up === (key.params.side === 'up') && String(j.strike) === key.params.strike1e9.toString();
  }
  return (
    String(j.lower_strike) === key.params.lower1e9.toString() &&
    String(j.higher_strike) === key.params.higher1e9.toString()
  );
}

// Scan one GraphQL tx page (oldest-first) reversed so the most recent matching redeem wins. Pure so
// the migrated GraphQL parse is unit-testable against a captured response.
export function matchRedeemInTxPage(nodes: TxByObjectResult['transactions']['nodes'], key: RedeemKey): OnChainRedeem | null {
  const suffix = key.kind === 'range' ? '::predict::RangeRedeemed' : '::predict::PositionRedeemed';
  for (let i = nodes.length - 1; i >= 0; i--) {
    const t = nodes[i];
    for (const e of t.effects?.events?.nodes ?? []) {
      if (!(e.contents?.type?.repr ?? '').endsWith(suffix)) continue;
      const j = e.contents?.json ?? null;
      if (j && redeemMatches(j, key)) {
        return {
          payout: BigInt(eventString(j, 'payout')),
          quantity: BigInt(eventString(j, 'quantity')),
          settled: j.is_settled === true,
          digest: t.digest,
        };
      }
    }
  }
  return null;
}

export async function findRedeemOnChain(managerId: string, key: RedeemKey): Promise<OnChainRedeem | null> {
  // Fullnode gRPC v2 has no tx-history scan, so this reconcile path uses GraphQL. `affectedObject`
  // matches every tx that used the manager (the redeem mutates it), newest-first via last/before.
  let before: string | null = null;
  for (let page = 0; page < 6; page++) {
    const res: { data?: unknown } = await graphqlClient.query({
      query: TX_BY_OBJECT_QUERY,
      variables: { obj: managerId, last: 50, before },
    });
    const conn = (res.data as TxByObjectResult | undefined)?.transactions;
    if (!conn) break;
    const hit = matchRedeemInTxPage(conn.nodes, key);
    if (hit) return hit;
    if (!conn.pageInfo.hasPreviousPage || !conn.pageInfo.startCursor) break;
    before = conn.pageInfo.startCursor;
  }
  return null;
}

// Historical tx scan for the redeem reconcile above. Newest-first (last/before), events inlined.
const TX_BY_OBJECT_QUERY = `query($obj: SuiAddress!, $last: Int!, $before: String) {
  transactions(last: $last, before: $before, filter: { affectedObject: $obj }) {
    pageInfo { hasPreviousPage startCursor }
    nodes { digest effects { events { nodes { contents { json type { repr } } } } } }
  }
}`;

type TxByObjectResult = {
  transactions: {
    pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
    nodes: {
      digest: string;
      effects: { events: { nodes: { contents: { json: Record<string, unknown> | null; type: { repr: string } | null } | null }[] } | null } | null;
    }[];
  };
};

const binaryKey = (tx: Transaction, p: BinaryParams): TransactionObjectArgument =>
  tx.moveCall({
    target: target('market_key', p.side === 'up' ? 'up' : 'down'),
    arguments: [tx.pure.id(p.oracleId), tx.pure.u64(BigInt(p.expiryMs)), tx.pure.u64(p.strike1e9)],
  });

const rangeKey = (tx: Transaction, p: RangeParams): TransactionObjectArgument =>
  tx.moveCall({
    target: target('range_key', 'new'),
    arguments: [
      tx.pure.id(p.oracleId),
      tx.pure.u64(BigInt(p.expiryMs)),
      tx.pure.u64(p.lower1e9),
      tx.pure.u64(p.higher1e9),
    ],
  });

// Decode a simulate u64 return value (little-endian BCS bytes) into a bigint.
const decodeU64 = (bytes: Uint8Array | number[] | null): bigint => {
  if (!bytes) throw new Error('missing return value bytes');
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
};

// simulate get_trade_amounts / get_range_trade_amounts -> (mint cost, redeem payout), 6dp.
async function tradeAmounts(buildKey: (tx: Transaction) => TransactionObjectArgument, getter: string, oracleId: string, quantity: bigint): Promise<TradeAmounts> {
  const tx = new Transaction();
  tx.moveCall({
    target: target('predict', getter),
    arguments: [tx.object(PREDICT_ID), tx.object(oracleId), buildKey(tx), tx.pure.u64(quantity), tx.object(CLOCK)],
  });
  const { commandResults } = await simulateRead(tx, operatorAddress, 'preview failed');
  const rv = commandResults[commandResults.length - 1]?.returnValues;
  if (!rv || rv.length < 2) throw new Error('preview returned no amounts');
  return { cost: decodeU64(rv[0].bcs), payout: decodeU64(rv[1].bcs) };
}

// The user's playable chips live in the PredictManager's inner BalanceManager: mint debits
// it, redeem credits it. Read that balance (6dp) so the wallet + manager sum is the true
// spendable balance, and so the funding step only tops up the shortfall before a mint.
// True iff the PredictManager object still exists on-chain. A devnet reset/redeploy can delete a
// user's manager while the freshly republished package survives, leaving a dead id in the DB;
// onboarding uses this to detect that and recreate. Uses getObject (clean not-found) rather than the
// balance simulate, and rethrows any non-not-found error so a real node/chain outage isn't misread
// as "gone" and doesn't trigger a needless recreate.
export async function managerExists(managerId: string): Promise<boolean> {
  try {
    await suiClient.getObject({ objectId: managerId, include: { json: true } });
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

export async function getManagerBalanceRaw(managerId: string): Promise<bigint> {
  const tx = new Transaction();
  tx.moveCall({
    target: target('predict_manager', 'balance'),
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(managerId)],
  });
  const { commandResults } = await simulateRead(tx, operatorAddress, 'manager balance read failed');
  const rv = commandResults[commandResults.length - 1]?.returnValues;
  if (!rv || rv.length < 1) throw new Error('manager balance read returned no value');
  return decodeU64(rv[0].bcs);
}

// Preview a binary mint/cash-out. cost = enter now, payout = redeem value now (live mark,
// or $1*quantity once settled ITM). Same devInspect serves both directions.
export const previewMint = (p: BinaryParams): Promise<TradeAmounts> =>
  tradeAmounts((tx) => binaryKey(tx, p), 'get_trade_amounts', p.oracleId, p.quantity);
export const previewRedeem = previewMint;

// Batch many binary previews into ONE devInspect. Every probe shares the oracle/side/expiry;
// each carries its own (strike, quantity). The whole solver curve comes back in a single round
// trip, which is the difference between a ~2s and a ~13s solve over the remote node (each
// devInspect is ~1s of node compute + network there). Safe to batch because get_trade_amounts
// has no per-strike abort: the only gate is the shared assert_quoteable_oracle, so the call
// aborts as a whole iff the oracle is no longer quoteable (expired/inactive/stale), which is the
// signal to re-route, not a partial result. Throws on a non-success devInspect so the caller can
// detect an expired oracle. cost == 0 means unmintable (price rounded to zero / outside bounds).
export async function previewBinaryBatch(
  oracleId: string,
  expiryMs: number,
  side: Side,
  probes: Array<{ strike1e9: bigint; quantity: bigint }>,
): Promise<TradeAmounts[]> {
  if (probes.length === 0) return [];
  const tx = new Transaction();
  // Each probe is two commands: build the market key, then read the trade amounts. Command k
  // pairs are interleaved [key0, getter0, key1, getter1, ...], so the getter result for probe i
  // lands at result index 2*i+1.
  for (const p of probes) {
    const key = binaryKey(tx, { oracleId, expiryMs, strike1e9: p.strike1e9, side, quantity: p.quantity });
    tx.moveCall({
      target: target('predict', 'get_trade_amounts'),
      arguments: [tx.object(PREDICT_ID), tx.object(oracleId), key, tx.pure.u64(p.quantity), tx.object(CLOCK)],
    });
  }
  const { commandResults } = await simulateRead(tx, operatorAddress, 'batch preview failed');
  return probes.map((_, i) => {
    const rv = commandResults[2 * i + 1]?.returnValues;
    if (!rv || rv.length < 2) throw new Error('batch preview returned no amounts');
    return { cost: decodeU64(rv[0].bcs), payout: decodeU64(rv[1].bcs) };
  });
}

export const previewRange = (p: RangeParams): Promise<TradeAmounts> =>
  tradeAmounts((tx) => rangeKey(tx, p), 'get_range_trade_amounts', p.oracleId, p.quantity);

// Batch many range previews into ONE devInspect. Every probe shares the oracle/expiry; each carries
// its own (lower, higher, quantity). Mirrors previewBinaryBatch: the whole band ladder is priced in
// a single round trip against one oracle snapshot, so the multiples are consistent across band sizes
// and cost ~1 devInspect total instead of one per band. Throws on a non-success devInspect (expired
// oracle), the signal to re-route. cost == 0 on a probe means that band is unmintable.
export async function previewRangeBatch(
  oracleId: string,
  expiryMs: number,
  bands: Array<{ lower1e9: bigint; higher1e9: bigint; quantity: bigint }>,
): Promise<TradeAmounts[]> {
  if (bands.length === 0) return [];
  const tx = new Transaction();
  // Each probe is two commands: build the range key, then read the trade amounts. Command pairs are
  // interleaved [key0, getter0, key1, getter1, ...], so getter result i lands at result index 2*i+1.
  for (const b of bands) {
    const key = rangeKey(tx, { oracleId, expiryMs, lower1e9: b.lower1e9, higher1e9: b.higher1e9, quantity: b.quantity });
    tx.moveCall({
      target: target('predict', 'get_range_trade_amounts'),
      arguments: [tx.object(PREDICT_ID), tx.object(oracleId), key, tx.pure.u64(b.quantity), tx.object(CLOCK)],
    });
  }
  const { commandResults } = await simulateRead(tx, operatorAddress, 'batch range preview failed');
  return bands.map((_, i) => {
    const rv = commandResults[2 * i + 1]?.returnValues;
    if (!rv || rv.length < 2) throw new Error('batch range preview returned no amounts');
    return { cost: decodeU64(rv[0].bcs), payout: decodeU64(rv[1].bcs) };
  });
}

// Create a per-user PredictManager (shared, once per user). Id read from effects on confirm.
export const buildCreateManager = (tx: Transaction): void => {
  tx.moveCall({ target: target('predict', 'create_manager') });
};

// Deposit an existing DUSDC coin argument into the manager (funds it for minting).
export const buildDeposit = (tx: Transaction, managerId: string, coin: TransactionObjectArgument): void => {
  tx.moveCall({ target: target('predict_manager', 'deposit'), typeArguments: [DUSDC_TYPE], arguments: [tx.object(managerId), coin] });
};

// Withdraw `amountRaw` (6dp) of DUSDC out of the manager's BalanceManager, back into the sender's
// wallet as a fresh Coin. Owner-gated on-chain (sender must be the manager owner), so it runs under
// executeForUser (dev = operator, privy = the user). Returns the coin to transfer or merge. Used by
// the wallet withdraw flow to reach chips that have migrated into the manager from prior plays.
export const buildManagerWithdraw = (tx: Transaction, managerId: string, amountRaw: bigint): TransactionObjectArgument =>
  tx.moveCall({
    target: target('predict_manager', 'withdraw'),
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(managerId), tx.pure.u64(amountRaw)],
  });

export const buildMint = (tx: Transaction, managerId: string, p: BinaryParams): void => {
  tx.moveCall({
    target: target('predict', 'mint'),
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(PREDICT_ID), tx.object(managerId), tx.object(p.oracleId), binaryKey(tx, p), tx.pure.u64(p.quantity), tx.object(CLOCK)],
  });
};

export const buildRedeem = (tx: Transaction, managerId: string, p: BinaryParams): void => {
  tx.moveCall({
    target: target('predict', 'redeem'),
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(PREDICT_ID), tx.object(managerId), tx.object(p.oracleId), binaryKey(tx, p), tx.pure.u64(p.quantity), tx.object(CLOCK)],
  });
};

export const buildMintRange = (tx: Transaction, managerId: string, p: RangeParams): void => {
  tx.moveCall({
    target: target('predict', 'mint_range'),
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(PREDICT_ID), tx.object(managerId), tx.object(p.oracleId), rangeKey(tx, p), tx.pure.u64(p.quantity), tx.object(CLOCK)],
  });
};

export const buildRedeemRange = (tx: Transaction, managerId: string, p: RangeParams): void => {
  tx.moveCall({
    target: target('predict', 'redeem_range'),
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(PREDICT_ID), tx.object(managerId), tx.object(p.oracleId), rangeKey(tx, p), tx.pure.u64(p.quantity), tx.object(CLOCK)],
  });
};

// Settled-only sweep into a user's manager with no owner check; the settle path uses this
// to redeem expired in-the-money positions on the user's behalf.
export const buildRedeemPermissionless = (tx: Transaction, managerId: string, p: BinaryParams): void => {
  tx.moveCall({
    target: target('predict', 'redeem_permissionless'),
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(PREDICT_ID), tx.object(managerId), tx.object(p.oracleId), binaryKey(tx, p), tx.pure.u64(p.quantity), tx.object(CLOCK)],
  });
};

// The range twin of buildRedeemPermissionless: settled-only sweep of a range position into a
// user's manager with no owner check, so the operator settles expired in-the-money range plays
// on the user's behalf in either auth mode.
export const buildRedeemRangePermissionless = (tx: Transaction, managerId: string, p: RangeParams): void => {
  tx.moveCall({
    target: target('predict', 'redeem_range_permissionless'),
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(PREDICT_ID), tx.object(managerId), tx.object(p.oracleId), rangeKey(tx, p), tx.pure.u64(p.quantity), tx.object(CLOCK)],
  });
};

// Simulate the actual owner redeem transaction. This is the executable cash-out quote: unlike
// get_trade_amounts, redeem first removes the position's own exposure and then computes the bid.
// devInspect runs that exact Move path without committing state and returns the emitted payout.
export async function previewExecutableRedeem(
  managerId: string,
  owner: string,
  key: { kind: 'binary'; params: BinaryParams } | { kind: 'range'; params: RangeParams },
): Promise<bigint> {
  const tx = new Transaction();
  if (key.kind === 'binary') buildRedeem(tx, managerId, key.params);
  else buildRedeemRange(tx, managerId, key.params);
  const { events } = await simulateRead(tx, owner, 'redeem simulation failed', true);
  return redeemEventAmounts(events, key.kind).payout;
}
