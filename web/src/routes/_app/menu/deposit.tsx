import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Coins } from 'lucide-react'
import toast from 'react-hot-toast'
import { MenuScreen } from '@/components/menu/shared'
import { AssetPicker } from '@/components/menu/deposit/AssetPicker'
import { ReceivePanel } from '@/components/menu/deposit/ReceivePanel'
import { BridgePanel } from '@/components/menu/deposit/BridgePanel'
import { Alert } from '@/ui/Alert'
import { useAuth } from '@/lib/auth'
import { api, ApiError } from '@/lib/api'
import type { DepositOptionsDTO } from '@/lib/api'
import { networkLabel, resolveMode, unsupportedCopy } from '@/lib/deposit/mode'
import { NETWORK_LABEL } from '@/lib/sui/config'
import { haptic } from '@/lib/haptics'

// One drawer, two dropdowns. Pick a currency and a network and the mode falls out: the chip asset on Sui
// is a plain address + QR (nothing to bridge), anything else previews a live LI.FI route. No mode switch
// the player has to understand, and no state they can get stuck in.
export const Route = createFileRoute('/_app/menu/deposit')({
  component: DepositScreen,
})

// Receive is the critical path and must survive /options being down, so the drawer falls back to a
// chip-only catalog rather than blanking the address the player came here for.
const FALLBACK_OPTIONS: DepositOptionsDTO = {
  chipSymbol: 'DUSDC',
  chipNetwork: 'sui',
  bridgeAsset: 'USDC',
  executeEnabled: false,
  executeLockedReason: 'mainnet_only',
  minUsd: 3,
  hardMinUsd: 1,
  faucetAmount: '',
  currencies: [{ symbol: 'DUSDC', logo: null, networks: ['sui'] }],
  networks: [{ key: 'sui', label: 'Sui', logo: null }],
}

function DepositScreen() {
  const { user, refresh } = useAuth()
  const address = user?.address ?? ''
  const [claiming, setClaiming] = useState(false)

  const { data } = useQuery({
    queryKey: ['deposit-options'],
    queryFn: () => api.depositOptions(),
    staleTime: 5 * 60_000,
  })
  const options = data ?? FALLBACK_OPTIONS

  const [currency, setCurrency] = useState(options.chipSymbol)
  const [network, setNetwork] = useState(options.chipNetwork)

  // Poll lightly while the screen is open so an incoming deposit shows up on its own.
  useEffect(() => {
    void refresh()
    const iv = window.setInterval(() => void refresh(), 8000)
    return () => window.clearInterval(iv)
  }, [refresh])

  const networksFor = (sym: string) => options.currencies.find((c) => c.symbol === sym)?.networks ?? []

  // Switching currency can strand the network on a pair that does not exist, so snap it to the first
  // network the new currency actually supports.
  const pickCurrency = (next: string) => {
    setCurrency(next)
    const nets = networksFor(next)
    if (!nets.includes(network)) setNetwork(nets[0] ?? 'sui')
  }

  const currencyOptions = useMemo(
    () =>
      options.currencies.map((c) => ({
        value: c.symbol,
        label: c.symbol,
        logo: c.logo,
        sub: c.symbol === options.chipSymbol ? 'Your chips' : c.networks.map(networkLabel).join(', '),
      })),
    [options],
  )
  const networkLogos = useMemo(
    () => new Map(options.networks.map((n) => [n.key, n.logo])),
    [options],
  )
  const networkOptions = useMemo(
    () => networksFor(currency).map((n) => ({ value: n, label: networkLabel(n), logo: networkLogos.get(n) ?? null })),
    [currency, options, networkLogos],
  )

  const mode = resolveMode(currency, network, options.chipSymbol)

  // Test faucet: free play money so anyone can jump in without a real deposit. The backend enforces the
  // per-tap cooldown; we just surface its message.
  const claim = async () => {
    if (claiming || !user) return
    setClaiming(true)
    try {
      const res = await api.requestDusdc()
      await refresh()
      haptic('success')
      toast.success(`Received ${Number(res.amount)} test ${options.chipSymbol}`, { id: 'faucet' })
    } catch (e) {
      haptic('error')
      toast.error(e instanceof ApiError ? e.message : `Could not get test ${options.chipSymbol}`, { id: 'faucet' })
    } finally {
      setClaiming(false)
    }
  }

  return (
    <MenuScreen title="Add funds">
      <div className="flex flex-col gap-5">
        <div className="flex items-start gap-3">
          <AssetPicker label="Currency" value={currency} options={currencyOptions} onChange={pickCurrency} />
          <AssetPicker label="Network" value={network} options={networkOptions} onChange={setNetwork} />
        </div>

        {mode === 'receive' && (
          <ReceivePanel address={address} chipSymbol={options.chipSymbol} minUsd={options.minUsd} />
        )}

        {mode === 'bridge' && <BridgePanel options={options} currency={currency} network={network} />}

        {/* Never a dead end: a labelled state with the reason and the way out. Soft urgency, it is a
            nudge to pick another pair, not a fund-loss warning. */}
        {mode === 'unsupported' && <Alert tone="alert">{unsupportedCopy(options.chipSymbol)}</Alert>}

        {/* The faucet is the fastest way to chips today, so it stays on the screen in every mode. */}
        {options.faucetAmount && (
          <>
            <div className="flex items-center gap-3 px-1 pt-1">
              <span className="h-px flex-1 bg-white/[0.08]" />
              <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">or</span>
              <span className="h-px flex-1 bg-white/[0.08]" />
            </div>

            <button
              onClick={claim}
              disabled={claiming || !user}
              className="btn-primary flex h-12 items-center justify-center gap-2 rounded-card text-[15px] font-semibold disabled:opacity-60"
            >
              <Coins className="h-[18px] w-[18px]" strokeWidth={2.4} />
              {claiming ? 'Sending…' : `Get ${Number(options.faucetAmount)} test ${options.chipSymbol}`}
            </button>
            <p className="px-1 text-[13px] leading-snug text-text-3">
              Instant test {options.chipSymbol} on {NETWORK_LABEL}. One batch per minute.
            </p>
          </>
        )}
      </div>
    </MenuScreen>
  )
}
