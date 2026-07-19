// The thin client Predict surface. The backend builds, signs, and submits every PTB (dev = operator key,
// privy = the user's embedded wallet via a session signer); games call placePlay/cashOut and never touch a moveCall directly.

import { SuiGrpcClient } from '@mysten/sui/grpc'

import { api, ApiError } from '../api'
import { DUSDC_TYPE, NETWORK, PACKAGE_ID, fromDusdcRaw } from './config'
import type { Game, PlayDTO } from '../api'
import { env } from '@/env'

export type PlayOutcome = { play: PlayDTO; unlocked: Array<string> }
export type WalletBalances = { sui: string; usdc: string | null }

const SUI_TYPE = '0x2::sui::SUI'
const SUI_DECIMALS = 9

// Per-network fullnode gRPC default when VITE_SUI_FULLNODE_URL is unset; grpc-web runs over fetch, so it's browser safe with no extra WASM.
const DEFAULT_FULLNODE: Record<string, string> = {
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  testnet: 'https://fullnode.testnet.sui.io:443',
}

// Lazy read-only gRPC client for the balance reads below only, never for a Predict moveCall. baseUrl is required, the shorthand ctor throws without it.
let client: SuiGrpcClient | null = null
function suiClient(): SuiGrpcClient {
  if (!client) {
    const baseUrl = env.VITE_SUI_FULLNODE_URL || DEFAULT_FULLNODE[NETWORK] || DEFAULT_FULLNODE.testnet
    client = new SuiGrpcClient({ network: NETWORK, baseUrl })
  }
  return client
}

// Detects a Sui Devnet wipe (deletes our published Predict package, breaking every chain call on the stale id) by asking the backend for its live package id
// and checking it still exists on chain, so the door can show a "redeploying" sheet. Best-effort and bounded: any hiccup resolves false, not a false positive.
export async function probeChainWiped(): Promise<boolean> {
  const probe = (async (): Promise<boolean> => {
    let packageId = PACKAGE_ID
    try {
      const res = await fetch(`${env.VITE_API_URL}/config`, { signal: AbortSignal.timeout(4000) })
      if (res.ok) {
        const body = (await res.json()) as { data?: { predictPackageId?: string } }
        if (body.data?.predictPackageId) packageId = body.data.predictPackageId
      }
    } catch {
      // backend unreachable: fall back to the compile-time package id
    }
    if (!packageId) return false
    // A live package reads cleanly; a reset chain throws "<id> not found" for the same id, the only signal that counts as a wipe.
    try {
      await suiClient().getObject({ objectId: packageId })
      return false
    } catch (e) {
      return (e instanceof Error ? e.message : String(e)).toLowerCase().includes('not found')
    }
  })()
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000))
  return Promise.race([probe.catch(() => false), timeout])
}

// Live on-chain DUSDC wallet balance in display units. user.balance from /auth/me (wallet + manager chips) is the
// authoritative spendable figure; this is a direct chain read for a quick post-settle refresh without a full /auth/me round trip.
export async function readDusdcBalance(address: string): Promise<number> {
  if (!DUSDC_TYPE) return 0
  const bal = await suiClient().getBalance({ owner: address, coinType: DUSDC_TYPE })
  return fromDusdcRaw(bal.balance.balance)
}

const formatRawBalance = (raw: string, decimals: number): string => {
  const value = BigInt(raw)
  const scale = 10n ** BigInt(decimals)
  const whole = value / scale
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

// Direct wallet balances for browser-console debugging; DUSDC here is only the coin balance owned by the address, not chips deposited in its PredictManager.
export async function readWalletBalances(address: string): Promise<WalletBalances> {
  const [sui, usdc] = await Promise.all([
    suiClient().getBalance({ owner: address, coinType: SUI_TYPE }),
    DUSDC_TYPE
      ? suiClient().getBalance({ owner: address, coinType: DUSDC_TYPE })
      : Promise.resolve(null),
  ])

  return {
    sui: formatRawBalance(sui.balance.balance, SUI_DECIMALS),
    usdc: usdc ? formatRawBalance(usdc.balance.balance, 6) : null,
  }
}

// The server rate-limits plays per user with a burst-tolerant token bucket (finite testnet gas, L-008). A
// burst past the bucket depth 429s RATE_LIMITED; instead of surfacing that, wait for a slot and re-fire so
// plays just queue (Range V2 stacks several at once). A rate-limited request never landed, so the retry is safe.
const RATE_LIMIT_RETRY_MS = 450
const RATE_LIMIT_MAX_WAIT_MS = 9000 // covers a couple of refill intervals, then lets the error surface

// Place a play; the backend signs + submits server-side in both modes, so this returns a finalized open PlayDTO.
export async function placePlay(game: Game, body: Record<string, unknown>): Promise<PlayOutcome> {
  const deadline = Date.now() + RATE_LIMIT_MAX_WAIT_MS
  for (;;) {
    try {
      const { play } = await api.play(game, body)
      return { play, unlocked: [] }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'RATE_LIMITED' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_MS))
        continue
      }
      throw e
    }
  }
}

// Cash out an open play at the live mark. Same finalized shape as placePlay.
export async function cashOut(playId: string): Promise<PlayOutcome> {
  const { play, unlocked } = await api.cashout(playId)
  return { play, unlocked }
}
