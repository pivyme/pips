// The thin client Predict surface. The backend builds, signs (dev = operator, privy = the user's
// embedded wallet via a session signer), and submits every PTB, so this layer just drives the play
// flow. Games and screens call placePlay / cashOut and never touch a moveCall or an id directly.

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc'

import { env } from '@/env'
import { api, type Game, type PlayDTO } from '../api'
import { DUSDC_TYPE, NETWORK, fromDusdcRaw } from './config'

export type PlayOutcome = { play: PlayDTO; unlocked: string[] }

// Lazy read-only client. JSON-RPC (matches the backend, no WASM, browser safe). Only used for
// the live DUSDC balance read below, never for building a Predict moveCall.
let client: SuiJsonRpcClient | null = null
function suiClient(): SuiJsonRpcClient {
  if (!client) {
    const url = env.VITE_SUI_FULLNODE_URL || getJsonRpcFullnodeUrl(NETWORK as 'testnet' | 'mainnet' | 'devnet' | 'localnet')
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
