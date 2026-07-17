// One gRPC client for the whole backend: fullnode reads/writes go through SuiGrpcClient, historical
// queries (events/tx-history, which gRPC v2 doesn't serve) go through SuiGraphQLClient. baseUrl is required; `new SuiGrpcClient({ network })` alone throws `base.endsWith`.

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

import { SUI_FULLNODE_URL, SUI_GRAPHQL_URL } from '../../config/main-config.ts';
import { NETWORK } from './config.ts';

// Per-network fullnode default when SUI_FULLNODE_URL is empty; public Mysten fullnodes speak grpc-web, so the same url serves both apps and this client.
const DEFAULT_FULLNODE: Record<string, string> = {
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  testnet: 'https://fullnode.testnet.sui.io:443',
};
const baseUrl = SUI_FULLNODE_URL || DEFAULT_FULLNODE[NETWORK] || DEFAULT_FULLNODE.testnet;

export const suiClient = new SuiGrpcClient({ network: NETWORK, baseUrl });

// Historical-query client (events + tx history); only market-sync oracle discovery and predict redeem-reconcile use it, everything else stays on gRPC.
export const graphqlClient = new SuiGraphQLClient({ url: SUI_GRAPHQL_URL, network: NETWORK });

// Suiscan explorer links; network comes from config (testnet now, mainnet later), Suiscan natively indexes both.
const EXPLORER_BASE = `https://suiscan.xyz/${NETWORK}`;

export const explorerTxUrl = (digest: string): string => `${EXPLORER_BASE}/tx/${digest}`;
export const explorerObjectUrl = (id: string): string => `${EXPLORER_BASE}/object/${id}`;
export const explorerAddressUrl = (address: string): string => `${EXPLORER_BASE}/account/${address}`;

// Normalizes a Sui error to lowercased, percent-decoded text: gRPC-web trailers arrive percent-encoded
// per spec (e.g. "Object%20..%20not%20found") and the transport doesn't decode them, so "not found" matchers would miss it otherwise.
export function grpcErrorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // malformed % sequence, keep the raw string
  }
  return decoded.toLowerCase();
}

// True when the deployed Predict package/vault/treasury-cap/manager is gone: Sui Devnet wipes roughly
// weekly, deleting every published object, so config ids go stale until the next bootstrap. Sign-in maps this to CHAIN_UNAVAILABLE (points the user at demo mode); scoped to missing-resource signals only, not gas/transient errors.
export function isChainUnavailableError(e: unknown): boolean {
  const m = grpcErrorText(e);
  if (!m) return false;
  return (
    m.includes('package object does not exist') ||
    m.includes('does not exist or was deleted') ||
    m.includes('objectnotfound') ||
    m.includes('no module found') ||
    m.includes('module not found') ||
    m.includes('vmverificationordeserialization') ||
    m.includes('could not find the referenced object') ||
    m.includes('is not a valid package') ||
    // gRPC surfaces a missing object/package as a bare NOT_FOUND "<id> not found" message, so match that shape too.
    m.includes('not_found') ||
    /\b(object|package)\b[^]*?not found/.test(m) ||
    /\bpackage\b[^]*?(does not exist|was not found|not found|cannot find|deleted)/.test(m) ||
    /\bobject\b[^]*?(does not exist|was not found|not found)/.test(m)
  );
}
