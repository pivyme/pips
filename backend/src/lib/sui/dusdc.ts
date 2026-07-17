// DUSDC handout. Against Mysten's official Predict, DUSDC is NOT mintable (we don't own the TreasuryCap),
// so chips come only from a manually-funded treasury wallet: user-facing payouts are a plain transfer from that reserve.

import { Transaction, coinWithBalance } from '@mysten/sui/transactions';

import { suiClient } from './client.ts';
import { executeAsTreasury, executeAsRevenue } from './execute.ts';
import { TREASURY_ENABLED, REVENUE_ENABLED } from './signer.ts';
import { DUSDC_TYPE, toDusdcRaw } from './config.ts';

// Pay `amount` DUSDC (display units) to `to` via a plain transfer from the treasury's reserve, returns the
// tx digest. DUSDC is not mintable on this deployment, so an unconfigured or empty treasury fails loudly (needs a manual top-up), never an impossible mint.
export async function transferDusdc(to: string, amount: number): Promise<string> {
  if (amount <= 0) throw new Error('transferDusdc: amount must be positive');
  if (!TREASURY_ENABLED) throw new Error('transferDusdc: no treasury configured and DUSDC is not mintable on this deployment (set TREASURY_WALLET_PK)');

  const tx = new Transaction();
  const coin = coinWithBalance({ type: DUSDC_TYPE, balance: toDusdcRaw(amount) })(tx);
  tx.transferObjects([coin], tx.pure.address(to));
  try {
    return (await executeAsTreasury(tx, 'transferDusdc')).digest;
  } catch (e) {
    throw new Error(
      `transferDusdc: treasury payout failed and DUSDC is not mintable on this deployment (needs a manual top-up): ${e instanceof Error ? e.message : e}`,
    );
  }
}

// Pay `amountRaw` DUSDC (exact 6dp base units, no re-rounding) from the revenue wallet to `to`, returns
// the tx digest. The payout rail for referral-claim rewards: the rake landed in the revenue wallet, so
// the share is paid straight back out of it (self-contained accounting, no cross-wallet sweep). Signs
// with the revenue wallet via its own serialized chain (executeAsRevenue), definitive success/failure.
export async function payDusdcFromRevenue(to: string, amountRaw: bigint): Promise<string> {
  if (amountRaw <= 0n) throw new Error('payDusdcFromRevenue: amount must be positive');
  if (!REVENUE_ENABLED) throw new Error('payDusdcFromRevenue: revenue wallet not configured');

  const tx = new Transaction();
  const coin = coinWithBalance({ type: DUSDC_TYPE, balance: amountRaw })(tx);
  tx.transferObjects([coin], tx.pure.address(to));

  return (await executeAsRevenue(tx, 'referral-claim')).digest;
}

// Read an address's wallet DUSDC balance in 6dp base units.
export async function getDusdcBalanceRaw(owner: string): Promise<bigint> {
  const bal = await suiClient.getBalance({ owner, coinType: DUSDC_TYPE });
  return BigInt(bal.balance.balance);
}

// Read an address's DUSDC balance in display units.
export async function getDusdcBalance(owner: string): Promise<number> {
  return Number(await getDusdcBalanceRaw(owner)) / 1_000_000;
}
