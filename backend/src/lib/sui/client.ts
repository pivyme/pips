// One gRPC client for the whole backend. JSON-RPC is deprecated: fullnode reads/writes go
// through SuiGrpcClient (grpc-web over fetch), historical queries (events / tx-history, which
// fullnode gRPC v2 does not serve) go through SuiGraphQLClient. baseUrl is required, the
// `new SuiGrpcClient({ network })` shorthand throws `base.endsWith`; pass the fullnode url.

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

import { SUI_FULLNODE_URL, SUI_GRAPHQL_URL } from '../../config/main-config.ts';
import { NETWORK } from './config.ts';

// Per-network fullnode gRPC default when SUI_FULLNODE_URL is empty. The public Mysten
// fullnodes speak grpc-web, so the same url serves both apps and this client.
const DEFAULT_FULLNODE: Record<string, string> = {
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  testnet: 'https://fullnode.testnet.sui.io:443',
  devnet: 'https://fullnode.devnet.sui.io:443',
  localnet: 'http://127.0.0.1:9000',
};
const baseUrl = SUI_FULLNODE_URL || DEFAULT_FULLNODE[NETWORK] || DEFAULT_FULLNODE.devnet;

export const suiClient = new SuiGrpcClient({ network: NETWORK, baseUrl });

// Historical-query client (events + tx history). Only the two scan paths (market-sync oracle
// discovery, predict redeem-reconcile) use it; everything else stays on gRPC.
export const graphqlClient = new SuiGraphQLClient({ url: SUI_GRAPHQL_URL, network: NETWORK });

// Suiscan explorer links. Network comes from config (devnet now, mainnet later); Suiscan natively
// indexes mainnet, testnet, and devnet.
const EXPLORER_BASE = `https://suiscan.xyz/${NETWORK}`;

export const explorerTxUrl = (digest: string): string => `${EXPLORER_BASE}/tx/${digest}`;
export const explorerObjectUrl = (id: string): string => `${EXPLORER_BASE}/object/${id}`;
export const explorerAddressUrl = (address: string): string => `${EXPLORER_BASE}/account/${address}`;

// Normalized, lowercased text of a Sui error for matching. The gRPC-web transport surfaces the
// status message percent-encoded (spaces as %20, e.g. "Object%200x..%20not%20found"), because the
// grpc-message trailer is percent-encoded per spec and the transport doesn't decode it. Matchers
// that look for literal "not found" would miss that, so decode first. Safe on already-plain text.
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

// True when an error means our deployed Predict instance is no longer on the chain: the package,
// the DUSDC treasury cap, the vault, or a user's manager can't be found. Sui Devnet (not testnet)
// gets reset roughly weekly, which deletes every object we published, so the ids in config point at
// things that no longer exist until the next bootstrap. Every chain call against a stale id
// then fails with one of these resource-missing signatures (raw node errors and our own wrapped
// devInspect/exec messages both carry them). Sign-in surfaces this as CHAIN_UNAVAILABLE so the door
// can tell the user we're refreshing and point them at demo mode, instead of a generic "try again".
// Scoped to missing-resource signals only: an empty gas coin or a transient node hiccup is NOT this.
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
    // gRPC surfaces a missing object/package as a NOT_FOUND status with a bare "<id> not found"
    // message (e.g. "Object 0x.. not found"), so match that shape too.
    m.includes('not_found') ||
    /\b(object|package)\b[^]*?not found/.test(m) ||
    /\bpackage\b[^]*?(does not exist|was not found|not found|cannot find|deleted)/.test(m) ||
    /\bobject\b[^]*?(does not exist|was not found|not found)/.test(m)
  );
}
