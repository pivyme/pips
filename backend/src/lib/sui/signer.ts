// The dev/operator keypair. In dev mode this signs user plays; in both modes it is
// the Predict operator (owns the AdminCap + oracle caps, runs the price/settle workers).

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromBase64 } from '@mysten/sui/utils';

import { TESTING_WALLET_PK } from '../../config/main-config.ts';
import { ADMIN_CAP_ID, ORACLE_CAP_IDS } from './config.ts';

function loadKeypair(): Ed25519Keypair {
  const pk = TESTING_WALLET_PK.trim();
  if (!pk) throw new Error('TESTING_WALLET_PK is empty. Set the operator key in backend/.env.');
  if (pk.startsWith('suiprivkey')) {
    const { secretKey } = decodeSuiPrivateKey(pk);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  // base64: 32-byte secret, or a 33-byte flagged keystore entry.
  const raw = fromBase64(pk);
  const secret = raw.length === 33 ? raw.slice(1) : raw;
  return Ed25519Keypair.fromSecretKey(secret);
}

export const operatorKeypair = loadKeypair();
export const operatorAddress = operatorKeypair.getPublicKey().toSuiAddress();

// The admin surface the operator holds. Oracle pushes need DISTINCT caps per lane,
// so workers round-robin over oracleCapIds.
export const operatorCaps = {
  adminCapId: ADMIN_CAP_ID,
  oracleCapIds: ORACLE_CAP_IDS,
};
