// Standalone localnet debug wallet, not part of the product path (no auth/backend/Predict wrapper); talks straight
// to a configurable Sui node over grpc-web. Key lives in localStorage in the clear, throwaway dev keys only, never mainnet. Powers /tools/wallet.

import { decodeSuiPrivateKey } from '@mysten/sui/cryptography'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction, coinWithBalance } from '@mysten/sui/transactions'
import { isValidSuiAddress } from '@mysten/sui/utils'

import { env } from '@/env'

export const SUI_TYPE = '0x2::sui::SUI'
export const SUI_DECIMALS = 9

const RPC_KEY = 'pips_devwallet_rpc'
const PK_KEY = 'pips_devwallet_pk'
const FAUCET_KEY = 'pips_devwallet_faucet'

const ls = (): Storage | null => (typeof window === 'undefined' ? null : window.localStorage)

// The RPC the app is built against, editable in the UI so you can point at any custom node without rebuilding.
export const defaultRpcUrl = (): string => env.VITE_SUI_FULLNODE_URL || 'http://127.0.0.1:9000'

export function loadRpcUrl(): string {
  return ls()?.getItem(RPC_KEY) || defaultRpcUrl()
}
export function saveRpcUrl(url: string): void {
  ls()?.setItem(RPC_KEY, url.trim())
}

// Localnet faucet (sui start --with-faucet) is :9123 alongside the :9000 RPC; editable since a remote node may expose it elsewhere or not at all.
export function defaultFaucetUrl(): string {
  const rpc = loadRpcUrl()
  try {
    const u = new URL(rpc)
    u.port = '9123'
    u.pathname = ''
    return u.origin
  } catch {
    return 'http://127.0.0.1:9123'
  }
}
export function loadFaucetUrl(): string {
  return ls()?.getItem(FAUCET_KEY) || defaultFaucetUrl()
}
export function saveFaucetUrl(url: string): void {
  ls()?.setItem(FAUCET_KEY, url.trim())
}

// baseUrl is required, the `new SuiGrpcClient({ network })` shorthand throws `base.endsWith`; pass the editable node url straight through.
export function makeClient(url: string): SuiGrpcClient {
  return new SuiGrpcClient({ network: env.VITE_SUI_NETWORK, baseUrl: url })
}

// --- keypair (one throwaway key, persisted) ---

export function loadPrivKey(): string | null {
  return ls()?.getItem(PK_KEY) || null
}
export function savePrivKey(pk: string): void {
  ls()?.setItem(PK_KEY, pk.trim())
}
export function clearPrivKey(): void {
  ls()?.removeItem(PK_KEY)
}

export function keypairFromPk(pk: string): Ed25519Keypair {
  const { secretKey } = decodeSuiPrivateKey(pk.trim())
  return Ed25519Keypair.fromSecretKey(secretKey)
}
export function addressFromPk(pk: string): string {
  return keypairFromPk(pk).getPublicKey().toSuiAddress()
}
// Fresh key, returned as a suiprivkey1... string ready to paste back in or fund.
export function generatePrivKey(): string {
  return Ed25519Keypair.generate().getSecretKey()
}

export const isAddress = (a: string): boolean => isValidSuiAddress(a.trim())

// --- reads ---

export type NetInfo = { chainId: string; gasPrice: string }
export async function probe(client: SuiGrpcClient): Promise<NetInfo> {
  const [chainId, gas] = await Promise.all([client.core.getChainIdentifier(), client.getReferenceGasPrice()])
  return { chainId: chainId.chainIdentifier, gasPrice: gas.referenceGasPrice }
}

export type CoinRow = { coinType: string; symbol: string; decimals: number; raw: bigint }

const metaCache = new Map<string, { symbol: string; decimals: number }>()
async function coinMeta(client: SuiGrpcClient, coinType: string): Promise<{ symbol: string; decimals: number }> {
  if (coinType === SUI_TYPE) return { symbol: 'SUI', decimals: SUI_DECIMALS }
  const hit = metaCache.get(coinType)
  if (hit) return hit
  // Fall back to the bare struct name + raw units if a coin has no published metadata.
  let m = { symbol: coinType.split('::').pop() || 'COIN', decimals: 0 }
  try {
    const { coinMetadata } = await client.getCoinMetadata({ coinType })
    if (coinMetadata) m = { symbol: coinMetadata.symbol, decimals: coinMetadata.decimals }
  } catch {
    // leave the fallback
  }
  metaCache.set(coinType, m)
  return m
}

export async function fetchBalances(client: SuiGrpcClient, address: string): Promise<CoinRow[]> {
  // listBalances is paginated; walk every page so a wallet holding many coin types shows all of them (getAllBalances used to return everything in one call).
  const balances: Array<{ coinType: string; balance: string }> = []
  let cursor: string | null = null
  do {
    const page = await client.listBalances({ owner: address, cursor })
    balances.push(...page.balances)
    cursor = page.hasNextPage ? page.cursor : null
  } while (cursor)
  const rows = await Promise.all(
    balances.map(async (b) => {
      const meta = await coinMeta(client, b.coinType)
      return { coinType: b.coinType, symbol: meta.symbol, decimals: meta.decimals, raw: BigInt(b.balance) }
    }),
  )
  // SUI first, then alphabetical by symbol. Stable, predictable list.
  return rows.sort((a, b) => {
    if (a.coinType === SUI_TYPE) return -1
    if (b.coinType === SUI_TYPE) return 1
    return a.symbol.localeCompare(b.symbol)
  })
}

// --- writes ---

export async function sendCoin(opts: {
  client: SuiGrpcClient
  pk: string
  coinType: string
  recipient: string
  amountRaw: bigint
}): Promise<string> {
  const kp = keypairFromPk(opts.pk)
  const tx = new Transaction()
  tx.setSender(kp.getPublicKey().toSuiAddress())
  // coinWithBalance splits SUI from gas and merges/splits any other coin from the sender's set.
  tx.transferObjects([coinWithBalance({ type: opts.coinType, balance: opts.amountRaw })], opts.recipient)
  const res = await opts.client.signAndExecuteTransaction({
    transaction: tx,
    signer: kp,
    include: { effects: true },
  })
  const t = res.$kind === 'Transaction' ? res.Transaction : null
  if (!t || t.effects?.status?.success !== true) {
    const status = t?.status ?? (res.$kind === 'FailedTransaction' ? res.FailedTransaction.status : null)
    throw new Error(status?.error?.message || 'Transaction failed')
  }
  return t.digest
}

export async function requestFaucet(host: string, recipient: string): Promise<void> {
  const { requestSuiFromFaucetV2 } = await import('@mysten/sui/faucet')
  await requestSuiFromFaucetV2({ host: host.trim().replace(/\/$/, ''), recipient })
}

// --- amount formatting ---

// Raw on-chain integer -> display string, trailing zeros trimmed.
export function formatRaw(raw: bigint | string, decimals: number): string {
  const v = BigInt(raw)
  if (decimals === 0) return v.toString()
  const base = 10n ** BigInt(decimals)
  const whole = v / base
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

// Display string -> raw integer at `decimals` precision. Throws on junk or excess precision.
export function parseToRaw(amount: string, decimals: number): bigint {
  const s = amount.trim()
  if (s === '' || s === '.' || !/^\d*\.?\d*$/.test(s)) throw new Error('Enter a valid amount')
  const [whole, frac = ''] = s.split('.')
  if (frac.length > decimals) throw new Error(`Max ${decimals} decimal places for this coin`)
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')
}
