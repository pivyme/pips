// The one client-side LI.FI seam: turn a server-stamped executable quote into a signed, broadcast source
// transaction. Mirrors the backend's lib/lifi.ts rule, routes never call the SDK directly.
//
// Every LI.FI/viem import is DYNAMIC, loaded only when a deposit is actually confirmed. So this heavy stack
// (the SDK + viem + Solana kit) never touches the testnet/demo bundle at runtime, it is mainnet-only code
// behind the server's executeEnabled gate.
//
// The route is fetched fresh server-side with toAddress already stamped (see /deposit/execute-quote), and
// passed here whole, so the SDK signs the provided transactionRequest without a re-quote and we never let
// the destination address come from client state.

import type { DepositExecuteQuoteDTO } from '@/lib/api'

// What the drawer shows while a bridge is in flight. Driven live from the SDK's route hook, not guessed.
export type BridgePhase = 'preparing' | 'signing' | 'bridging' | 'done' | 'failed'
export interface BridgeProgress {
  phase: BridgePhase
  message: string
  sourceTxHash?: string
}

// A connected EVM wallet, as Privy's useWallets() exposes it. We only need the EIP-1193 provider + chain
// switch, so we take the narrow shape instead of importing Privy's type into this SDK seam.
export interface EvmSigner {
  address: string
  getEthereumProvider: () => Promise<unknown>
  switchChain: (id: `0x${string}` | number) => Promise<void>
}

// A connected Solana wallet (Privy's ConnectedStandardSolanaWallet exposes .standardWallet, the raw
// wallet-standard adapter the SDK's SolanaProvider wants).
export interface SolSigner {
  address: string
  standardWallet: unknown
}

export interface ExecuteBridgeOptions {
  quote: DepositExecuteQuoteDTO
  evm?: EvmSigner
  sol?: SolSigner
  // Fires exactly once, the moment the source tx is broadcast, so the caller can POST /deposit/track and
  // correlate the row before the bridge even completes.
  onSourceTx: (txHash: string) => void
  onProgress?: (p: BridgeProgress) => void
}

// viem ships a chain object per network; map the source chain id to it. Solana has none (it is not EVM),
// so this only covers the EVM sources in the catalog.
async function viemChainFor(chainId: number) {
  const chains = await import('viem/chains')
  const byId: Record<number, unknown> = {
    1: chains.mainnet,
    8453: chains.base,
    42161: chains.arbitrum,
  }
  return byId[chainId]
}

// Sign + broadcast the source tx and follow the route to completion. Resolves when the route is DONE,
// rejects if it fails or is rejected in the wallet. Progress is reported live via onProgress.
export async function executeBridge(opts: ExecuteBridgeOptions): Promise<void> {
  const { quote, evm, sol, onSourceTx, onProgress } = opts
  onProgress?.({ phase: 'preparing', message: 'Preparing your deposit…' })

  const [{ createClient, convertQuoteToRoute, executeRoute }, viem] = await Promise.all([
    import('@lifi/sdk'),
    import('viem'),
  ])

  const providers: unknown[] = []

  if (evm) {
    const chain = await viemChainFor(quote.fromChainId)
    // Rebuild the WalletClient after any chain switch, an old instance keeps the old chain (Privy caveat).
    const makeWallet = async () => {
      const provider = await evm.getEthereumProvider()
      return viem.createWalletClient({
        account: evm.address as `0x${string}`,
        transport: viem.custom(provider as never),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        chain: chain as any,
      })
    }
    const { EthereumProvider } = await import('@lifi/sdk-provider-ethereum')
    providers.push(
      EthereumProvider({
        getWalletClient: async () => makeWallet(),
        switchChain: async (id: number) => {
          await evm.switchChain(id)
          return makeWallet()
        },
      }),
    )
  }

  if (sol) {
    const { SolanaProvider } = await import('@lifi/sdk-provider-solana')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    providers.push(SolanaProvider({ getWallet: async () => sol.standardWallet as any }))
  }

  if (providers.length === 0) throw new Error('Connect a wallet first')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = createClient({ integrator: 'pips', providers: providers as any })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const route = convertQuoteToRoute(quote.step as any)

  let reported = false
  let failure: string | null = null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await executeRoute(client, route, {
    updateRouteHook: (updated: any) => {
      for (const step of updated.steps ?? []) {
        const actions = step.execution?.actions ?? []
        for (const action of actions) {
          if (action.status === 'ACTION_REQUIRED') {
            onProgress?.({ phase: 'signing', message: 'Confirm the transaction in your wallet…' })
          }
          if (action.txHash && !reported) {
            reported = true
            onSourceTx(action.txHash)
            onProgress?.({ phase: 'bridging', message: 'Bridging to Sui…', sourceTxHash: action.txHash })
          }
          if (action.status === 'FAILED') {
            failure = action.error?.message ?? 'The transaction failed.'
          }
        }
        if (step.execution?.status === 'DONE') {
          onProgress?.({ phase: 'done', message: 'Deposited.' })
        }
      }
    },
  })

  if (failure) {
    onProgress?.({ phase: 'failed', message: failure })
    throw new Error(failure)
  }
  onProgress?.({ phase: 'done', message: 'Deposited.' })
}
