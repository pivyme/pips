// Free DUSDC minting via our own treasury. Used for onboarding chips (new users get
// starting balance) and to top up the vault. We own the treasury cap, so this is a
// pure operator-signed mint, no faucet, no rate limit.

import { Transaction } from '@mysten/sui/transactions';

import { suiClient } from './client.ts';
import { operatorKeypair, operatorAddress } from './signer.ts';
import { DUSDC_TYPE, DUSDC_TREASURY_CAP_ID, toDusdcRaw } from './config.ts';

// Mint `amount` DUSDC (display units) and send it to `to`. Returns the tx digest.
export async function mintDusdc(to: string, amount: number): Promise<string> {
  if (amount <= 0) throw new Error('mintDusdc: amount must be positive');

  const tx = new Transaction();
  const coin = tx.moveCall({
    target: '0x2::coin::mint',
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(DUSDC_TREASURY_CAP_ID), tx.pure.u64(toDusdcRaw(amount))],
  });
  tx.transferObjects([coin], tx.pure.address(to));
  tx.setSender(operatorAddress);

  const res = await suiClient.signAndExecuteTransaction({
    transaction: tx,
    signer: operatorKeypair,
    options: { showEffects: true },
  });
  if (res.effects?.status.status !== 'success') {
    throw new Error(`mintDusdc failed: ${JSON.stringify(res.effects?.status)}`);
  }
  await suiClient.waitForTransaction({ digest: res.digest });
  return res.digest;
}

// Read an address's wallet DUSDC balance in 6dp base units.
export async function getDusdcBalanceRaw(owner: string): Promise<bigint> {
  const bal = await suiClient.getBalance({ owner, coinType: DUSDC_TYPE });
  return BigInt(bal.totalBalance);
}

// Read an address's DUSDC balance in display units.
export async function getDusdcBalance(owner: string): Promise<number> {
  return Number(await getDusdcBalanceRaw(owner)) / 1_000_000;
}
