import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/lib/auth'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { haptic } from '@/lib/haptics'
import { cnm } from '@/utils/style'

// Trade confirmation, the opt-in fat-finger guard (see .claude/TRADE_CONFIRMATION.md). When a player
// turns "Confirm trades" on, placing a staked play becomes two presses: the first arms and shows this
// sheet, a second within the window actually places. Off (the default) the first press places, exactly
// as before. This one file holds both the hook and the panel so the arm/confirm/countdown logic lives
// in a single place, consumed by Lucky / Range / Moonshot.

// The safety window: an armed trade auto-disarms after this so a play you set up and walked away from
// never sits primed for a stray later tap. It is a timeout, not deadline pressure.
export const CONFIRM_WINDOW_MS = 5000

export interface TradeDetails {
  stake: number // dollars at risk
  headline: string // the play in one line, e.g. "BTC · LONG · 5x", or "I Feel Lucky" when the reel deals it
  multiplier?: number // for the payout line, when known pre-place
  maxPayout?: number // the NET max win (net-of-house-rake stake * multiplier), when known pre-place
  note?: string // a small subline, e.g. "Hold to the buzzer"
}

// onPlace = the game's existing doPlay(). getDetails() is read fresh at arm time so the sheet shows the
// exact stake/play the second press will fire.
export function useTradeConfirm(onPlace: () => void, getDetails: () => TradeDetails) {
  const { user } = useAuth()
  const reduced = useReducedMotion()
  const enabled = user?.settings.confirmTrades ?? false
  const [armed, setArmed] = useState<TradeDetails | null>(null)
  const [remainingMs, setRemainingMs] = useState(0)

  // Silent disarm, for programmatic invalidation (market went stale, can't afford, phase left idle).
  const disarm = useCallback(() => {
    setArmed(null)
    setRemainingMs(0)
  }, [])

  // Explicit CANCEL press: a light tick, then disarm.
  const cancel = useCallback(() => {
    haptic('selection')
    disarm()
  }, [disarm])

  // Replaces the direct doPlay() on the main button.
  const press = useCallback(() => {
    if (!enabled) {
      onPlace() // gate off: place immediately, today's behavior
      return
    }
    if (armed) {
      disarm() // second press inside the window: place, same as a single ungated press
      onPlace()
      return
    }
    haptic('rigid') // first press: arm
    setArmed(getDetails())
    setRemainingMs(CONFIRM_WINDOW_MS)
  }, [enabled, armed, onPlace, getDetails, disarm])

  // Countdown + auto-disarm in one deadline-driven loop, so the disarm fires at exactly the window
  // regardless of tick cadence. Reduced motion steps once a second (visible ticks) rather than sweeping;
  // the timeout itself is identical either way.
  useEffect(() => {
    if (!armed) return
    const deadline = performance.now() + CONFIRM_WINDOW_MS
    const tick = () => {
      const left = deadline - performance.now()
      if (left <= 0) {
        setRemainingMs(0)
        setArmed(null)
        return
      }
      setRemainingMs(left)
    }
    const iv = setInterval(tick, reduced ? 1000 : 50)
    return () => clearInterval(iv)
  }, [armed, reduced])

  return { enabled, armed, remainingMs, press, cancel, disarm }
}

const money = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtMult = (n: number): string => `×${n.toFixed(2).replace(/\.?0+$/, '')}`

// The armed panel. Renders on the game screen, so it follows docs/SCREEN.md (the Teenage Engineering
// instrument language, not the rounded App Surface): flat black, hairline rows, mono uppercase
// micro-labels over tabular numbers, one amber accent, an amber countdown bar draining the window. It
// sits in the notch-safe bottom band, so keep it left-only and compact.
export function TradeConfirmSheet({
  details,
  remainingMs,
}: {
  details: TradeDetails
  remainingMs: number
}) {
  const reduced = useReducedMotion()
  const pct = Math.max(0, Math.min(100, (remainingMs / CONFIRM_WINDOW_MS) * 100))
  const rows: Array<[string, string]> = [
    ['Stake', `$${money(details.stake)}`],
    ['Play', details.headline],
  ]
  if (details.multiplier != null) rows.push(['Mult', fmtMult(details.multiplier)])
  if (details.maxPayout != null) rows.push(['Max win', `$${money(details.maxPayout)}`])

  return (
    <div>
      <div className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-brand-500">Confirm trade</div>
      <div className="mt-2 flex flex-col">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex items-baseline justify-between gap-3 border-t border-line-strong py-1.5 first:border-t-0"
          >
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-text-3">{label}</span>
            <span className="tnum text-[15px] font-bold leading-none text-text">{value}</span>
          </div>
        ))}
      </div>
      {details.note && (
        <div className="mt-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-text-3">{details.note}</div>
      )}
      <div className="mt-3 h-1 w-[200px] max-w-full overflow-hidden bg-line-strong">
        <div
          className={cnm('h-full bg-brand-500', reduced ? '' : 'transition-[width] duration-75 ease-linear')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-2 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-text-2">
        Press <span className="text-brand-500">CONFIRM</span> to place
      </div>
    </div>
  )
}
