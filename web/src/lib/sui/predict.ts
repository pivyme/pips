// The thin client Predict surface. The backend builds and (dev) submits every PTB; this layer
// only drives the play flow and, in enoki mode, signs the sponsored envelope and confirms it.
// Games and screens call placePlay / cashOut and never touch a moveCall or an id directly.

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc'

import { env } from '@/env'
import { api, type CashoutResult, type Game, type PlayDTO, type PlayResult, type SponsorEnvelope } from '../api'
import { DUSDC_TYPE, NETWORK, fromDusdcRaw } from './config'

export type PlayOutcome = { play: PlayDTO; unlocked: string[] }

// Lazy read-only client. JSON-RPC (matches the backend, no WASM, browser safe). Only used for
// the live DUSDC balance read below, never for building a Predict moveCall.
let client: SuiJsonRpcClient | null = null
function suiClient(): SuiJsonRpcClient {
  if (!client) {
    const url = env.VITE_SUI_FULLNODE_URL || getJsonRpcFullnodeUrl(NETWORK as 'testnet' | 'mainnet' | 'devnet')
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

// Place a play. dev mode comes back already open; enoki mode returns an envelope we sign and
// confirm. Either way the caller gets a finalized PlayDTO.
export async function placePlay(game: Game, body: Record<string, unknown>): Promise<PlayOutcome> {
  const res: PlayResult = await api.play(game, body)
  if ('play' in res) return { play: res.play, unlocked: [] }
  return confirmEnvelope(res.envelope)
}

// Cash out an open play at the live mark. Same mode-aware shape as placePlay.
export async function cashOut(playId: string): Promise<PlayOutcome> {
  const res: CashoutResult = await api.cashout(playId)
  if ('play' in res) return { play: res.play, unlocked: res.unlocked }
  return confirmEnvelope(res.envelope)
}

// enoki: sign the sponsored bytes with the zkLogin keypair, then confirm with the backend.
async function confirmEnvelope(envelope: SponsorEnvelope): Promise<PlayOutcome> {
  const { enokiSignTransaction } = await import('./enoki')
  const signature = await enokiSignTransaction(envelope.txBytes)
  const res = await api.confirm(envelope.playId, signature)
  return { play: res.play, unlocked: res.unlocked }
}
