// The thin client Predict surface. The backend builds, signs (dev = operator, privy = the user's
// embedded wallet via a session signer), and submits every PTB, so this layer just drives the play
// flow. Games and screens call placePlay / cashOut and never touch a moveCall or an id directly.

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc'

import { api } from '../api'
import { DUSDC_TYPE, NETWORK, fromDusdcRaw } from './config'
import type { Game, PlayDTO } from '../api'
import { env } from '@/env'

export type PlayOutcome = { play: PlayDTO; unlocked: Array<string> }
export type WalletBalances = { sui: string; usdc: string | null }

const SUI_TYPE = '0x2::sui::SUI'
const SUI_DECIMALS = 9

// Lazy read-only client. JSON-RPC (matches the backend, no WASM, browser safe). Only used for
// the live DUSDC balance read below, never for building a Predict moveCall.
let client: SuiJsonRpcClient | null = null
function suiClient(): SuiJsonRpcClient {
  if (!client) {
    const url = env.VITE_SUI_FULLNODE_URL || getJsonRpcFullnodeUrl(NETWORK)
    client = new SuiJsonRpcClient({ url, network: NETWORK })
  }
  return client
}

// Live on-chain DUSDC wallet balance in display units. The authoritative spendable figure is
// user.balance from /auth/me (wallet + manager chips); this is the direct chain read the spec
// calls for, useful for a quick post-settle refresh without a full /auth/me round trip.
export async function readDusdcBalance(address: string): Promise<number> {
  if (!DUSDC_TYPE) return 0
  const bal = await suiClient().getBalance({ owner: address, coinType: DUSDC_TYPE })
  return fromDusdcRaw(bal.totalBalance)
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
    sui: formatRawBalance(sui.totalBalance, SUI_DECIMALS),
    usdc: usdc ? formatRawBalance(usdc.totalBalance, 6) : null,
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
