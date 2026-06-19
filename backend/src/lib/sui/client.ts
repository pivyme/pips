// One testnet RPC client for the whole backend. JSON-RPC (the current non-legacy
// client, gRPC is an option later); proven against every Predict call in the spike.

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';

import { SUI_FULLNODE_URL } from '../../config/main-config.ts';
import { NETWORK } from './config.ts';

const url = SUI_FULLNODE_URL || getJsonRpcFullnodeUrl(NETWORK as 'testnet' | 'mainnet' | 'devnet' | 'localnet');
const PUBLIC_LOCALNET_RPC_URL = 'https://rpc.playpips.fun';

export const suiClient = new SuiJsonRpcClient({ url, network: NETWORK });

export const explorerTxUrl = (digest: string): string =>
  NETWORK === 'localnet'
    ? `https://custom.suiscan.xyz/custom/tx/${digest}?network=${encodeURIComponent(PUBLIC_LOCALNET_RPC_URL)}`
    : `https://suiscan.xyz/${NETWORK}/tx/${digest}`;

export const explorerObjectUrl = (id: string): string =>
  `https://suiscan.xyz/${NETWORK}/object/${id}`;
