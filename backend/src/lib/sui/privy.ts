// Privy server wrapper for privy auth mode: verify the user's access token, provision/fetch the
// embedded Sui wallet, and sign their Sui transactions with that wallet via Privy rawSign under a
// session signer (the app's authorization key the user delegated to at login). No per-spin popup,
// no client round trip. All Privy server calls funnel through here.
//
// Sui signing detail (the one subtle correctness point, confirmed in the Phase 12 spike): the Sui
// signing digest is blake2b256(messageWithIntent('TransactionData', txBytes)). Privy's rawSign
// supports blake2b256 in its hash_function enum, so we hand it the intent message bytes and let it
// hash, then assemble the ed25519 signature into the Sui serialized format.

import { PrivyClient } from '@privy-io/node';
import { messageWithIntent, toSerializedSignature } from '@mysten/sui/cryptography';
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { fromBase64, fromHex, toHex } from '@mysten/sui/utils';

import {
  PRIVY_APP_ID,
  PRIVY_APP_SECRET,
  PRIVY_AUTHORIZATION_KEY_ID,
  PRIVY_AUTHORIZATION_PRIVATE_KEY,
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

// The authorization context that lets the server act on a wallet the app's session signer controls.
// The SDK strips the `wallet-auth:` prefix and signs each request with this P-256 key. Empty when no
// key is configured (an app-owned wallet then needs no authorization signature, just the app secret).
function authContext() {
  return PRIVY_AUTHORIZATION_PRIVATE_KEY
    ? { authorization_context: { authorization_private_keys: [PRIVY_AUTHORIZATION_PRIVATE_KEY] } }
    : {};
}

// Verify a Privy access token and return the stable Privy user id (DID / sub). Throws if the
// token is invalid or expired, which the caller maps to a 401.
export async function verifyPrivyToken(accessToken: string): Promise<{ privyUserId: string }> {
  const claims = await privy().utils().auth().verifyAccessToken(accessToken);
  return { privyUserId: claims.user_id };
}

// Pull the user's email straight from Privy by user id. The access token claims don't carry it, and
// the client only knows it for the email login method (Google sign-in keeps it under the google_oauth
// account, not user.email), which is why client-reported emails came through blank. We read every
// login method that surfaces an email. Best-effort: returns null and never throws, so a Privy hiccup
// can't block sign-in.
export async function fetchPrivyEmail(privyUserId: string): Promise<string | null> {
  try {
    const user = await privy().users()._get(privyUserId);
    for (const acct of user.linked_accounts) {
      if (acct.type === 'email' && acct.address) return acct.address;
      if ((acct.type === 'google_oauth' || acct.type === 'apple_oauth') && acct.email) return acct.email;
    }
    return null;
  } catch (e) {
    console.warn('[privy] could not fetch email:', e instanceof Error ? e.message : e);
    return null;
  }
}

// Normalize Privy's ed25519 public key to the raw 32 bytes Ed25519PublicKey wants. Privy returns
// the Sui-flagged form: 33 bytes = the 0x00 ed25519 scheme flag + the 32-byte key, hex-encoded (66
// chars), and sometimes base64. Accept hex or base64, then strip the leading flag byte.
function parsePublicKey(pk: string): Uint8Array {
  const v = pk.startsWith('0x') ? pk.slice(2) : pk;
  const isHex = /^[0-9a-fA-F]+$/.test(v) && (v.length === 64 || v.length === 66);
  let bytes = isHex ? fromHex(v) : fromBase64(pk);
  if (bytes.length === 33 && bytes[0] === 0x00) bytes = bytes.slice(1);
  return bytes;
}

// The canonical Sui address for an ed25519 public key (flag 0x00 || pubkey, blake2b256, first 32B).
// The tx sender must match this or Sui rejects the signature, so we always derive it ourselves
// rather than trusting a reported address.
export function suiAddressForPublicKey(publicKey: string): string {
  return new Ed25519PublicKey(parsePublicKey(publicKey)).toSuiAddress();
}

export type ProvisionedWallet = { walletId: string; address: string; publicKey: string };

// Privy's external_id only accepts [A-Za-z0-9_-], but a Privy DID is `did:privy:<id>` (colons), so
// map the disallowed chars out. The result is stable and 1:1, so it stays a unique idempotency tag.
const toExternalId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '_');

// Provision a server-controlled embedded Sui wallet, owned by the app's authorization key so the
// server can rawSign for it. This is the headless path: the Phase 12 spike and any automated test of
// the privy signing branch use it instead of a browser login. In production the user creates their
// own wallet client-side (web/src/lib/privy.tsx) and grants this same authorization key as a session
// signer, so the server-side signing recipe below is identical either way. `externalId` makes it
// idempotent: a wallet already tagged with that id is reused instead of creating a duplicate.
export async function provisionServerSuiWallet(externalId?: string): Promise<ProvisionedWallet> {
  if (!PRIVY_AUTHORIZATION_KEY_ID) {
    throw new Error('PRIVY_AUTHORIZATION_KEY_ID is not set (needed to own a server-provisioned wallet)');
  }
  const tag = externalId ? toExternalId(externalId) : undefined;
  if (tag) {
    const existing = await findWalletByExternalId(tag);
    if (existing) return existing;
  }
  const wallet = await privy()
    .wallets()
    .create({
      chain_type: 'sui',
      owner_id: PRIVY_AUTHORIZATION_KEY_ID,
      ...(tag ? { external_id: tag } : {}),
    });
  return toProvisioned(wallet);
}

// Look a Sui wallet up by its external id (the idempotency tag), or null if none exists yet.
export async function findWalletByExternalId(externalId: string): Promise<ProvisionedWallet | null> {
  for await (const w of privy().wallets().list({ chain_type: 'sui', external_id: externalId })) {
    return toProvisioned(w);
  }
  return null;
}

function toProvisioned(w: { id: string; address: string; public_key?: string }): ProvisionedWallet {
  if (!w.public_key) throw new Error(`Privy wallet ${w.id} has no public key (cannot assemble Sui signatures)`);
  return { walletId: w.id, address: w.address, publicKey: w.public_key };
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
      ...authContext(),
    });

  const signature = fromHex(res.signature.startsWith('0x') ? res.signature.slice(2) : res.signature);
  const publicKey = new Ed25519PublicKey(parsePublicKey(input.publicKey));
  return toSerializedSignature({ signatureScheme: 'ED25519', signature, publicKey });
}
