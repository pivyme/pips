import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { ArrowUpFromLine } from 'lucide-react'
import toast from 'react-hot-toast'
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils'
import { MenuScreen, prepareMenuTransition } from '@/components/menu/shared'
import { Button } from '@/ui/Button'
import { ApiError, api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { haptic } from '@/lib/haptics'
import {
  formatStringToNumericDecimals,
  serializeFormattedStringToFloat,
} from '@/utils/format'

// Send USDC to any Pips-network Sui address. The backend pulls from the wallet + manager chips and
// signs for the user, so this is just a validated amount + recipient and a confirm.
export const Route = createFileRoute('/_app/menu/withdraw')({
  component: WithdrawScreen,
})

function WithdrawScreen() {
  const { user, refresh } = useAuth()
  const navigate = useNavigate()

  const available = serializeFormattedStringToFloat(user?.balance ?? '0')
  const [amount, setAmount] = useState('')
  // Wallet-connect users withdraw to their own connected wallet by default; prefill it.
  const [recipient, setRecipient] = useState(user?.walletAuthAddress ?? '')
  const [submitting, setSubmitting] = useState(false)

  const amountNum = serializeFormattedStringToFloat(amount)
  const recipientTrim = recipient.trim()
  const addrOk =
    /^0x[0-9a-fA-F]+$/.test(recipientTrim) &&
    isValidSuiAddress(normalizeSuiAddress(recipientTrim))
  const amountOk = amountNum > 0 && amountNum <= available + 0.005 // tolerate a Max that rounds a hair high
  const canSubmit = addrOk && amountOk && !submitting

  const setMax = () => {
    setAmount(formatStringToNumericDecimals(String(available), 6))
    haptic('selection')
  }

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    haptic('medium')
    try {
      await api.withdraw({
        recipient: normalizeSuiAddress(recipientTrim),
        amount: String(amountNum),
      })
      await refresh()
      haptic('success')
      toast.success('Withdrawal sent', { id: 'withdraw' })
      prepareMenuTransition('back')
      void navigate({ to: '/menu', viewTransition: true })
    } catch (e) {
      haptic('error')
      toast.error(e instanceof ApiError ? e.message : 'Could not withdraw right now', {
        id: 'withdraw',
      })
      setSubmitting(false)
    }
  }

  return (
    <MenuScreen title="Withdraw">
      <div className="flex flex-col gap-5">
        {/* Amount */}
        <div className="card-neo rounded-card p-5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">
              Amount
            </span>
            <button
              onClick={setMax}
              className="rounded-full bg-white/[0.06] px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-brand-500 transition-transform active:scale-95"
            >
              Max
            </button>
          </div>
          <div className="mt-2 flex items-baseline gap-1">
            <span className="text-2xl font-black text-text-3">$</span>
            <input
              value={amount}
              onChange={(e) =>
                setAmount(formatStringToNumericDecimals(e.target.value, 6))
              }
              inputMode="decimal"
              placeholder="0"
              className="tnum w-full min-w-0 bg-transparent text-[42px] font-black leading-none text-text outline-none placeholder:text-text-3"
            />
          </div>
          <div className="mt-3 text-[13px] text-text-2">
            <span className="tnum">
              {formatStringToNumericDecimals(user?.balance ?? '0', 2)}
            </span>{' '}
            USDC available
          </div>
          {amount !== '' && amountNum > available + 0.005 && (
            <div className="mt-1 text-[13px] font-semibold text-down">
              More than your balance
            </div>
          )}
        </div>

        {/* Recipient */}
        <div className="card-neo rounded-card p-5">
          <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">
            Send to
          </span>
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
            <div className="mt-1 text-[13px] font-semibold text-down">
              That is not a valid Sui address
            </div>
          )}
        </div>

        <Button
          onClick={submit}
          disabled={!canSubmit}
          loading={submitting}
          className="h-14 w-full rounded-card"
        >
          <ArrowUpFromLine className="h-5 w-5" strokeWidth={2.6} />
          {amountOk
            ? `Withdraw $${formatStringToNumericDecimals(String(amountNum), 2)}`
            : 'Withdraw'}
        </Button>

        <p className="px-1 text-[13px] leading-snug text-text-3">
          Sends USDC from your balance to any Pips-network Sui address. Check
          the address carefully, transfers cannot be undone.
        </p>
      </div>
    </MenuScreen>
  )
}
