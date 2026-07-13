// Free SUI for gas on localnet. The operator holds effectively infinite SUI, so funding a
// user is a plain operator-signed transfer (split off the gas coin). Used at onboarding so a
// privy user can pay their own play gas, and as a low-balance top-up so nobody gets stuck
// mid-session. No faucet, no rate limit. Localnet only; SUI here is free.

import { Transaction } from '@mysten/sui/transactions';

import { suiClient } from './client.ts';
import { executeAsOperator } from './execute.ts';
import { mintDusdc, getDusdcBalanceRaw, DUSDC_MINTABLE } from './dusdc.ts';
import { operatorAddress, settlementAddress, SETTLEMENT_ENABLED, treasuryAddress, TREASURY_ENABLED } from './signer.ts';
import { SPONSOR_ENABLED, ensureSponsorAccumulator } from './sponsor.ts';
import {
  GAS_FUND_SUI, GAS_MIN_SUI,
  SETTLEMENT_MIN_SUI, SETTLEMENT_TOPUP_SUI,
  TREASURY_MIN_SUI, TREASURY_TOPUP_SUI, TREASURY_MIN_DUSDC, TREASURY_TOPUP_DUSDC,
} from '../../config/main-config.ts';

const SUI_TYPE = '0x2::sui::SUI';
const MIST_PER_SUI = 1_000_000_000n;

// SUI display units -> MIST.
const toMist = (sui: number): bigint => BigInt(Math.round(sui * Number(MIST_PER_SUI)));

// The refill floor in MIST: top up whenever a user's SUI dips below this.
export const GAS_MIN_RAW = toMist(GAS_MIN_SUI);

const SETTLEMENT_MIN_RAW = toMist(SETTLEMENT_MIN_SUI);
const TREASURY_MIN_SUI_RAW = toMist(TREASURY_MIN_SUI);
// DUSDC is 6dp; the treasury reserve floor in base units.
const TREASURY_MIN_DUSDC_RAW = BigInt(Math.round(TREASURY_MIN_DUSDC * 1_000_000));

// Read an address's SUI balance in MIST.
export async function getSuiBalanceRaw(owner: string): Promise<bigint> {
  const bal = await suiClient.getBalance({ owner, coinType: SUI_TYPE });
  return BigInt(bal.balance.balance);
}

// Transfer `amount` SUI (display units) from the operator to `to`. Routes through the operator
// serial executor (same gas coin + queue as everything else) so the operator object cache never
// desyncs. Returns the tx digest.
export async function fundSui(to: string, amount: number = GAS_FUND_SUI): Promise<string> {
  if (amount <= 0) throw new Error('fundSui: amount must be positive');

  const tx = new Transaction();
  const coin = tx.splitCoins(tx.gas, [tx.pure.u64(toMist(amount))]);
  tx.transferObjects([coin], tx.pure.address(to));

  return (await executeAsOperator(tx, 'fundSui')).digest;
}

// Ensure `address` can pay its own gas. `funded` is the User.suiGasFunded flag. First-time
// funding and the ongoing low-balance top-up share one path. Returns true when this was the
// first fund (so onboarding flips the flag). In dev mode the user IS the operator, so funding
// it is a pointless self-transfer; skip it and just report funded.
export async function ensureSuiGas(address: string, funded: boolean): Promise<boolean> {
  if (address === operatorAddress) return !funded;

  if (!funded) {
    await fundSui(address);
    return true;
  }
  if ((await getSuiBalanceRaw(address)) < GAS_MIN_RAW) {
    await fundSui(address);
  }
  return false;
}

// Keep the gas sponsor able to pay for user plays. The sponsor's address-balance accumulator (where
// empty-payment sponsored gas is drawn from) is the thing that has to stay funded, and it lives in
// sponsor.ts now: ensureSponsorAccumulator is sponsor-signed (works on a follower with no operator),
// fragmentation-robust, and self-healing. This wrapper just delegates so the operator's ops-funding
// loop still pokes it. The old form here gated on the COIN balance (which the devnet faucet keeps
// high) and so never deposited into the accumulator, and split from a single gas coin (which failed
// on faucet-fragmented SUI), the two-bug combo that left every privy play stuck on MANAGER_NOT_READY.
export async function ensureSponsorFunded(): Promise<void> {
  if (!SPONSOR_ENABLED) return;
  await ensureSponsorAccumulator();
}

// Keep the settlement wallet able to pay gas for the permissionless redeem sweep. Operator-driven,
// idempotent, generous (free localnet SUI). No-op when no settlement wallet is set. Plain owned-coin
// SUI (not an address balance): the settlement executor pays its own gas from these coins.
export async function ensureSettlementFunded(): Promise<void> {
  if (!SETTLEMENT_ENABLED) return;
  if ((await getSuiBalanceRaw(settlementAddress)) >= SETTLEMENT_MIN_RAW) return;
  await fundSui(settlementAddress, SETTLEMENT_TOPUP_SUI);
  console.log(`[settlement] funded ${SETTLEMENT_TOPUP_SUI} SUI to ${settlementAddress}`);
}

// Keep the treasury stocked: SUI for its own gas, and a big DUSDC reserve it pays chips from.
// Operator-driven (the operator owns the gas SUI + the DUSDC TreasuryCap), idempotent, generous.
// No-op when no treasury wallet is set.
export async function ensureTreasuryFunded(): Promise<void> {
  if (!TREASURY_ENABLED) return;
  if ((await getSuiBalanceRaw(treasuryAddress)) < TREASURY_MIN_SUI_RAW) {
    await fundSui(treasuryAddress, TREASURY_TOPUP_SUI);
    console.log(`[treasury] funded ${TREASURY_TOPUP_SUI} SUI to ${treasuryAddress}`);
  }
  if ((await getDusdcBalanceRaw(treasuryAddress)) < TREASURY_MIN_DUSDC_RAW) {
    if (!DUSDC_MINTABLE) {
      console.warn(`[treasury] DUSDC below floor and not mintable on this deployment; needs a manual top-up to ${treasuryAddress}`);
    } else {
      await mintDusdc(treasuryAddress, TREASURY_TOPUP_DUSDC);
      console.log(`[treasury] minted ${TREASURY_TOPUP_DUSDC} DUSDC to ${treasuryAddress}`);
    }
  }
}

// One call the operator runs on boot + on a slow cron to keep all three ops wallets topped up. Each
// step is independently best-effort; a failure in one doesn't skip the others. Operator-gated at the
// call site (only the leader owns the SUI + TreasuryCap to fund from).
export async function ensureOpsFunded(): Promise<void> {
  for (const [label, fn] of [['sponsor', ensureSponsorFunded], ['settlement', ensureSettlementFunded], ['treasury', ensureTreasuryFunded]] as const) {
    try {
      await fn();
    } catch (e) {
      console.warn(`[ops-funding] ${label} topup failed:`, e instanceof Error ? e.message : e);
    }
  }
}
