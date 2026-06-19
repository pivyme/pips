// Gas sponsorship via Sui Address Balances. One dedicated wallet (GAS_SPONSORSHIP_WALLET_PK) pays
// the gas for every privy user play, so users only ever hold DUSDC and never think about SUI.
//
// Why this stays stable under load: the sponsored tx names this wallet as the gas OWNER with an
// EMPTY gas payment, so gas is drawn from the wallet's SUI address balance (an accumulator), not an
// owned gas coin. With no owned gas coin in the tx, concurrent plays from different users share zero
// owned objects and can never equivocate (the classic single-gas-coin failure that freezes a coin
// until epoch end). Our localnet has enable_address_balance_gas_payments=true, and the SDK resolves
// the required single-epoch expiration automatically at build() when the payment is empty.
//
// The sponsor only ever signs as the gas owner, so it can authorize gas but never move a user's
// funds. Keep this address single-purpose (gas only) per Sui guidance, so nothing else contends for
// it; the operator (signer.ts) is a deliberately separate wallet.

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromBase64 } from '@mysten/sui/utils';
import type { Transaction } from '@mysten/sui/transactions';

import { GAS_SPONSORSHIP_WALLET_PK } from '../../config/main-config.ts';

// Same parser as the operator key (signer.ts): a suiprivkey envelope, or base64 (32-byte secret or
// a 33-byte flagged keystore entry).
function loadKeypair(pk: string): Ed25519Keypair {
  const k = pk.trim();
  if (k.startsWith('suiprivkey')) {
    const { secretKey } = decodeSuiPrivateKey(k);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  const raw = fromBase64(k);
  const secret = raw.length === 33 ? raw.slice(1) : raw;
  return Ed25519Keypair.fromSecretKey(secret);
}

// Off when no key is set: executeForUser then leaves the user as their own gas payer (the per-user
// SUI funding fallback in gas.ts handles that).
export const SPONSOR_ENABLED: boolean = Boolean(GAS_SPONSORSHIP_WALLET_PK.trim());

const sponsorKeypair = SPONSOR_ENABLED ? loadKeypair(GAS_SPONSORSHIP_WALLET_PK) : null;
export const sponsorAddress: string = sponsorKeypair ? sponsorKeypair.getPublicKey().toSuiAddress() : '';

// Name the sponsor as gas owner with an empty payment, so gas comes from its address balance. We do
// NOT pin the budget: the build-time dry-run sizes it to the real cost (the sponsor's balance dwarfs
// any play, and the storage rebate credits back to that balance), which also adapts to heavier txs
// like a future withdrawal. The gas price is set by the caller (execute.ts) from its cached value.
export function applySponsorGas(tx: Transaction): void {
  if (!sponsorKeypair) throw new Error('applySponsorGas: sponsor wallet not configured');
  tx.setGasOwner(sponsorAddress);
  tx.setGasPayment([]);
}

// Co-sign the built bytes as the gas owner. A plain local ed25519 sign, no network round trip. The
// user signs the same bytes separately (via Privy rawSign); both signatures are submitted together.
export async function signAsSponsor(txBytes: Uint8Array): Promise<string> {
  if (!sponsorKeypair) throw new Error('signAsSponsor: sponsor wallet not configured');
  return (await sponsorKeypair.signTransaction(txBytes)).signature;
}
