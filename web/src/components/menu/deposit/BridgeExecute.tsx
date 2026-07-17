import { useMemo, useState } from 'react'
import { useConnectWallet, useWallets } from '@privy-io/react-auth'
import { useWallets as useSolanaWallets } from '@privy-io/react-auth/solana'
import { Check, Loader2, Wallet } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import type { DepositOptionsDTO } from '@/lib/api'
import { executeBridge } from '@/lib/deposit/lifi'
import type { BridgeProgress } from '@/lib/deposit/lifi'
import { useAuth } from '@/lib/auth'
import { haptic } from '@/lib/haptics'

const shortenAddress = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

// The mainnet-only execution surface: connect MetaMask/Phantom, then sign the server-stamped route. Mounted
// ONLY when the server says executeEnabled AND Privy is present (see BridgePanel), so its Privy hooks never
// run in demo/dev where there is no provider.
//
// Solana sources sign with a Phantom wallet, everything else with an injected EVM wallet. The source VM is
// fixed by the chosen network, so there is never an ambiguous "which wallet" moment.

type Vm = 'EVM' | 'SVM'

export function BridgeExecute({
  options,
  currency,
  network,
  amount,
  amountValid,
}: {
  options: DepositOptionsDTO
  currency: string
  network: string
  amount: string
  amountValid: boolean
}) {
  const { refresh } = useAuth()
  const vm: Vm = network === 'solana' ? 'SVM' : 'EVM'

  const { wallets: evmWallets } = useWallets()
  const { wallets: solWallets } = useSolanaWallets()
  const evm = evmWallets[0]
  const sol = solWallets[0]
  const connectedAddress = vm === 'EVM' ? evm?.address : sol?.address

  const [progress, setProgress] = useState<BridgeProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = progress != null && progress.phase !== 'done' && progress.phase !== 'failed'

  const { connectWallet } = useConnectWallet({
    onError: (e) => setError(e === 'exited_auth_flow' ? null : 'Could not connect that wallet.'),
  })

  const connect = () => {
    haptic('selection')
    setError(null)
    connectWallet({ walletChainType: vm === 'EVM' ? 'ethereum-only' : 'solana-only' })
  }

  const confirm = async () => {
    if (busy || !connectedAddress) return
    setError(null)
    setProgress({ phase: 'preparing', message: 'Preparing your deposit…' })
    haptic('success')
    try {
      // Fresh, signable route with the connected source address; toAddress is stamped server-side.
      const quote = await api.depositExecuteQuote({ currency, network, amount, fromAddress: connectedAddress })
      await executeBridge({
        quote,
        evm:
          vm === 'EVM' && evm
            ? { address: evm.address, getEthereumProvider: () => evm.getEthereumProvider(), switchChain: evm.switchChain }
            : undefined,
        sol: vm === 'SVM' && sol ? { address: sol.address, standardWallet: sol.standardWallet } : undefined,
        // Correlate the tracking row the instant the source tx broadcasts, before the bridge finishes.
        onSourceTx: (txHash) => {
          void api.depositTrack(quote.depositId, txHash).catch(() => {})
        },
        onProgress: setProgress,
      })
      haptic('success')
      // Balance live-reads the chain, so a refresh is all it takes once the coins land.
      void refresh()
    } catch (e) {
      haptic('error')
      const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'The deposit failed.'
      setProgress(null)
      setError(msg)
    }
  }

  const landed = progress?.phase === 'done'

  const cta = useMemo(() => {
    if (!connectedAddress) return { label: 'Connect wallet', onClick: connect, disabled: false }
    if (landed) return { label: 'Deposited', onClick: () => {}, disabled: true }
    return { label: busy ? progress?.message ?? 'Working…' : 'Confirm deposit', onClick: confirm, disabled: busy || !amountValid }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedAddress, landed, busy, amountValid, progress])

  return (
    <div className="flex flex-col gap-3">
      {connectedAddress && !landed && (
        <div className="flex items-center justify-between px-1 text-[12px]">
          <span className="flex items-center gap-1.5 text-text-3">
            <Wallet className="h-4 w-4" strokeWidth={2.4} /> {vm === 'EVM' ? 'EVM' : 'Solana'} wallet
          </span>
          <span className="tnum font-semibold text-text-2">{shortenAddress(connectedAddress)}</span>
        </div>
      )}

      <button
        onClick={() => {
          haptic('selection')
          cta.onClick()
        }}
        disabled={cta.disabled}
        className="btn-primary flex h-14 w-full items-center justify-center gap-2 rounded-card text-[15px] font-bold disabled:opacity-60"
      >
        {busy ? (
          <Loader2 className="h-[18px] w-[18px] animate-spin" strokeWidth={2.6} />
        ) : landed ? (
          <Check className="h-[18px] w-[18px]" strokeWidth={2.8} />
        ) : (
          <Wallet className="h-[18px] w-[18px]" strokeWidth={2.6} />
        )}
        {cta.label}
      </button>

      {progress?.sourceTxHash && !landed && (
        <p className="tnum px-1 text-[12px] leading-snug text-text-3">Source tx {shortenAddress(progress.sourceTxHash)} sent, bridging…</p>
      )}
      {landed && (
        <p className="px-1 text-[13px] leading-snug text-up">
          Your {options.bridgeAsset} landed. Your balance updates in a moment.
        </p>
      )}
      {error && <p className="px-1 text-[13px] leading-snug text-down">{error}</p>}
    </div>
  )
}
