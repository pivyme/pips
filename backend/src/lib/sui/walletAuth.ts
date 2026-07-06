// Wallet-connect login challenge. The user proves they own an external Sui wallet by signing a
// nonce-bearing message off-chain (no transaction, network-agnostic). We issue the exact message,
// hold it briefly server-side keyed by address, and verify the returned signature against it, so the
// client can never replay an old signature or swap in a different message. Single-instance in-memory
// store: the frontend talks to one backend, so /nonce and /verify always land on the same process.

import { randomBytes } from 'node:crypto';

import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { normalizeSuiAddress, fromBase64 } from '@mysten/sui/utils';
import { SuiGrpcClient } from '@mysten/sui/grpc';

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
    'Sign in to PIPS',
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

// The ed25519 wallet flag is 0x00; zkLogin is 0x05 (first byte of the serialized signature).
const ZKLOGIN_FLAG = 0x05;

// zkLogin (social) wallets like Slush prove a signature by checking the zk proof against the network
// the user signed on (its current epoch + on-chain OAuth JWKs) via the node's verifyZkLoginSignature,
// NOT against our localnet, which has neither. So those are verified against public fullnodes. Slush
// social accounts live on mainnet; testnet is the fallback. Plain keypair / multisig / passkey sigs
// verify offline with no client. Lazily built so non-zkLogin logins never touch an external node.
const ZK_FULLNODE: Record<'mainnet' | 'testnet', string> = {
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  testnet: 'https://fullnode.testnet.sui.io:443',
};
let zkClients: SuiGrpcClient[] | null = null;
function zkVerifyClients(): SuiGrpcClient[] {
  if (!zkClients) {
    zkClients = (['mainnet', 'testnet'] as const).map(
      (n) => new SuiGrpcClient({ network: n, baseUrl: ZK_FULLNODE[n] }),
    );
  }
  return zkClients;
}

function schemeFlag(signature: string): number | null {
  try {
    return fromBase64(signature)[0] ?? null;
  } catch {
    return null;
  }
}

// Verify a wallet's signature over its outstanding challenge. The nonce is single-use: a successful
// verify consumes it. Returns false (never throws) on any failure so the route can map it to a clean
// 401. The actual failure is logged so a rejected login is diagnosable instead of a silent "invalid".
export async function verifyWalletSignature(address: string, signature: string): Promise<boolean> {
  const addr = normalizeSuiAddress(address);
  const entry = pending.get(addr);
  if (!entry || entry.exp < Date.now()) {
    pending.delete(addr);
    return false;
  }

  const bytes = new TextEncoder().encode(entry.message);
  const flag = schemeFlag(signature);
  // zkLogin needs a node to verify the proof, against the network it targets; everything else is offline.
  const clients: Array<SuiGrpcClient | undefined> = flag === ZKLOGIN_FLAG ? zkVerifyClients() : [undefined];

  for (const client of clients) {
    try {
      const publicKey = await verifyPersonalMessageSignature(bytes, signature, {
        address: addr,
        ...(client ? { client } : {}),
      });
      if (publicKey.toSuiAddress() === addr) {
        pending.delete(addr); // consume on success
        return true;
      }
    } catch (e) {
      const net = client ? client.network : 'offline';
      console.warn(`[walletAuth] verify failed (scheme=${flag ?? '?'}, via=${net}) for ${addr}:`, e instanceof Error ? e.message : e);
    }
  }
  return false;
}
