import { motion } from 'motion/react'

import type { PlayDTO } from '@/lib/api'
import { cnm } from '@/utils/style'
import { formatExactDecimal } from '@/utils/format'
import { useReducedMotion } from '@/hooks/useReducedMotion'

const compact = (n: number): string =>
  n >= 1000
    ? `${(n / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k`
    : n.toLocaleString('en-US', { maximumFractionDigits: n >= 1 ? 2 : 4 })

const priceLabel = (p: number): string =>
  `$${p.toLocaleString('en-US', {
    maximumFractionDigits: p >= 1000 ? 0 : p >= 1 ? 2 : 4,
  })}`

export function RangePnl({
  inside,
  payout,
  cashoutPnl,
}: {
  inside: boolean | null
  payout: string
  cashoutPnl: string
}) {
  const up = inside !== false
  const neg = cashoutPnl.trim().startsWith('-')

  return (
    <>
      <div
        className={cnm(
          'tnum text-[40px] font-extrabold leading-none',
          up ? 'text-up' : 'text-down',
        )}
      >
        {up ? `+$${formatExactDecimal(payout, { absolute: true })}` : '$0.00'}
      </div>
      <div className="mt-1 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-text-3">
        If you cash out now {neg ? '-' : '+'}$
        {formatExactDecimal(cashoutPnl, { absolute: true })}
      </div>
    </>
  )
}

export function RangeResult({ play }: { play: PlayDTO }) {
  const reduced = useReducedMotion()
  const pnl = parseFloat(play.pnl)
  const won = play.status === 'won'
  const cashed = play.status === 'cashed_out'
  const lost = play.status === 'lost'
  const positive = won || (cashed && pnl > 0)
  const head = won ? 'IN THE ZONE' : cashed ? 'CASHED OUT' : 'OUT OF RANGE'
  // Overlays are drawn raw: the backend price bus pins the chart line to the oracle level, so the
  // on-chain band + settle price already sit on the line (no client feed offset).
  const lo = play.market.lower ? parseFloat(play.market.lower) : null
  const hi = play.market.upper ? parseFloat(play.market.upper) : null
  const settled = play.settlePrice ? parseFloat(play.settlePrice) : null
  const hasGauge =
    !cashed &&
    lo != null &&
    hi != null &&
    settled != null &&
    Number.isFinite(lo) &&
    Number.isFinite(hi) &&
    Number.isFinite(settled) &&
    hi > lo
  const relation: 'below' | 'inside' | 'above' = !hasGauge
    ? 'inside'
    : won
      ? 'inside'
      : settled <= lo
        ? 'below'
        : settled > hi
          ? 'above'
          : cashed
            ? 'inside'
            : settled <= (lo + hi) / 2
              ? 'below'
              : 'above'
  const pop = reduced
    ? {}
    : {
        initial: { scale: 0.7, opacity: 0 },
        animate: { scale: 1, opacity: 1 },
        transition: { type: 'spring' as const, stiffness: 440, damping: 24 },
      }

  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/90 text-center">
      <div
        className={cnm(
          'font-mono text-[13px] font-bold uppercase tracking-[0.2em]',
          positive ? 'text-up' : 'text-down',
        )}
      >
        {head}
      </div>
      <motion.div
        {...pop}
        style={{ textShadow: '0 0 28px currentColor' }}
        className={cnm(
          'tnum text-[56px] font-extrabold leading-none',
          positive ? 'text-up' : 'text-down',
        )}
      >
        {lost
          ? `$${formatExactDecimal('0')}`
          : `${pnl >= 0 ? '+' : '-'}$${formatExactDecimal(play.pnl, { absolute: true })}`}
      </motion.div>
      <div className="mt-1 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-text-2">
        Payout ${formatExactDecimal(play.payout ?? '0')} · Cost $
        {formatExactDecimal(play.entryValue)}
      </div>
      {hasGauge ? (
        <SettlementGauge
          lower={lo}
          upper={hi}
          price={settled}
          relation={relation}
          label={cashed ? 'Exit' : 'Settled'}
        />
      ) : (
        lo != null &&
        hi != null && (
          <div className="font-mono text-[12px] uppercase tracking-[0.12em] text-text-3">
            Band {compact(lo)} – {compact(hi)}
          </div>
        )
      )}
      <span className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-text-3">
        Any button to continue
      </span>
    </div>
  )
}

function SettlementGauge({
  lower,
  upper,
  price,
  relation,
  label,
}: {
  lower: number
  upper: number
  price: number
  relation: 'below' | 'inside' | 'above'
  label: 'Exit' | 'Settled'
}) {
  const span = upper - lower
  const pricePct = Math.max(4, Math.min(96, 25 + ((price - lower) / span) * 50))
  const inside = relation === 'inside'
  const relationCopy = inside
    ? `${label} inside your band`
    : `${label} ${relation} your band`

  return (
    <div className="mt-3 w-[280px] max-w-[72%]">
      <div className="relative h-5 border-y border-line-strong">
        <div className="absolute inset-y-0 left-1/4 w-1/2 bg-brand-500/20" />
        <div className="absolute inset-y-0 left-1/4 w-px bg-brand-500" />
        <div className="absolute inset-y-0 left-3/4 w-px bg-brand-500" />
        <div
          className={cnm(
            'absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 border-2 border-black',
            inside ? 'bg-up' : 'bg-down',
          )}
          style={{ left: `${pricePct}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-text-3">
        <span>{compact(lower)}</span>
        <span>{compact(upper)}</span>
      </div>
      <div
        className={cnm(
          'mt-2 font-mono text-[11px] font-bold uppercase tracking-[0.1em]',
          inside ? 'text-up' : 'text-down',
        )}
      >
        {relationCopy} · {priceLabel(price)}
      </div>
    </div>
  )
}
