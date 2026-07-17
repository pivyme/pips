// Public Predict ids the client needs for reads (DUSDC balance, explorer links), mirrored from the backend
// committed testnet deploy record, adopted from the backend /config at boot. The client never builds a Predict moveCall, so this stays minimal.

import { env } from '@/env'
import { isDemo } from '@/lib/demo'

export const NETWORK = env.VITE_SUI_NETWORK
// Human label for the active chain (e.g. "Sui Testnet"), drives the network badge instead of a hardcoded string.
export const NETWORK_LABEL = `Sui ${NETWORK.charAt(0).toUpperCase()}${NETWORK.slice(1)}`
export const PACKAGE_ID = env.VITE_PREDICT_PACKAGE_ID ?? ''
export const PREDICT_ID = env.VITE_PREDICT_OBJECT_ID ?? ''

// The one DUSDC id the client reads at runtime. Changes every deploy, so refreshDeployedConfig() refreshes it from
// /config at boot instead of trusting the compile-time value; `let` means consumers pick up the new value with no extra plumbing.
export let DUSDC_TYPE = env.VITE_DUSDC_TYPE ?? ''

// Stake band the backend enforces per play, defaulted synchronously so the bet wheel is right on
// first render (real Predict floors at ~$1 min-net-premium -> 1.5..3); /config overrides it.
let STAKE_MIN = 1.5
let STAKE_MAX = 3

// House rake (backend house.ts): a real play sizes off `net = stake - rake`, kept here so previews show the true
// NET max payout instead of over-promising. 0 until /config says otherwise (always 0 in demo); MIN_NET is the skip-rake floor.
let HOUSE_EDGE_BPS = 0
let HOUSE_EDGE_MIN_NET = 1.2

// Pulls live deploy ids from the backend at boot (fire-and-forget); on any failure keeps the defaults above.
export async function refreshDeployedConfig(): Promise<void> {
  try {
    const res = await fetch(`${env.VITE_API_URL}/config`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return
    const body = (await res.json()) as {
      data?: { dusdcType?: string; minStake?: number; maxStake?: number; houseEdgeBps?: number; houseEdgeMinNetUsd?: number }
    }
    const live = body?.data?.dusdcType
    if (live && live !== DUSDC_TYPE) DUSDC_TYPE = live
    const min = body?.data?.minStake
    const max = body?.data?.maxStake
    if (typeof min === 'number' && min > 0) STAKE_MIN = min
    if (typeof max === 'number' && max >= STAKE_MIN) STAKE_MAX = max
    const bps = body?.data?.houseEdgeBps
    const minNet = body?.data?.houseEdgeMinNetUsd
    if (typeof bps === 'number' && bps >= 0) HOUSE_EDGE_BPS = bps
    if (typeof minNet === 'number' && minNet >= 0) HOUSE_EDGE_MIN_NET = minNet
  } catch {
    // keep the defaults
  }
}

// Net stake a real play sizes off after the house rake; previews multiply this (not the full stake) so a projected
// win never over-promises. Demo never rakes. Mirrors backend houseRake's below-floor skip, understating at the floor rather than over.
export function netStakeUsd(stakeUsd: number): number {
  if (HOUSE_EDGE_BPS <= 0 || isDemo() || !(stakeUsd > 0)) return stakeUsd
  const net = stakeUsd - (stakeUsd * HOUSE_EDGE_BPS) / 10_000
  return net >= HOUSE_EDGE_MIN_NET ? net : stakeUsd
}

// The curated tiers we prefer when the band is wide enough. A tight real band gets even rungs.
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

// One shared bet ladder for every game + the home idle wheel, sized to the live [min, max] band; cached by band so the reference stays stable across renders.
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

// Suiscan explorer links; network comes from env so these always resolve to the active chain (both mainnet and testnet indexed).
const EXPLORER_BASE = `https://suiscan.xyz/${NETWORK}`

export const explorerTxUrl = (digest: string): string => `${EXPLORER_BASE}/tx/${digest}`
export const explorerObjectUrl = (id: string): string => `${EXPLORER_BASE}/object/${id}`
export const explorerAddressUrl = (address: string): string => `${EXPLORER_BASE}/account/${address}`
