import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpFromLine, Check, ChevronDown } from 'lucide-react'
import toast from 'react-hot-toast'
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils'
import { MenuScreen, prepareMenuTransition } from '@/components/menu/shared'
import { CoinLogo } from '@/components/menu/deposit/CoinLogo'
import { Button } from '@/ui/Button'
import { ApiError, api } from '@/lib/api'
import type { WalletCoinDTO } from '@/lib/api'
import { walletCoinsQuery } from '@/lib/menuQueries'
import { useAuth } from '@/lib/auth'
import { haptic } from '@/lib/haptics'
import { HapticOverlay } from '@/components/HapticOverlay'
import { formatStringToNumericDecimals, serializeFormattedStringToFloat } from '@/utils/format'
import { cnm } from '@/utils/style'

// Send any held coin to a Sui address. DUSDC (the chips) is the default; every other coin is labelled
// "Recover" so an accidental deposit can be swept out. The backend signs for the user, so this is just a
// token pick + a validated amount + a recipient.
export const Route = createFileRoute('/_app/menu/withdraw')({ component: WithdrawScreen })

const coinLine = (c: WalletCoinDTO): string => {
  const usd = c.usdValue ? ` · ~$${c.usdValue}` : ''
  return `${c.amount} ${c.symbol}${usd}`
}

