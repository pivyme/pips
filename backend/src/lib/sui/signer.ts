// Server-side signing keypairs. The operator (= testing wallet) signs dev-mode plays + the settle sweep;
// optional settlement/treasury/revenue wallets peel contention-prone duties off it, falling back to the operator when unset.

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromBase64 } from '@mysten/sui/utils';

import { TESTING_WALLET_PK, SETTLEMENT_WALLET_PK, TREASURY_WALLET_PK, REVENUE_WALLET_PK } from '../../config/main-config.ts';

// suiprivkey envelope, or base64 (32-byte secret or a 33-byte flagged keystore entry).
function parseKeypair(pk: string): Ed25519Keypair {
  if (pk.startsWith('suiprivkey')) {
    const { secretKey } = decodeSuiPrivateKey(pk);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  const raw = fromBase64(pk);
  return Ed25519Keypair.fromSecretKey(raw.length === 33 ? raw.slice(1) : raw);
}

function loadKeypair(): Ed25519Keypair {
  const pk = TESTING_WALLET_PK.trim();
  if (!pk) throw new Error('TESTING_WALLET_PK is empty. Set the operator key in backend/.env.');
  return parseKeypair(pk);
}

// Optional wallet: empty key -> null, and the duty falls back to the operator.
const loadOptional = (pk: string): Ed25519Keypair | null => (pk.trim() ? parseKeypair(pk.trim()) : null);

export const operatorKeypair = loadKeypair();
export const operatorAddress = operatorKeypair.getPublicKey().toSuiAddress();

// Settlement: signs the permissionless redeem sweep on its own gas coin so it can't block the operator
// price/nudge lane. Treasury: holds the DUSDC reserve and signs onboarding/faucet payouts.
export const settlementKeypair = loadOptional(SETTLEMENT_WALLET_PK);
export const SETTLEMENT_ENABLED: boolean = settlementKeypair != null;
export const settlementAddress: string = settlementKeypair ? settlementKeypair.getPublicKey().toSuiAddress() : '';

export const treasuryKeypair = loadOptional(TREASURY_WALLET_PK);
export const TREASURY_ENABLED: boolean = treasuryKeypair != null;
export const treasuryAddress: string = treasuryKeypair ? treasuryKeypair.getPublicKey().toSuiAddress() : '';

// Revenue: the dedicated house-rake sink. Receives DUSDC in the mint PTB and now also SIGNS referral
// claim payouts back out (services/referral.ts), so it needs a little SUI (operator-topped, ensureRevenueFunded).
// Kept separate from treasury so gross revenue stays cleanly measurable. Empty key disables the rake (lib/sui/house.ts no-ops).
export const revenueKeypair = loadOptional(REVENUE_WALLET_PK);
export const REVENUE_ENABLED: boolean = revenueKeypair != null;
export const revenueAddress: string = revenueKeypair ? revenueKeypair.getPublicKey().toSuiAddress() : '';
