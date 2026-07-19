import { motion } from 'motion/react'

import { useReducedMotion } from '@/hooks/useReducedMotion'
import type { PlayDTO } from '@/lib/api'
import { cnm } from '@/utils/style'
import { formatExactDecimal } from '@/utils/format'
import { Cell, ScreenOverlay } from '@/components/game/screen'

export function FooterStatusPanel({
  kicker,
  head,
  recap,
  progress,
  sweep,
  tone = 'brand',
}: {
  kicker: string
  head: string
  recap: string
  progress?: number
  sweep?: boolean
  tone?: 'brand' | 'up'
}) {
  const ink = tone === 'up' ? 'text-up' : 'text-brand-500'
  const bar = tone === 'up' ? 'bg-up' : 'bg-brand-500'

  return (
    <>
      <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
        {kicker}
      </div>
      <div className={cnm('text-[30px] font-extrabold leading-none', ink)}>{head}</div>
      <div className="mt-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-text-2">
        {recap}
      </div>
      <div className="mt-3 h-1 w-[200px] max-w-full overflow-hidden bg-line-strong">
        {sweep ? (
          <div className={cnm('bar-sweep h-full w-1/3', bar)} />
        ) : (
          <div
            className={cnm('h-full transition-[width] duration-300 ease-out', bar)}
            style={{ width: `${progress ?? 0}%` }}
          />
        )}
      </div>
    </>
  )
}

export function InstructionOverlay({
  title = 'How to play',
  compact = false,
  lines,
}: {
  title?: string
  compact?: boolean
  lines: Array<[string, string]>
}) {
  return (
    <ScreenOverlay title={title}>
      <div className={`flex w-full flex-col ${compact ? 'gap-3' : 'gap-4'}`}>
        {lines.map(([key, value]) => (
          <div key={key}>
            <div
              className={
                compact
                  ? 'font-mono text-[13px] font-bold uppercase tracking-[0.12em] text-text'
                  : 'font-mono text-[16px] font-bold uppercase tracking-[0.12em] text-text'
              }
            >
              {key}
            </div>
            <div
              className={
                compact
                  ? 'mt-0.5 text-[13px] leading-snug text-text-2'
                  : 'mt-1 text-[15px] leading-snug text-text-2'
              }
            >
              {value}
            </div>
          </div>
        ))}
      </div>
    </ScreenOverlay>
  )
}

export function LiveValuePanel({
  markValue,
  pnl,
  entryValue,
  maxPayout,
}: {
  markValue: string
  pnl: string
  entryValue: string
  maxPayout: string
}) {
  const pnlNumber = parseFloat(pnl) || 0
  const positive = pnlNumber >= 0

  return (
    <>
      <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-text-3">
        Cash out now
      </div>
      <div className="tnum text-[40px] font-extrabold leading-none text-text">
        ${formatExactDecimal(markValue)}
      </div>
      <div className="mt-1 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-text-3">
        If you cash out now{' '}
        <span className={cnm('tnum', positive ? 'text-up' : 'text-down')}>
          {pnlNumber >= 0 ? '+' : '-'}${formatExactDecimal(pnl, { absolute: true })}
        </span>
      </div>
      <div className="mt-2.5 grid grid-cols-2 gap-x-3">
        <Cell label="Cost" value={`$${formatExactDecimal(entryValue)}`} />
        <Cell label="Win" value={`$${formatExactDecimal(maxPayout)}`} />
      </div>
    </>
  )
}

// Chart-synced live verdict for the binary + range games: shows the projected payout ("+$X" on the winning
// side, "$0.00" off it) driven by the 60fps chart price, since the backend mark is neutral during an open round.
// `winning` is the client's live on-side/in-zone read; `payout` is the max payout; `cashoutPnl` the neutral cash-out delta.
export function LiveVerdictPanel({
  winning,
  payout,
  cashoutPnl,
}: {
  winning: boolean | null
  payout: string
  cashoutPnl: string
}) {
  const up = winning !== false
  const neg = cashoutPnl.trim().startsWith('-')

  return (
    <>
      <div className={cnm('tnum text-[40px] font-extrabold leading-none', up ? 'text-up' : 'text-down')}>
        {up ? `+$${formatExactDecimal(payout, { absolute: true })}` : '$0.00'}
      </div>
      <div className="mt-1 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-text-3">
        If you cash out now {neg ? '-' : '+'}${formatExactDecimal(cashoutPnl, { absolute: true })}
      </div>
    </>
  )
}

export function ResultOverlay({
  play,
  winTitle,
  cashoutTitle,
  loseTitle,
  streak = 0,
}: {
  play: PlayDTO
  winTitle: string
  cashoutTitle: string
  loseTitle: string
  streak?: number
}) {
  const reduced = useReducedMotion()
  const pnl = parseFloat(play.pnl ?? '0')
  const won = play.status === 'won'
  const cashed = play.status === 'cashed_out'
  const lost = play.status === 'lost'
  const positive = won || (cashed && pnl > 0)
  const head = won ? winTitle : cashed ? cashoutTitle : loseTitle
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
          : `${positive ? '+' : ''}$${formatExactDecimal(play.payout ?? '0', { absolute: true })}`}
      </motion.div>
      <div className="mt-1 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-text-2">
        Cost ${formatExactDecimal(play.entryValue)} · Profit {pnl >= 0 ? '+' : '-'}$
        {formatExactDecimal(play.pnl, { absolute: true })}
      </div>
      {won && streak > 0 && (
        <div className="mt-1 inline-flex items-center border border-brand-500/60 px-2 py-0.5 font-mono text-[12px] font-bold uppercase tracking-[0.1em] text-brand-500">
          Streak {streak}
        </div>
      )}
      <span className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-text-3">
        Any button to continue
      </span>
    </div>
  )
}
