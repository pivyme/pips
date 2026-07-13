// DUSDC handout. Minting via our own treasury cap (operator-signed, used to seed the vault + the
// treasury reserve), and the user-facing payout path (transferDusdc), which prefers a plain transfer
// from the treasury reserve so chips never come off the operator key.

import { Transaction, coinWithBalance } from '@mysten/sui/transactions';

import { suiClient } from './client.ts';
import { executeAsOperator, executeAsTreasury } from './execute.ts';
import { TREASURY_ENABLED } from './signer.ts';
import { DUSDC_TYPE, DUSDC_TREASURY_CAP_ID, toDusdcRaw } from './config.ts';

// True only when we actually own the DUSDC TreasuryCap for this deployment (our own vendored
// Predict instance). False against a deployment we don't operate (e.g. Mysten's official testnet
// Predict), where DUSDC can only come from a manually-funded treasury wallet, never a mint.
export const DUSDC_MINTABLE = Boolean(DUSDC_TREASURY_CAP_ID);

// Mint `amount` DUSDC (display units) and send it to `to`. Returns the tx digest. Routes
// through the operator executor (not a direct sign) so it shares the same gas coin + queue as
// the workers and never desyncs their object cache.
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

// Pay `amount` DUSDC (display units) to `to`. Prefers the treasury wallet: a plain transfer from its
// pre-minted (or, on a deployment we don't operate, manually human-funded) reserve, which keeps
// chips OFF the operator key (a follower never signs an operator tx, and the operator's gas coin
// never churns on a mint). Falls back to an operator mint only when we actually own the TreasuryCap
// (DUSDC_MINTABLE) — on a deployment we don't operate there is no mint to fall back to, so an empty
// treasury fails loudly instead of attempting an impossible mint. Returns the tx digest.
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
    // Treasury unfunded (e.g. before the operator's first top-up) or briefly unreachable: fall back to
    // a direct mint so onboarding/faucet never hard-fail. The operator owns the TreasuryCap and every
    // backend holds that key, so the mint always works. Rare and self-healing: once the operator funds
    // the treasury, the transfer path takes over and this stops firing.
    console.warn('[treasury] payout failed, falling back to mint:', e instanceof Error ? e.message : e);
    return mintDusdc(to, amount);
  }
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
