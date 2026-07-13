import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { ArrowUpFromLine } from 'lucide-react'
import toast from 'react-hot-toast'
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils'
import { DusdcMark, MenuScreen, prepareMenuTransition } from '@/components/menu/shared'
import { Button } from '@/ui/Button'
import { ApiError, api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { haptic } from '@/lib/haptics'
import { HapticOverlay } from '@/components/HapticOverlay'
import {
  formatStringToNumericDecimals,
  serializeFormattedStringToFloat,
} from '@/utils/format'

// Send DUSDC to any PIPS-network Sui address. The backend pulls from the wallet + manager chips and
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
  const amountOk = amountNum > 0 && amountNum <= available
  const canSubmit = addrOk && amountOk && !submitting

  const setMax = () => {
    setAmount(formatStringToNumericDecimals(user?.balance ?? '0', 2))
    haptic('selection')
  }

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    haptic('medium')
    try {
      await api.withdraw({
        recipient: normalizeSuiAddress(recipientTrim),
        amount,
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
            <div className="relative inline-block">
              <button
                onClick={setMax}
                className="pointer-events-none rounded-full bg-white/[0.06] px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-brand-500 transition-transform active:scale-95"
              >
                Max
              </button>
              <HapticOverlay className="absolute inset-0 rounded-full" preset="selection" silent onTap={setMax} />
            </div>
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
          <div className="mt-3 flex items-center gap-1.5 text-[13px] text-text-2">
            <span className="tnum">
              {formatStringToNumericDecimals(user?.balance ?? '0', 2)}
            </span>
            <DusdcMark size={14} /> available
          </div>
          {amount !== '' && amountNum > available && (
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

        <div className="relative h-14 w-full">
          <Button
            onClick={submit}
            disabled={!canSubmit}
            loading={submitting}
            className="pointer-events-none h-14 w-full rounded-card"
          >
            <ArrowUpFromLine className="h-5 w-5" strokeWidth={2.6} />
            {amountOk
              ? `Withdraw $${formatStringToNumericDecimals(String(amountNum), 2)}`
              : 'Withdraw'}
          </Button>
          <HapticOverlay
            className="absolute inset-0 rounded-card"
            preset="medium"
            disabled={!canSubmit}
            silent
            onTap={() => void submit()}
          />
        </div>

        <p className="px-1 text-[13px] leading-snug text-text-3">
          Sends DUSDC from your balance to any PIPS-network Sui address. Check
          the address carefully, transfers cannot be undone.
        </p>
      </div>
    </MenuScreen>
  )
}
