// RANGE console audit: at each lifecycle moment (PLAY, OPEN, LOCK, SETTLE/CASH OUT) prints the UI-shown number next
// to the chain-recorded one plus the delta, so a devnet round can be checked end to end. On by default; silence with `localStorage.pips_range_debug = '0'`.

import type { PlayDTO } from './api'

export type RangeEntryIntent = {
  asset: string
  stake: number
  halfPct: number // the ± band the knob picked
  uiSpot: number // header live price at the press
  chartPrice: number // the chart's eased leading price at the press
  previewMult: number // the multiplier the readout showed (real quote or estimate)
  quoted?: number // the real Predict quote, if it had warmed (else estimate was shown)
}

const enabled = (): boolean => {
  try {
    return localStorage.getItem('pips_range_debug') !== '0'
  } catch {
    return true
  }
}

const num = (v: string | number | null | undefined): number => {
  if (v == null) return NaN
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : NaN
}

// Price-like: fewer decimals as magnitude grows, more for sub-dollar assets.
const px = (v: number): string =>
  !Number.isFinite(v)
    ? '—'
    : v.toLocaleString('en-US', { maximumFractionDigits: v >= 1 ? 2 : 5 })

const money = (v: number): string =>
  !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Absolute + percent delta of an on-chain value vs the UI value (chain - ui).
const delta = (onchain: number, ui: number | undefined): string => {
  if (!Number.isFinite(onchain) || ui == null || !Number.isFinite(ui)) return '—'
  const d = onchain - ui
  const p = ui !== 0 ? (d / ui) * 100 : NaN
  const sign = d >= 0 ? '+' : ''
  return Number.isFinite(p) ? `${sign}${px(d)} (${sign}${p.toFixed(3)}%)` : `${sign}${px(d)}`
}

const pill = (bg: string): string =>
  `color:#0b0b0b;background:${bg};font-weight:700;padding:1px 7px;border-radius:3px`
const AMBER = '#ffb000'
const GREEN = '#19c37d'
const RED = '#ff4d4f'

type TRow = { metric: string; ui: string; onchain: string; d: string }
const r = (metric: string, ui: string, onchain: string, d = ''): TRow => ({ metric, ui, onchain, d })

// Render as one labelled-row table: metric down the side, UI / On-chain / Δ across.
function table(rows: TRow[]): void {
  const obj: Record<string, { 'UI shown': string; 'On-chain': string; Δ: string }> = {}
  for (const row of rows) obj[row.metric] = { 'UI shown': row.ui, 'On-chain': row.onchain, Δ: row.d }
  console.table(obj)
}

const recapOf = (play: PlayDTO): string =>
  `${play.market.asset}  $${play.stake}`

// PLAY pressed: a one-line breadcrumb of the intent. The real comparison lands on OPEN.
export function entry(it: RangeEntryIntent): void {
  if (!enabled()) return
  const q = it.quoted && it.quoted > 0 ? `quote ${it.quoted.toFixed(2)}x` : 'estimate'
  console.log(
    `%cRANGE ▸ PLAY%c ${it.asset}  ±${it.halfPct.toFixed(2)}%  $${money(it.stake)}  ·  UI spot ${px(it.uiSpot)}  chart ${px(it.chartPrice)}  ·  preview ${it.previewMult.toFixed(2)}x (${q})`,
    pill(AMBER),
    '',
  )
}

// OPEN: the mint confirmed, compares the entry/multiplier/cost the UI promised against what minted on-chain.
// Overlays are drawn raw (the backend pins the line to the oracle), so the on-chain band IS what the chart shows.
export function open(play: PlayDTO, it: RangeEntryIntent | null): void {
  if (!enabled()) return
  const entry = num(play.entrySpot)
  const lower = num(play.market.lower)
  const upper = num(play.market.upper)
  const cost = num(play.entryValue)
  const stake = it?.stake ?? num(play.stake)
  const center = (lower + upper) / 2
  const widthPct = Number.isFinite(center) && center > 0 ? ((upper - lower) / center) * 100 : NaN

  const rows: TRow[] = [
    r('Entry price', it ? px(it.uiSpot) : '—', px(entry), delta(entry, it?.uiSpot)),
    r(
      'Multiplier',
      it ? `${it.previewMult.toFixed(2)}x` : '—',
      `${play.multiplier.toFixed(2)}x`,
      it && it.previewMult ? `${(((play.multiplier - it.previewMult) / it.previewMult) * 100).toFixed(2)}%` : '—',
    ),
    r(
      'Stake → cost',
      `$${money(stake)}`,
      `$${money(cost)}`,
      Number.isFinite(cost) && stake ? `${cost - stake >= 0 ? '+' : ''}$${money(cost - stake)} (${(((cost - stake) / stake) * 100).toFixed(1)}% of stake)` : '—',
    ),
    r('Band', Number.isFinite(lower) ? `(${px(lower)}, ${px(upper)}]` : '—', `(${px(lower)}, ${px(upper)}]`, ''),
    r(
      'Band width',
      it ? `${(it.halfPct * 2).toFixed(2)}%` : '—',
      Number.isFinite(widthPct) ? `${widthPct.toFixed(3)}%` : '—',
      '',
    ),
  ]
  console.groupCollapsed(`%cRANGE ▸ OPEN%c  ${recapOf(play)}`, pill(AMBER), '')
  table(rows)
  console.log('mint tx:', play.txMint ?? '—')
  console.groupEnd()
}

