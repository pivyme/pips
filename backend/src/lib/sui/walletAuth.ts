// Wallet-connect login challenge. The user proves they own an external Sui wallet by signing a
// nonce-bearing message off-chain (no transaction, network-agnostic). We issue the exact message,
// hold it briefly server-side keyed by address, and verify the returned signature against it, so the
// client can never replay an old signature or swap in a different message. Single-instance in-memory
// store: the frontend talks to one backend, so /nonce and /verify always land on the same process.

import { randomBytes } from 'node:crypto';

import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { normalizeSuiAddress } from '@mysten/sui/utils';

const NONCE_TTL_MS = 5 * 60_000;
const MAX_PENDING = 4096;

const pending = new Map<string, { message: string; exp: number }>();

function prune(): void {
  if (pending.size < MAX_PENDING) return;
  const now = Date.now();
  for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
}

// Issue the message the wallet must sign. Stored verbatim so verify re-encodes the same bytes rather
// than trusting any bytes the client sends back.
export function issueWalletNonce(address: string): { message: string } {
  const addr = normalizeSuiAddress(address);
  const nonce = randomBytes(16).toString('hex');
  const issued = new Date().toISOString();
  const message = [
    'Sign in to Pips',
    '',
    'This signature proves you own this wallet. It is free and does not move any funds.',
    '',
    `Wallet: ${addr}`,
    `Nonce: ${nonce}`,
    `Issued: ${issued}`,
  ].join('\n');
  prune();
  pending.set(addr, { message, exp: Date.now() + NONCE_TTL_MS });
  return { message };
}

// Verify a wallet's signature over its outstanding challenge. The nonce is single-use: a successful
// verify consumes it. Returns false (never throws) on any failure so the route can map it to a clean 401.
export async function verifyWalletSignature(address: string, signature: string): Promise<boolean> {
  const addr = normalizeSuiAddress(address);
  const entry = pending.get(addr);
  if (!entry || entry.exp < Date.now()) {
    pending.delete(addr);
    return false;
  }
  try {
    const bytes = new TextEncoder().encode(entry.message);
    const publicKey = await verifyPersonalMessageSignature(bytes, signature, { address: addr });
    if (publicKey.toSuiAddress() !== addr) return false;
    pending.delete(addr); // consume on success
    return true;
  } catch {
    return false;
  }
}
