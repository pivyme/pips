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
