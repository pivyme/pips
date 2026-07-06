// The thin client Predict surface. The backend builds, signs (dev = operator, privy = the user's
// embedded wallet via a session signer), and submits every PTB, so this layer just drives the play
// flow. Games and screens call placePlay / cashOut and never touch a moveCall or an id directly.

import { SuiGrpcClient } from '@mysten/sui/grpc'

import { api } from '../api'
import { DUSDC_TYPE, NETWORK, PACKAGE_ID, fromDusdcRaw } from './config'
import type { Game, PlayDTO } from '../api'
import { env } from '@/env'

export type PlayOutcome = { play: PlayDTO; unlocked: Array<string> }
export type WalletBalances = { sui: string; usdc: string | null }

const SUI_TYPE = '0x2::sui::SUI'
const SUI_DECIMALS = 9

// Per-network fullnode gRPC default when VITE_SUI_FULLNODE_URL is unset. grpc-web runs over fetch
// (no extra WASM beyond the crypto stack the app already loads), so it is browser safe.
const DEFAULT_FULLNODE: Record<string, string> = {
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  testnet: 'https://fullnode.testnet.sui.io:443',
  devnet: 'https://fullnode.devnet.sui.io:443',
  localnet: 'http://127.0.0.1:9000',
}

// Lazy read-only client. gRPC (matches the backend). Only used for the live balance reads below,
// never for building a Predict moveCall. baseUrl is required (the shorthand ctor throws).
let client: SuiGrpcClient | null = null
function suiClient(): SuiGrpcClient {
  if (!client) {
    const baseUrl = env.VITE_SUI_FULLNODE_URL || DEFAULT_FULLNODE[NETWORK] || DEFAULT_FULLNODE.devnet
    client = new SuiGrpcClient({ network: NETWORK, baseUrl })
  }
  return client
}

// Has Sui Devnet been reset out from under our deployment? Devnet (not testnet) wipes roughly weekly,
// which deletes the Predict package we published, so every chain call against the stale id fails. We
// detect it definitively from the browser: ask the backend for the LIVE package id (/config is fresh
// even after a self-heal redeploy, so a healthy redeploy reads as alive), then check whether that
// package still exists on chain. Used by the door to turn a sign-in failure into the friendly
// "redeploying, play demo" sheet without depending on the deployed backend's error code.
//
// Best-effort and bounded: any hiccup (backend down, RPC slow, no ids configured) resolves false so
// we fall back to the generic error sheet, never a false "redeploying".
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
    // A live package reads cleanly; a reset chain throws "<id> not found" for the same id. Only that
    // exact not-found signal reads as a wipe, so an unrelated hiccup never becomes a false "redeploying".
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

// Live on-chain DUSDC wallet balance in display units. The authoritative spendable figure is
// user.balance from /auth/me (wallet + manager chips); this is the direct chain read the spec
// calls for, useful for a quick post-settle refresh without a full /auth/me round trip.
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

// Direct wallet balances for browser-console debugging. DUSDC here is only the coin balance
// owned by the address, not chips currently deposited in its PredictManager.
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

// Place a play. The backend signs + submits server-side in both modes, so this comes back as a
// finalized open PlayDTO.
export async function placePlay(game: Game, body: Record<string, unknown>): Promise<PlayOutcome> {
  const { play } = await api.play(game, body)
  return { play, unlocked: [] }
}

// Cash out an open play at the live mark. Same finalized shape as placePlay.
export async function cashOut(playId: string): Promise<PlayOutcome> {
  const { play, unlocked } = await api.cashout(playId)
  return { play, unlocked }
}
