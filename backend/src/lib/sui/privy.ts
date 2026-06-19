// Privy server wrapper for privy auth mode: verify the user's access token, and sign their Sui
// transactions with their embedded ed25519 wallet via Privy rawSign under a session signer (the
// app's authorization key the user delegated to at login). No per-spin popup, no client round
// trip. All Privy server calls funnel through here.
//
// Sui signing detail (the one subtle correctness point, confirmed in the Phase 12 spike): the
// Sui signing digest is blake2b256(messageWithIntent('TransactionData', txBytes)). Privy's
// rawSign supports blake2b256 in its hash_function enum, so we hand it the intent message bytes
// and let it hash, then assemble the ed25519 signature into the Sui serialized format.

import { PrivyClient } from '@privy-io/node';
import { messageWithIntent, toSerializedSignature } from '@mysten/sui/cryptography';
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { fromBase64, fromHex, toHex } from '@mysten/sui/utils';

import {
  PRIVY_APP_ID,
  PRIVY_APP_SECRET,
  PRIVY_AUTHORIZATION_KEY,
  PRIVY_JWT_VERIFICATION_KEY,
} from '../../config/main-config.ts';

let client: PrivyClient | null = null;
function privy(): PrivyClient {
  if (!client) {
    if (!PRIVY_APP_ID || !PRIVY_APP_SECRET) {
      throw new Error('PRIVY_APP_ID / PRIVY_APP_SECRET are not set (required in privy mode)');
    }
    client = new PrivyClient({
      appId: PRIVY_APP_ID,
      appSecret: PRIVY_APP_SECRET,
      ...(PRIVY_JWT_VERIFICATION_KEY ? { jwtVerificationKey: PRIVY_JWT_VERIFICATION_KEY } : {}),
    });
  }
  return client;
}

// Verify a Privy access token and return the stable Privy user id (DID / sub). Throws if the
// token is invalid or expired, which the caller maps to a 401.
export async function verifyPrivyToken(accessToken: string): Promise<{ privyUserId: string }> {
  const claims = await privy().utils().auth().verifyAccessToken(accessToken);
  return { privyUserId: claims.user_id };
}

// Privy returns the ed25519 public key as a 32-byte hex string (sometimes base64). Normalize.
function parsePublicKey(pk: string): Uint8Array {
  const v = pk.startsWith('0x') ? pk.slice(2) : pk;
  if (/^[0-9a-fA-F]+$/.test(v) && v.length === 64) return fromHex(v);
  return fromBase64(pk);
}

// Sign a built Sui transaction (BCS TransactionData bytes) with the user's embedded wallet and
// return the Sui serialized signature ready for executeTransactionBlock.
export async function signSuiTxWithPrivy(input: {
  walletId: string;
  publicKey: string;
  txBytes: Uint8Array;
}): Promise<string> {
  const intent = messageWithIntent('TransactionData', input.txBytes);
  const res = await privy()
    .wallets()
    .rawSign(input.walletId, {
      params: { bytes: '0x' + toHex(intent), encoding: 'hex', hash_function: 'blake2b256' },
      ...(PRIVY_AUTHORIZATION_KEY
        ? { authorization_context: { authorization_private_keys: [PRIVY_AUTHORIZATION_KEY] } }
        : {}),
    });

  const signature = fromHex(res.signature.startsWith('0x') ? res.signature.slice(2) : res.signature);
  const publicKey = new Ed25519PublicKey(parsePublicKey(input.publicKey));
  return toSerializedSignature({ signatureScheme: 'ED25519', signature, publicKey });
}
