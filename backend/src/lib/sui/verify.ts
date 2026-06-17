// Personal-message signature verification for the enoki (zkLogin) auth handshake.
// verifyPersonalMessageSignature throws on mismatch when { address } is passed; zkLogin
// signatures additionally need a network client to resolve the address against testnet,
// so we hand it the shared testnet client. dev mode never calls this (the backend signs).

import { verifyPersonalMessageSignature } from '@mysten/sui/verify';

import { suiClient } from './client.ts';

// Throws if `signature` is not a valid personal-message signature for `address`.
export async function verifyWalletSignature(message: string, signature: string, address: string): Promise<void> {
  const bytes = new TextEncoder().encode(message);
  await verifyPersonalMessageSignature(bytes, signature, { client: suiClient, address });
}
