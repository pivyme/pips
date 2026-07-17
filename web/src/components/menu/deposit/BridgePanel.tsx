import { useEffect, useRef, useState } from 'react'
import { Info, Lock, TriangleAlert } from 'lucide-react'
import { ApiError, api } from '@/lib/api'
import type { DepositOptionsDTO, DepositQuoteDTO } from '@/lib/api'
import { formatDuration } from '@/lib/deposit/mode'
import { PRIVY_ENABLED } from '@/lib/privy'
import { BridgeExecute } from './BridgeExecute'
import { haptic } from '@/lib/haptics'
import { formatStringToNumericDecimals } from '@/utils/format'

// Bridge mode. The whole panel is live: the amount input re-quotes as you type and every rendered number
// (output, fee, ETA, route) is a real LI.FI mainnet quote fetched at that moment. Nothing here is mocked.
//
// Only the final CTA is gated, and it is gated server-side (options.executeEnabled). A locked panel that
// shows nothing teaches the player nothing; a locked BUTTON over real numbers is honest and demos well.

const DEBOUNCE_MS = 400

export function BridgePanel({
  options,
  currency,
  network,
}: {
  options: DepositOptionsDTO
  currency: string
  network: string
}) {
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState<DepositQuoteDTO | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)
  const inflight = useRef<AbortController | null>(null)

  const amountNum = Number(amount) || 0
  const belowMin = amountNum > 0 && amountNum < options.minUsd

  // Quotes go stale, so re-quote on every input change, debounced, and abort the in-flight request so a
  // slow earlier response can never overwrite a newer one.
  useEffect(() => {
    inflight.current?.abort()
    setError(null)
    if (amountNum <= 0) {
      setQuote(null)
      setLoading(false)
      return
    }
    setLoading(true)
    const ctl = new AbortController()
    inflight.current = ctl
    const t = window.setTimeout(async () => {
      try {
        const res = await api.depositQuote({ currency, network, amount }, ctl.signal)
        if (ctl.signal.aborted) return
        setQuote(res.quote)
      } catch (e) {
        if (ctl.signal.aborted || (e instanceof ApiError && e.code === 'ABORTED')) return
        setQuote(null)
        setError(e instanceof ApiError ? e.message : 'Could not price that deposit')
      } finally {
        if (!ctl.signal.aborted) setLoading(false)
      }
    }, DEBOUNCE_MS)
    return () => {
      window.clearTimeout(t)
      ctl.abort()
    }
  }, [amount, amountNum, currency, network])

  return (
    <div className="flex flex-col gap-5">
      {/* Amount */}
      <div className="card-neo rounded-card p-5">
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">Amount</span>
        <div className="mt-2 flex items-baseline gap-2">
          <input
            value={amount}
            onChange={(e) => setAmount(formatStringToNumericDecimals(e.target.value, 6))}
            inputMode="decimal"
            placeholder="0"
            className="tnum w-full min-w-0 bg-transparent text-[42px] font-black leading-none text-text outline-none placeholder:text-text-3"
          />
          <span className="shrink-0 text-2xl font-black text-text-3">{currency}</span>
        </div>
        {belowMin && (
          <div className="mt-2 text-[13px] font-semibold text-amber-400">
            Under ${options.minUsd}, fees eat a big share of it.
          </div>
        )}
      </div>

      {/* The preview. Every row is live. */}
      <div className="surface-skeuo rounded-card p-5">
        {amountNum <= 0 ? (
          <p className="text-[13px] leading-snug text-text-3">Enter an amount to see the live route and fees.</p>
        ) : error ? (
          <div className="flex items-start gap-2.5">
            <TriangleAlert className="mt-px h-[18px] w-[18px] shrink-0 text-down" strokeWidth={2.4} />
            <p className="text-[13px] leading-snug text-text-2">{error}</p>
          </div>
        ) : (
          <div className={loading && !quote ? 'animate-pulse' : undefined}>
            <QuoteRow
              label="You get"
              value={quote ? `~${formatStringToNumericDecimals(quote.toAmount, 2)} ${quote.toSymbol}` : '—'}
              strong
            />
            <QuoteRow label="Fee" value={quote ? `$${quote.feeUsd}` : '—'} />
            <QuoteRow label="Arrives" value={quote ? formatDuration(quote.durationSec) : '—'} />
            <QuoteRow label="Route" value={quote?.toolName ?? '—'} />
            {loading && quote && <div className="mt-2 text-[11px] uppercase tracking-wide text-text-3">Updating…</div>}
          </div>
        )}
      </div>

      {/* The gate. Server-owned. On a mainnet backend with Privy present, BridgeExecute takes over with the
          real connect + sign flow; otherwise it reads honestly rather than pretending to be busy. */}
      {options.executeEnabled && PRIVY_ENABLED ? (
        <BridgeExecute
          options={options}
          currency={currency}
          network={network}
          amount={amount}
          amountValid={amountNum > 0 && !belowMin}
        />
      ) : (
        <>
          <button
            disabled
            className="flex h-14 w-full cursor-not-allowed items-center justify-center gap-2 rounded-card bg-white/[0.06] text-[15px] font-bold text-text-3"
          >
            <Lock className="h-[18px] w-[18px]" strokeWidth={2.6} />
            {options.executeEnabled ? 'Connect wallet' : 'Mainnet only'}
          </button>

          <p className="px-1 text-[13px] leading-snug text-text-3">
            Cross-chain deposits arrive as {options.bridgeAsset} on Sui mainnet. Quotes above are live, but you cannot
            sign one yet.
          </p>
        </>
      )}

      <PoweredByLifi />

      <button
        onClick={() => {
          haptic('selection')
          setInfoOpen((v) => !v)
        }}
        className="flex items-center gap-2 px-1 text-left text-[13px] font-semibold text-text-3"
      >
        <Info className="h-4 w-4" strokeWidth={2.4} />
        How this works
      </button>
      {infoOpen && (
        <div className="-mt-2 flex flex-col gap-2 px-1 text-[13px] leading-snug text-text-3">
          <p>
            You send {currency} from your own wallet on {quote?.fromNetworkLabel ?? 'the source chain'}, and a bridge
            delivers {options.bridgeAsset} straight to your PIPS address. PIPS never holds the funds in transit.
          </p>
          {quote?.toAmountMin && (
            <p>
              You get is an estimate. The guaranteed minimum after slippage is{' '}
              <span className="tnum font-bold text-text-2">
                {formatStringToNumericDecimals(quote.toAmountMin, 2)} {quote.toSymbol}
              </span>
              .
            </p>
          )}
          {quote && (
            <p className="tnum break-all">Arrives at {quote.toAddress}</p>
          )}
        </div>
      )}
    </div>
  )
}

// Routes and pricing come from LI.FI, so attribute it. Text-only on purpose: no logo asset to ship or rot.
function PoweredByLifi() {
  return (
    <a
      href="https://li.fi"
      target="_blank"
      rel="noreferrer"
      className="flex items-center justify-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-text-3 transition-colors active:text-text-2"
    >
      Powered by <span className="font-black text-text-2">LI.FI</span>
    </a>
  )
}

function QuoteRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-[13px] text-text-3">{label}</span>
      <span className={strong ? 'tnum text-[17px] font-black text-text' : 'tnum text-[14px] font-semibold text-text-2'}>
        {value}
      </span>
    </div>
  )
}
