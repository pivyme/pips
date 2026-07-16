// DUSDC handout: minting via our own treasury cap (operator-signed, seeds the vault + treasury reserve).
// User-facing payout (transferDusdc) prefers a plain transfer from the treasury reserve so chips never come off the operator key.

import { Transaction, coinWithBalance } from '@mysten/sui/transactions';

import { suiClient } from './client.ts';
import { executeAsOperator, executeAsTreasury, executeAsRevenue } from './execute.ts';
import { TREASURY_ENABLED, REVENUE_ENABLED } from './signer.ts';
import { DUSDC_TYPE, DUSDC_TREASURY_CAP_ID, toDusdcRaw } from './config.ts';

// True only when we own the DUSDC TreasuryCap for this deployment (our vendored Predict instance).
// False against a deployment we don't operate (Mysten's official testnet Predict), where DUSDC only comes from a manually-funded treasury wallet, never a mint.
export const DUSDC_MINTABLE = Boolean(DUSDC_TREASURY_CAP_ID);

// Mint `amount` DUSDC (display units) to `to`, returns the tx digest.
// Routes through the operator executor (not a direct sign) so it shares gas coin + queue with the workers and never desyncs their object cache.
export async function mintDusdc(to: string, amount: number): Promise<string> {
  if (amount <= 0) throw new Error('mintDusdc: amount must be positive');
  if (!DUSDC_MINTABLE) throw new Error('mintDusdc: this deployment\'s DUSDC TreasuryCap is not ours, cannot mint');

  const tx = new Transaction();
  const coin = tx.moveCall({
    target: '0x2::coin::mint',
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(DUSDC_TREASURY_CAP_ID), tx.pure.u64(toDusdcRaw(amount))],
  });
  tx.transferObjects([coin], tx.pure.address(to));

  return (await executeAsOperator(tx, 'mintDusdc')).digest;
}

// Pay `amount` DUSDC (display units) to `to`, preferring a plain transfer from the treasury's reserve so chips stay off the operator key (a follower never signs an operator tx).
// Falls back to an operator mint only when we own the TreasuryCap (DUSDC_MINTABLE); otherwise an empty treasury fails loudly instead of attempting an impossible mint.
export async function transferDusdc(to: string, amount: number): Promise<string> {
  if (amount <= 0) throw new Error('transferDusdc: amount must be positive');
  if (!TREASURY_ENABLED) {
    if (!DUSDC_MINTABLE) throw new Error('transferDusdc: no treasury configured and DUSDC is not mintable on this deployment');
    return mintDusdc(to, amount);
  }

  const tx = new Transaction();
  const coin = coinWithBalance({ type: DUSDC_TYPE, balance: toDusdcRaw(amount) })(tx);
  tx.transferObjects([coin], tx.pure.address(to));
  try {
    return (await executeAsTreasury(tx, 'transferDusdc')).digest;
  } catch (e) {
    if (!DUSDC_MINTABLE) {
      throw new Error(
        `transferDusdc: treasury payout failed and DUSDC is not mintable on this deployment (needs a manual top-up): ${e instanceof Error ? e.message : e}`,
      );
    }
    // Treasury unfunded or briefly unreachable: fall back to a direct mint so onboarding/faucet never hard-fail (the operator owns the TreasuryCap, so this always works).
    // Rare and self-healing, once the operator funds the treasury the transfer path takes over.
    console.warn('[treasury] payout failed, falling back to mint:', e instanceof Error ? e.message : e);
    return mintDusdc(to, amount);
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
