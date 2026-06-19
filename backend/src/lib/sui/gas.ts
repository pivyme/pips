// Free SUI for gas on localnet. The operator holds effectively infinite SUI, so funding a
// user is a plain operator-signed transfer (split off the gas coin). Used at onboarding so a
// privy user can pay their own play gas, and as a low-balance top-up so nobody gets stuck
// mid-session. No faucet, no rate limit. Localnet only; SUI here is free.

import { Transaction } from '@mysten/sui/transactions';

import { suiClient } from './client.ts';
import { executeAsOperator } from './execute.ts';
import { operatorAddress } from './signer.ts';
import { GAS_FUND_SUI, GAS_MIN_SUI } from '../../config/main-config.ts';

const SUI_TYPE = '0x2::sui::SUI';
const MIST_PER_SUI = 1_000_000_000n;

// SUI display units -> MIST.
const toMist = (sui: number): bigint => BigInt(Math.round(sui * Number(MIST_PER_SUI)));

// The refill floor in MIST: top up whenever a user's SUI dips below this.
export const GAS_MIN_RAW = toMist(GAS_MIN_SUI);

// Read an address's SUI balance in MIST.
export async function getSuiBalanceRaw(owner: string): Promise<bigint> {
  const bal = await suiClient.getBalance({ owner, coinType: SUI_TYPE });
  return BigInt(bal.totalBalance);
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
