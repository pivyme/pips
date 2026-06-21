// Public Predict ids the client needs for reads (DUSDC balance, explorer links).
// Mirrored from the backend deployed.json into web/.env by the bootstrap. The client
// never builds a Predict moveCall itself, the backend does, so this stays minimal.

import { env } from '@/env'

export const NETWORK = env.VITE_SUI_NETWORK
export const PACKAGE_ID = env.VITE_PREDICT_PACKAGE_ID ?? ''
export const PREDICT_ID = env.VITE_PREDICT_OBJECT_ID ?? ''
export const DUSDC_TYPE = env.VITE_DUSDC_TYPE ?? ''

export const DUSDC_DECIMALS = 1_000_000

// 6dp raw DUSDC -> display number
export const fromDusdcRaw = (raw: bigint | string | number): number =>
  Number(BigInt(raw)) / DUSDC_DECIMALS

// Suiscan explorer links. The network comes from env (devnet now, mainnet later), so these always
// resolve to the right chain. Suiscan natively indexes mainnet, testnet, and devnet.
const EXPLORER_BASE = `https://suiscan.xyz/${NETWORK}`

export const explorerTxUrl = (digest: string): string => `${EXPLORER_BASE}/tx/${digest}`
export const explorerObjectUrl = (id: string): string => `${EXPLORER_BASE}/object/${id}`
export const explorerAddressUrl = (address: string): string => `${EXPLORER_BASE}/account/${address}`