// LOCK: the chain froze its settlement price while the chart keeps walking; shows the drift from the locked value and the predicted verdict.
export function lock(
  play: PlayDTO,
  opts: { uiLivePrice: number; predictedInZone: boolean | null },
): void {
  if (!enabled()) return
  const locked = num(play.lockPrice)
  const drift = Number.isFinite(locked) && opts.uiLivePrice > 0 ? opts.uiLivePrice - locked : NaN

  const rows: TRow[] = [
    r('Settle (locked)', px(locked), px(locked), ''),
    r('Live chart now', px(opts.uiLivePrice), '—', Number.isFinite(drift) ? `drift ${px(drift)} past locked` : ''),
    r(
      'Predicted',
      opts.predictedInZone == null ? '—' : opts.predictedInZone ? 'IN ZONE (win)' : 'OUT (loss)',
      '—',
      '',
    ),
  ]
  console.groupCollapsed(`%cRANGE ▸ LOCK%c  ${recapOf(play)}`, pill(AMBER), '')
  table(rows)
  console.groupEnd()
}

// SETTLE / CASH OUT: the terminal frame, validates the UI's predicted outcome against the chain verdict, confirms
// the early-locked price equals final settlement, and compares payout to the redeem event. Mismatches flagged with ⚠.
export function result(
  play: PlayDTO,
  opts: {
    predictedInZone: boolean | null
    previewMult?: number
    stake: number
    lastLockPrice: string | null
  },
): void {
  if (!enabled()) return
  const won = play.status === 'won'
  const cashed = play.status === 'cashed_out'
  const pnl = num(play.pnl)
  const positive = won || (cashed && pnl >= 0)
  const settle = num(play.settlePrice)
  const lower = num(play.market.lower)
  const upper = num(play.market.upper)
  const payout = num(play.payout)
  const cost = num(play.entryValue)
  const lag = play.settledAt ? Math.round((Date.parse(play.settledAt) - play.market.expiry) / 1000) : NaN

  const rows: TRow[] = []

  if (!cashed) {
    // Verdict: did the UI's in/out call match the chain's win/loss?
    const predicted = opts.predictedInZone
    const verdict =
      predicted == null ? '—' : predicted === won ? 'MATCH ✓' : 'MISMATCH ⚠'
    rows.push(
      r(
        'Verdict',
        predicted == null ? '—' : predicted ? 'IN ZONE' : 'OUT',
        won ? 'IN ZONE (WIN)' : 'OUT (LOSS)',
        verdict,
      ),
    )
    // Early-locked price (seen during the freeze window) vs the final settlement: should be identical.
    const lv = num(opts.lastLockPrice)
    const lvCheck =
      Number.isFinite(lv) && Number.isFinite(settle)
        ? Math.abs(lv - settle) < 1e-9
          ? 'exact ✓'
          : `Δ ${px(lv - settle)} ⚠`
        : '—'
    rows.push(r('Lock vs settle', px(lv), px(settle), lvCheck))
  }

  rows.push(
    r(
      cashed ? 'Exit price' : 'Settle price',
      Number.isFinite(settle) ? px(settle) : '—',
      px(settle),
      '',
    ),
  )
  if (!cashed) {
    rows.push(r('Band', '—', `(${px(lower)}, ${px(upper)}]`, ''))
    const uiWin = opts.previewMult && opts.stake ? opts.previewMult * opts.stake : NaN
    rows.push(
      r(
        'Payout vs potential',
        Number.isFinite(uiWin) ? `$${money(uiWin)}` : '—',
        `$${money(payout)}`,
        delta(payout, Number.isFinite(uiWin) ? uiWin : undefined),
      ),
    )
  } else {
    rows.push(r('Payout', '—', `$${money(payout)}`, ''))
  }
  rows.push(r('Entry cost', `$${money(opts.stake)}`, `$${money(cost)}`, ''))
  rows.push(r('Net PnL', '—', `${pnl >= 0 ? '+' : ''}$${money(pnl)}`, ''))
  if (Number.isFinite(lag)) rows.push(r('Settle lag', '—', `${lag}s after expiry`, ''))

  const head = won ? 'WIN' : cashed ? 'CASH OUT' : 'LOSS'
  console.groupCollapsed(
    `%cRANGE ▸ ${head}%c  ${recapOf(play)}`,
    pill(positive ? GREEN : RED),
    '',
  )
  table(rows)
  console.log('settle tx:', play.txSettle ?? '—', ' redeem tx:', play.txRedeem ?? '—')
  console.groupEnd()
}

export const rangeDebug = { entry, open, lock, result }
