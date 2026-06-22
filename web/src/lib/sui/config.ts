// Public Predict ids the client needs for reads (DUSDC balance, explorer links).
// Mirrored from the backend deployed.json into web/.env by the bootstrap. The client
// never builds a Predict moveCall itself, the backend does, so this stays minimal.

import { env } from '@/env'

export const NETWORK = env.VITE_SUI_NETWORK
export const PACKAGE_ID = env.VITE_PREDICT_PACKAGE_ID ?? ''
export const PREDICT_ID = env.VITE_PREDICT_OBJECT_ID ?? ''

// DUSDC_TYPE is the one id the client reads at runtime (balance lookups in predict.ts). It changes
// every deploy, so instead of trusting the compile-time VITE value we refresh it from the backend
// /config at boot (refreshDeployedConfig). That way a devnet wipe + redeploy never needs a Vercel
// rebuild: the client just re-reads the live coin type. `let` + a live import binding = consumers
// (predict.ts reads it inside its functions) pick up the new value with no extra plumbing.
export let DUSDC_TYPE = env.VITE_DUSDC_TYPE ?? ''

// Pull the live deploy ids from the backend and adopt the current DUSDC coin type. Fire-and-forget at
// app boot; on any failure (no backend, demo mode, offline) we keep the compile-time fallback above.
export async function refreshDeployedConfig(): Promise<void> {
  try {
    const res = await fetch(`${env.VITE_API_URL}/config`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return
    const body = (await res.json()) as { data?: { dusdcType?: string } }
    const live = body?.data?.dusdcType
    if (live && live !== DUSDC_TYPE) DUSDC_TYPE = live
  } catch {
    // keep the VITE fallback
  }
}

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