function WithdrawScreen() {
  const { user, refresh } = useAuth()
  const navigate = useNavigate()
  const coinsQ = useQuery(walletCoinsQuery())
  const coins = coinsQ.data?.coins ?? []

  // While coins load, stand in a DUSDC chip built from the balance headline so the screen is usable at once.
  const chipFallback: WalletCoinDTO = useMemo(
    () => ({
      coinType: '',
      symbol: 'DUSDC',
      name: 'DeepBook USDC',
      decimals: 2,
      logo: '/assets/icons/dusdc-logo.webp',
      amount: formatStringToNumericDecimals(user?.balance ?? '0', 2),
      amountRaw: '0',
      priceUsd: '1',
      usdValue: user?.balance ?? '0',
      isChip: true,
    }),
    [user?.balance],
  )

  const [selectedType, setSelectedType] = useState<string | null>(null)
  const selected =
    coins.find((c) => c.coinType === selectedType) ?? coins.find((c) => c.isChip) ?? coins[0] ?? chipFallback

  const [pickerOpen, setPickerOpen] = useState(false)
  const [amount, setAmount] = useState('')
  // Wallet-connect users withdraw to their own connected wallet by default; prefill it.
  const [recipient, setRecipient] = useState(user?.walletAuthAddress ?? '')
  const [submitting, setSubmitting] = useState(false)

  const held = serializeFormattedStringToFloat(selected.amount)
  const amountNum = serializeFormattedStringToFloat(amount)
  const recipientTrim = recipient.trim()
  const addrOk = /^0x[0-9a-fA-F]+$/.test(recipientTrim) && isValidSuiAddress(normalizeSuiAddress(recipientTrim))
  const amountOk = amountNum > 0 && amountNum <= held + 1e-9
  const canSubmit = addrOk && amountOk && !submitting

  const pick = (c: WalletCoinDTO) => {
    setSelectedType(c.coinType)
    setPickerOpen(false)
    setAmount('')
    haptic('selection')
  }
  const setMax = () => {
    setAmount(selected.amount)
    haptic('selection')
  }

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    haptic('medium')
    try {
      // DUSDC stays on the default (chips: wallet + wrapper) path; any other coin passes its type.
      await api.withdraw({
        recipient: normalizeSuiAddress(recipientTrim),
        amount,
        coinType: selected.isChip ? undefined : selected.coinType,
      })
      await refresh()
      haptic('success')
      toast.success(`Sent ${selected.symbol}`, { id: 'withdraw' })
      prepareMenuTransition('back')
      void navigate({ to: '/menu', viewTransition: true })
    } catch (e) {
      haptic('error')
      toast.error(e instanceof ApiError ? e.message : 'Could not send right now', { id: 'withdraw' })
      setSubmitting(false)
    }
  }

  return (
    <MenuScreen title="Send">
      <div className="flex flex-col gap-5">
        {/* Token selector: the selected coin, tap to switch. Non-chip coins are labelled "Recover". */}
        <div className="card-neo rounded-card p-2">
          <button
            onClick={() => {
              setPickerOpen((v) => !v)
              haptic('selection')
            }}
            className="flex w-full items-center gap-3 rounded-2xl p-3 text-left transition-transform active:scale-[0.99]"
          >
            <CoinLogo src={selected.logo} name={selected.symbol} size={38} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[16px] font-bold">{selected.symbol}</span>
                {!selected.isChip && <RecoverPill />}
              </div>
              <div className="mt-0.5 truncate text-[12px] text-text-3">{coinLine(selected)}</div>
            </div>
            <ChevronDown className={cnm('h-5 w-5 shrink-0 text-text-3 transition-transform', pickerOpen && 'rotate-180')} strokeWidth={2.4} />
          </button>

          {pickerOpen && (
            <div className="mt-1 flex flex-col gap-1 border-t border-white/[0.06] pt-1">
              {coins.length === 0 && (
                <div className="px-3 py-3 text-[13px] text-text-3">{coinsQ.isLoading ? 'Loading your coins…' : 'No coins to send.'}</div>
              )}
              {coins.map((c) => (
                <button
                  key={c.coinType}
                  onClick={() => pick(c)}
                  className="flex w-full items-center gap-3 rounded-2xl p-3 text-left transition-colors active:bg-white/[0.05]"
                >
                  <CoinLogo src={c.logo} name={c.symbol} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[15px] font-bold">{c.symbol}</span>
                      {!c.isChip && <RecoverPill />}
                    </div>
                    <div className="truncate text-[12px] text-text-3">{coinLine(c)}</div>
                  </div>
                  {c.coinType === selected.coinType && <Check className="h-[18px] w-[18px] shrink-0 text-up" strokeWidth={2.8} />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Amount */}
        <div className="card-neo rounded-card p-5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">Amount</span>
            <div className="relative inline-block">
              <button className="pointer-events-none rounded-full bg-white/[0.06] px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-brand-500 transition-transform active:scale-95">
                Max
              </button>
              <HapticOverlay className="absolute inset-0 rounded-full" preset="selection" silent onTap={setMax} />
            </div>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <input
              value={amount}
              onChange={(e) => setAmount(formatStringToNumericDecimals(e.target.value, selected.decimals))}
              inputMode="decimal"
              placeholder="0"
              className="tnum min-w-0 flex-1 bg-transparent text-[42px] font-black leading-none text-text outline-none placeholder:text-text-3"
            />
            <span className="shrink-0 text-2xl font-black text-text-3">{selected.symbol}</span>
          </div>
          <div className="mt-3 flex items-center gap-1.5 text-[13px] text-text-2">
            <span className="tnum">{selected.amount}</span>
            <span>{selected.symbol} available</span>
            {selected.usdValue && <span className="text-text-3">· ~${selected.usdValue}</span>}
          </div>
          {amount !== '' && amountNum > held + 1e-9 && (
            <div className="mt-1 text-[13px] font-semibold text-down">More than your balance</div>
          )}
        </div>

        {/* Recipient */}
        <div className="card-neo rounded-card p-5">
          <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">Send to</span>
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0x… Sui address"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="tnum mt-2 w-full break-all bg-transparent text-[15px] leading-snug text-text outline-none placeholder:text-text-3"
          />
          {recipientTrim !== '' && !addrOk && (
            <div className="mt-1 text-[13px] font-semibold text-down">That is not a valid Sui address</div>
          )}
        </div>

        <div className="relative h-14 w-full">
          <Button onClick={submit} disabled={!canSubmit} loading={submitting} className="pointer-events-none h-14 w-full rounded-card">
            <ArrowUpFromLine className="h-5 w-5" strokeWidth={2.6} />
            {amountOk ? `Send ${amount} ${selected.symbol}` : 'Send'}
          </Button>
          <HapticOverlay className="absolute inset-0 rounded-card" preset="medium" disabled={!canSubmit} silent onTap={() => void submit()} />
        </div>

        <p className="px-1 text-[13px] leading-snug text-text-3">
          {selected.isChip
            ? 'Sends DUSDC from your balance to any Sui address. '
            : `You are sending ${selected.symbol}, not your chips. `}
          Check the address carefully, transfers cannot be undone.
        </p>
      </div>
    </MenuScreen>
  )
}

function RecoverPill() {
  return (
    <span className="rounded-full bg-brand-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-500">
      Recover
    </span>
  )
}
