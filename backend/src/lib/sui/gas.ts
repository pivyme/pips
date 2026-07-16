// Free SUI for gas on localnet: the operator holds effectively infinite SUI, so funding a user is a plain operator-signed transfer, used at onboarding and as a low-balance top-up.
// No faucet, no rate limit. Localnet only, SUI here is free.

import { Transaction } from '@mysten/sui/transactions';

import { suiClient } from './client.ts';
import { executeAsOperator } from './execute.ts';
import { mintDusdc, getDusdcBalanceRaw, DUSDC_MINTABLE } from './dusdc.ts';
import { operatorAddress, settlementAddress, SETTLEMENT_ENABLED, treasuryAddress, TREASURY_ENABLED, revenueAddress, REVENUE_ENABLED } from './signer.ts';
import { SPONSOR_ENABLED, ensureSponsorAccumulator } from './sponsor.ts';
import {
  GAS_FUND_SUI, GAS_MIN_SUI,
  SETTLEMENT_MIN_SUI, SETTLEMENT_TOPUP_SUI,
  TREASURY_MIN_SUI, TREASURY_TOPUP_SUI, TREASURY_MIN_DUSDC, TREASURY_TOPUP_DUSDC,
  REVENUE_MIN_SUI, REVENUE_TOPUP_SUI,
} from '../../config/main-config.ts';

const SUI_TYPE = '0x2::sui::SUI';
const MIST_PER_SUI = 1_000_000_000n;

// SUI display units -> MIST.
const toMist = (sui: number): bigint => BigInt(Math.round(sui * Number(MIST_PER_SUI)));

// The refill floor in MIST: top up whenever a user's SUI dips below this.
export const GAS_MIN_RAW = toMist(GAS_MIN_SUI);

const SETTLEMENT_MIN_RAW = toMist(SETTLEMENT_MIN_SUI);
const TREASURY_MIN_SUI_RAW = toMist(TREASURY_MIN_SUI);
const REVENUE_MIN_RAW = toMist(REVENUE_MIN_SUI);
// DUSDC is 6dp; the treasury reserve floor in base units.
const TREASURY_MIN_DUSDC_RAW = BigInt(Math.round(TREASURY_MIN_DUSDC * 1_000_000));

// Read an address's SUI balance in MIST.
export async function getSuiBalanceRaw(owner: string): Promise<bigint> {
  const bal = await suiClient.getBalance({ owner, coinType: SUI_TYPE });
  return BigInt(bal.balance.balance);
}

// Transfer `amount` SUI (display units) from operator to `to` via the operator serial executor (same gas coin + queue as everything else, so the cache never desyncs).
export async function fundSui(to: string, amount: number = GAS_FUND_SUI): Promise<string> {
  if (amount <= 0) throw new Error('fundSui: amount must be positive');

  const tx = new Transaction();
  const coin = tx.splitCoins(tx.gas, [tx.pure.u64(toMist(amount))]);
  tx.transferObjects([coin], tx.pure.address(to));

  return (await executeAsOperator(tx, 'fundSui')).digest;
}

// Ensure `address` can pay its own gas (`funded` = User.suiGasFunded); first-time funding and low-balance top-up share one path, returns true on first fund so onboarding flips the flag.
// In dev mode the user IS the operator, so funding would be a pointless self-transfer, skip it and report funded.
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

// Keeps the sponsor's address-balance accumulator funded (where empty-payment sponsored gas is drawn from) by delegating to sponsor.ts's ensureSponsorAccumulator (sponsor-signed, fragmentation-robust, self-healing).
// This wrapper just lets the operator's ops-funding loop poke it; the old coin-balance gate never deposited into the accumulator and broke on faucet-fragmented SUI, wedging every privy play on MANAGER_NOT_READY.
export async function ensureSponsorFunded(): Promise<void> {
  if (!SPONSOR_ENABLED) return;
  await ensureSponsorAccumulator();
}

// Keeps the settlement wallet funded for the permissionless redeem sweep; operator-driven, idempotent, no-op when unset.
// Plain owned-coin SUI (not an address balance), the settlement executor pays its own gas from these coins.
export async function ensureSettlementFunded(): Promise<void> {
  if (!SETTLEMENT_ENABLED) return;
  if ((await getSuiBalanceRaw(settlementAddress)) >= SETTLEMENT_MIN_RAW) return;
  await fundSui(settlementAddress, SETTLEMENT_TOPUP_SUI);
  console.log(`[settlement] funded ${SETTLEMENT_TOPUP_SUI} SUI to ${settlementAddress}`);
}

// Keeps the treasury stocked: SUI for its own gas plus a DUSDC reserve it pays chips from; operator-driven, idempotent, no-op when unset.
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

// Keeps the revenue wallet in gas so it can sign referral-claim payouts; operator-driven, idempotent,
// no-op when unset. It only recently started signing (was receive-only), so this is a small SUI floor.
export async function ensureRevenueFunded(): Promise<void> {
  if (!REVENUE_ENABLED) return;
  if ((await getSuiBalanceRaw(revenueAddress)) >= REVENUE_MIN_RAW) return;
  await fundSui(revenueAddress, REVENUE_TOPUP_SUI);
  console.log(`[revenue] funded ${REVENUE_TOPUP_SUI} SUI to ${revenueAddress}`);
}

// One call the operator runs on boot + a slow cron to keep all ops wallets topped up; each step is independently best-effort, a failure in one doesn't skip the others.
// Operator-gated at the call site, only the leader owns the SUI + TreasuryCap to fund from.
export async function ensureOpsFunded(): Promise<void> {
  for (const [label, fn] of [['sponsor', ensureSponsorFunded], ['settlement', ensureSettlementFunded], ['treasury', ensureTreasuryFunded], ['revenue', ensureRevenueFunded]] as const) {
    try {
      await fn();
    } catch (e) {
      console.warn(`[ops-funding] ${label} topup failed:`, e instanceof Error ? e.message : e);
    }
  }
}
