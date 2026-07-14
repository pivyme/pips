// Public Predict ids the client needs for reads (DUSDC balance, explorer links).
// Mirrored from the backend deployed.json into web/.env by the bootstrap. The client
// never builds a Predict moveCall itself, the backend does, so this stays minimal.

import { env } from '@/env'

export const NETWORK = env.VITE_SUI_NETWORK
// Human label for the active chain, e.g. "Sui Testnet". Drives the on-screen network badge so it
// always reflects VITE_SUI_NETWORK instead of a hardcoded string.
export const NETWORK_LABEL = `Sui ${NETWORK.charAt(0).toUpperCase()}${NETWORK.slice(1)}`
export const PACKAGE_ID = env.VITE_PREDICT_PACKAGE_ID ?? ''
export const PREDICT_ID = env.VITE_PREDICT_OBJECT_ID ?? ''

// DUSDC_TYPE is the one id the client reads at runtime (balance lookups in predict.ts). It changes
// every deploy, so instead of trusting the compile-time VITE value we refresh it from the backend
// /config at boot (refreshDeployedConfig). That way a devnet wipe + redeploy never needs a Vercel
// rebuild: the client just re-reads the live coin type. `let` + a live import binding = consumers
// (predict.ts reads it inside its functions) pick up the new value with no extra plumbing.
export let DUSDC_TYPE = env.VITE_DUSDC_TYPE ?? ''

// Stake band the backend enforces per play. Defaulted synchronously from the active network so the bet
// wheel is correct on first render (testnet = real Predict, floored at the protocol's ~$1 min-net-premium
// -> 1.5..3; anything else is the free fork's wide 1..100). /config makes it authoritative if the backend
// runs with custom PIPS_MIN_STAKE/PIPS_MAX_STAKE overrides. Mirrors backend IS_REAL_PREDICT (SUI_NETWORK==='testnet').
let STAKE_MIN = NETWORK === 'testnet' ? 1.5 : 1
let STAKE_MAX = NETWORK === 'testnet' ? 3 : 100

// Pull the live deploy ids from the backend and adopt the current DUSDC coin type + stake band.
// Fire-and-forget at app boot; on any failure (no backend, demo mode, offline) we keep the defaults above.
export async function refreshDeployedConfig(): Promise<void> {
  try {
    const res = await fetch(`${env.VITE_API_URL}/config`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return
    const body = (await res.json()) as {
      data?: { dusdcType?: string; minStake?: number; maxStake?: number }
    }
    const live = body?.data?.dusdcType
    if (live && live !== DUSDC_TYPE) DUSDC_TYPE = live
    const min = body?.data?.minStake
    const max = body?.data?.maxStake
    if (typeof min === 'number' && min > 0) STAKE_MIN = min
    if (typeof max === 'number' && max >= STAKE_MIN) STAKE_MAX = max
  } catch {
    // keep the defaults
  }
}

// The curated tiers we prefer when the band is wide enough (the free fork). A tight real band gets even rungs.
const CURATED_TIERS = [1, 5, 10, 25, 50, 100]

function buildBetLadder(min: number, max: number): number[] {
  const inside = CURATED_TIERS.filter((v) => v >= min && v <= max)
  const rungs = [...new Set([min, ...inside, max])].sort((a, b) => a - b)
  if (rungs.length >= 4) return rungs
  // Too tight for the curated tiers (e.g. 1.5..3): 4 even rungs spanning the band, rounded to a cent.
  const steps = 4
  const out: number[] = []
  for (let i = 0; i < steps; i += 1) {
    out.push(Math.round((min + ((max - min) * i) / (steps - 1)) * 100) / 100)
  }
  return [...new Set(out)]
}

// One shared bet ladder for every game + the home idle wheel, sized to the live [min, max] band so the
// wheel never offers an out-of-band bet. Cached by band so the reference is stable across renders.
let ladderCache: { min: number; max: number; ladder: number[] } | null = null
export function betLadder(): number[] {
  if (!ladderCache || ladderCache.min !== STAKE_MIN || ladderCache.max !== STAKE_MAX) {
    ladderCache = { min: STAKE_MIN, max: STAKE_MAX, ladder: buildBetLadder(STAKE_MIN, STAKE_MAX) }
  }
  return ladderCache.ladder
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
