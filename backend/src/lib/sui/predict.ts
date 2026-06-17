// The one server-side Predict wrapper. Every Predict moveCall on the backend is built
// here so a mainnet re-point or id change touches only config.ts. This file currently
// holds the OPERATOR surface the workers need (oracle lifecycle + price pushes + reads);
// the user trade surface (previewMint/buildMint/buildRedeem/...) lands in the play phase.
// All on-chain prices/strikes are 1e9-scaled; coin amounts are 6dp DUSDC (config helpers).

import { Transaction } from '@mysten/sui/transactions';

import { suiClient } from './client.ts';
import { operatorAddress } from './signer.ts';
import {
  ADMIN_CAP_ID,
  CLOCK,
  PREDICT_ID,
  REGISTRY_ID,
  target,
  usd1e9,
} from './config.ts';

// Smooth, near-flat SVI surface. Small positive a/sigma with rho=m=0 keeps the variance
// strictly positive and the forward non-zero, dodging EZeroVariance / EZeroForward.
// Pushed once per oracle right after activate; afterwards we only stream prices.
const SVI = { a: usd1e9(0.04), b: usd1e9(0.1), sigma: usd1e9(0.6) };

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
};

type OracleFields = {
  underlying_asset: string;
  expiry: string;
  active: boolean;
  prices: { fields: { spot: string; forward: string } };
  settlement_price: string | null;
  timestamp: string;
};

// Read the current on-chain oracle state. Returns null if the object is gone or not an
// oracle. `active` is the stored flag; lifecycle status is derived against the clock by
// callers (expired = now >= expiry; settled = settlement_price set).
export async function readOracle(oracleId: string): Promise<OracleState | null> {
  const obj = await suiClient.getObject({ id: oracleId, options: { showContent: true } });
  const content = obj.data?.content;
  if (!content || content.dataType !== 'moveObject') return null;
  const f = content.fields as unknown as OracleFields;
  return {
    oracleId,
    underlying: f.underlying_asset,
    expiryMs: Number(f.expiry),
    active: f.active === true,
    settled: f.settlement_price != null,
    spot1e9: BigInt(f.prices.fields.spot),
    settlementPrice1e9: f.settlement_price != null ? BigInt(f.settlement_price) : null,
    timestampMs: Number(f.timestamp),
  };
}
