// Custodial play wallets for wallet-connect login: after a user proves ownership of an external wallet
// (off-chain nonce signature), the server holds a per-user ed25519 wallet for all on-chain work, keeping the no-popup play loop. Keys are encrypted at rest (AES-256-GCM, WALLET_ENCRYPTION_KEY); move to a KMS/HSM before mainnet.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromBase64, fromHex } from '@mysten/sui/utils';

import { WALLET_ENCRYPTION_KEY } from '../../config/main-config.ts';

const IV_LEN = 12; // GCM standard nonce length
const TAG_LEN = 16;

// 32-byte AES key from env: accept hex (64 chars) or base64 (44 chars). Validated lazily so the app
// only requires it when wallet-connect is actually used, not on every boot.
let cachedKey: Buffer | null = null;
function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = WALLET_ENCRYPTION_KEY.trim();
  if (!raw) throw new Error('PIPS_WALLET_ENCRYPTION_KEY is not set (required for wallet-connect login)');
  const bytes = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(fromHex(raw)) : Buffer.from(fromBase64(raw));
  if (bytes.length !== 32) throw new Error('PIPS_WALLET_ENCRYPTION_KEY must be 32 bytes (hex64 or base64)');
  cachedKey = bytes;
  return bytes;
}

// Stored blob layout: base64( iv | authTag | ciphertext ). Self-describing, single column.
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptSecret(blob: string): string {
  const buf = Buffer.from(blob, 'base64');
  if (buf.length <= IV_LEN + TAG_LEN) throw new Error('custodial secret blob is malformed');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export type GeneratedCustodialWallet = { address: string; encryptedSecret: string };

// Mint a fresh custodial play wallet. The secret is stored as the suiprivkey bech32 string (encrypted),
// mirroring how the operator key is loaded, so loadCustodialKeypair can decodeSuiPrivateKey it back.
export function generateCustodialWallet(): GeneratedCustodialWallet {
  const kp = Ed25519Keypair.generate();
  return { address: kp.getPublicKey().toSuiAddress(), encryptedSecret: encryptSecret(kp.getSecretKey()) };
}

export function loadCustodialKeypair(encryptedSecret: string): Ed25519Keypair {
  const { secretKey } = decodeSuiPrivateKey(decryptSecret(encryptedSecret));
  return Ed25519Keypair.fromSecretKey(secretKey);
}
