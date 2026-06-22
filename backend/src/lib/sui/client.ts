// One testnet RPC client for the whole backend. JSON-RPC (the current non-legacy
// client, gRPC is an option later); proven against every Predict call in the spike.

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';

import { SUI_FULLNODE_URL } from '../../config/main-config.ts';
import { NETWORK } from './config.ts';

const url = SUI_FULLNODE_URL || getJsonRpcFullnodeUrl(NETWORK as 'testnet' | 'mainnet' | 'devnet' | 'localnet');

export const suiClient = new SuiJsonRpcClient({ url, network: NETWORK });

// Suiscan explorer links. Network comes from config (devnet now, mainnet later); Suiscan natively
// indexes mainnet, testnet, and devnet.
const EXPLORER_BASE = `https://suiscan.xyz/${NETWORK}`;

export const explorerTxUrl = (digest: string): string => `${EXPLORER_BASE}/tx/${digest}`;
export const explorerObjectUrl = (id: string): string => `${EXPLORER_BASE}/object/${id}`;
export const explorerAddressUrl = (address: string): string => `${EXPLORER_BASE}/account/${address}`;

// True when an error means our deployed Predict instance is no longer on the chain: the package,
// the DUSDC treasury cap, the vault, or a user's manager can't be found. Sui Devnet (not testnet)
// gets reset roughly weekly, which deletes every object we published, so the ids in config point at
// things that no longer exist until the next bootstrap. Every chain call against a stale id
// then fails with one of these resource-missing signatures (raw node errors and our own wrapped
// devInspect/exec messages both carry them). Sign-in surfaces this as CHAIN_UNAVAILABLE so the door
// can tell the user we're refreshing and point them at demo mode, instead of a generic "try again".
// Scoped to missing-resource signals only: an empty gas coin or a transient node hiccup is NOT this.
export function isChainUnavailableError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
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
    /\bpackage\b[^]*?(does not exist|was not found|not found|cannot find|deleted)/.test(m) ||
    /\bobject\b[^]*?(does not exist|was not found|not found)/.test(m)
  );
}
