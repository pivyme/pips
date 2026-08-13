import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ExternalLink, Loader2, Share2 } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { GameIcon } from '@/components/GameIcon'
import { MenuScreen, ScreenEmpty, ScreenError } from '@/components/menu/shared'
import { type Game, type LuckyParams, type PlayDTO, type RangeParams } from '@/lib/api'
import { historyQuery } from '@/lib/menuQueries'
import { explorerObjectUrl, explorerTxUrl, NETWORK } from '@/lib/sui/config'
import { haptic } from '@/lib/haptics'
import { HapticOverlay } from '@/components/HapticOverlay'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { Modal, useOverlayState } from '@/ui/Modal'
import { Hw3DButton, Hw3DToggle } from '@/ui/Hardware3D'
import { renderPlayCard, sharePlayCard } from '@/lib/playCard'
import { preloadPlayCardAssets } from '@/lib/cardAssets'
import { cnm } from '@/utils/style'
import { formatCompactMoney, formatExactDecimal } from '@/utils/format'

// Full play history, the canonical record (in-game overlays are just a glance). Rows stay dead simple:
// tap one for a detail modal (hero PnL, share CTA, technical readout collapsed underneath), and the
// share button is always one tap away on the row itself. Settled rounds only, newest first.
export const Route = createFileRoute('/_app/menu/history')({ component: HistoryPage })

type Filter = 'all' | Game
const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'lucky', label: 'Lucky' },
  { key: 'range', label: 'Range' },
  { key: 'moonshot', label: 'Moonshot' },
]

// Resolved outcomes only. Open/pending are in-flight (the live screen owns them); error rounds never
// minted (no result, no tx), so they would just be noise in a results log.
const SHOWN = new Set(['won', 'lost', 'cashed_out'])

// Per-row network label, independent of the live env network (rows can be devnet from before the cutover).
const NETWORK_NAMES: Record<string, string> = { devnet: 'Devnet', testnet: 'Testnet', mainnet: 'Mainnet' }
const networkName = (n?: string): string => (n ? (NETWORK_NAMES[n] ?? n) : '')

const money = (value: string, absolute = false): string =>
  formatExactDecimal(value, { absolute })

// Rows that can be on screen at once, generously. Everything past this mounts a frame later, see fullList.
const VISIBLE_ROWS = 10

const fmtMult = (n: number): string => `${n.toFixed(2).replace(/\.?0+$/, '')}x`
const shortId = (d: string): string => `${d.slice(0, 6)}…${d.slice(-4)}`

// Built once, not per call. `toLocaleString(locale, opts)` constructs a fresh Intl formatter every time,
// which is one of the more expensive things you can do in a list row, and this page renders a lot of them.
const PRICE_FMT = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
const PRICE_FMT_SUB = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 6 })
const TIME_FMT = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' })
const WHEN_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

const fmtPrice = (s?: string): string => {
  if (!s) return '—'
  const n = parseFloat(s)
  if (!Number.isFinite(n)) return '—'
  return `$${(n >= 1 ? PRICE_FMT : PRICE_FMT_SUB).format(n)}`
}
const fmtTime = (iso?: string): string => (iso ? TIME_FMT.format(new Date(iso)) : '—')

// Compact timestamp for the modal context line: "Jul 22, 5:27 AM".
const fmtWhen = (iso?: string): string => (iso ? WHEN_FMT.format(new Date(iso)) : '—')

// What a losing ticket would have paid above cost: cost × multiplier − cost. FOMO beats an obvious -100%.
const missedProfit = (p: PlayDTO): number => {
  const cost = parseFloat(p.entryValue ?? '0')
  const missed = cost * p.multiplier - cost
  return Number.isFinite(missed) && missed > 0 ? missed : 0
}

function timeAgo(iso?: string): string {
  if (!iso) return ''
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// --- Last 7 days summary strip -------------------------------------------------------------------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

interface DayCell {
  key: string
  label: string
  net: number
  plays: number
  wins: number
  isToday: boolean
}

const localDayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Roll the fetched settled plays into the last 7 local days for the strip. Display-only candy, so a plain
// float sum of the pnl strings (rounded to cents) is fine, nothing here is a recorded or settled number.
function buildWeek(plays: PlayDTO[]): {
  cells: DayCell[]
  net: number
  wins: number
  losses: number
  total: number
} {
  const now = new Date()
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const cells: DayCell[] = []
  const byKey = new Map<string, DayCell>()
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today0)
    d.setDate(d.getDate() - i)
    const cell: DayCell = { key: localDayKey(d), label: WEEKDAYS[d.getDay()], net: 0, plays: 0, wins: 0, isToday: i === 0 }
    cells.push(cell)
    byKey.set(cell.key, cell)
  }
  for (const p of plays) {
    const iso = p.settledAt ?? p.openedAt
    if (!iso) continue
    const cell = byKey.get(localDayKey(new Date(iso)))
    if (!cell) continue
    const pnl = parseFloat(p.pnl ?? '0')
    cell.net += Number.isFinite(pnl) ? pnl : 0
    cell.plays += 1
    if (p.status === 'won' || (p.status === 'cashed_out' && pnl > 0)) cell.wins += 1
  }
  let net = 0
  let wins = 0
  let total = 0
  for (const c of cells) {
    c.net = Math.round(c.net * 100) / 100 // kill float noise so a matched win/loss day reads as flat, not a hair off
    net += c.net
    wins += c.wins
    total += c.plays
  }
  return { cells, net: Math.round(net * 100) / 100, wins, losses: total - wins, total }
}

// Compact magnitude for a tight day cell: 1dp under $100, integer under $1k, k/M suffix above. Cell owns the sign.
function tileMag(abs: number): string {
  if (abs >= 1000) return formatCompactMoney(abs.toString())
  if (abs >= 100) return Math.round(abs).toString()
  const oneDp = Math.round(abs * 10) / 10
  return Number.isInteger(oneDp) ? oneDp.toString() : oneDp.toFixed(1)
}

function WeekStrip({ plays }: { plays: PlayDTO[] }) {
  const reduced = useReducedMotion()
  const wk = buildWeek(plays)
  const netTone = wk.net > 0 ? 'text-up' : wk.net < 0 ? 'text-down' : 'text-text-2'
  const netSign = wk.net > 0 ? '+' : wk.net < 0 ? '-' : ''

  return (
    <div
      className="rounded-card border-[1.5px] border-brand-500 p-4"
      style={{
        // Bright raised skeuo plate, boldly framed in amber with a glow, so the hero stat panel pops off the rows.
        background: 'linear-gradient(180deg,#2a2619 0%,#1c1913 52%,#131110 100%)',
        boxShadow:
          'inset 0 1px 0 rgba(255,229,158,0.34), inset 0 -2px 8px rgba(0,0,0,0.5), 0 2px 0 rgba(0,0,0,0.6), 0 0 28px -4px rgba(255,192,22,0.55)',
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-text-3">Last 7 days</div>
          <div className="mt-1 flex items-center gap-1.5 text-[12px] font-bold">
            {wk.total > 0 ? (
              <>
                <span className="tnum text-up">{wk.wins}W</span>
                <span className="text-text-3">·</span>
                <span className="tnum text-down">{wk.losses}L</span>
              </>
            ) : (
              <span className="text-text-3">No plays this week</span>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className={cnm('tnum text-[20px] font-extrabold leading-none', netTone)}>
            {netSign}${formatCompactMoney(Math.abs(wk.net).toString())}
          </div>
          <div className="mt-1 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-text-3">Net</div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-7 gap-1.5">
        {wk.cells.map((c, i) => {
          const tone = c.plays === 0 || c.net === 0 ? 'flat' : c.net > 0 ? 'up' : 'down'
          // Tinted win/loss box with matching colored text; today is marked by its amber label, not a border.
          const fill = tone === 'up' ? 'rgba(52,211,153,0.2)' : tone === 'down' ? 'rgba(255,90,77,0.2)' : 'rgba(255,255,255,0.05)'
          return (
            <div key={c.key} className="flex flex-col items-center gap-1">
              <span
                className={cnm(
                  'font-mono text-[9px] font-semibold uppercase tracking-[0.08em]',
                  c.isToday ? 'text-brand-500' : 'text-text-3',
                )}
              >
                {c.isToday ? 'Today' : c.label}
              </span>
              <motion.div
                initial={reduced ? false : { opacity: 0, y: 6, scale: 0.94 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={reduced ? { duration: 0 } : { delay: i * 0.03, duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
                className={cnm(
                  'flex h-[54px] w-full items-center justify-center rounded-xl px-0.5',
                  // No colored border on filled boxes, keep it sleek. Empty days get a faint outline so the slot still reads.
                  tone === 'flat' && 'border border-white/[0.07]',
                )}
                style={{ backgroundColor: fill }}
              >
                {c.plays === 0 ? (
                  <span className="text-[16px] font-bold text-text-3/60">·</span>
                ) : (
                  <span
                    className={cnm(
                      'tnum text-[15px] font-extrabold leading-none',
                      tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text-2',
                    )}
                  >
                    {c.net > 0 ? '+' : c.net < 0 ? '-' : ''}
                    {tileMag(Math.abs(c.net))}
                  </span>
                )}
              </motion.div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function HistoryPage() {
  const [filter, setFilter] = useState<Filter>('all')
  // "Show devnet" defaults on so a returning player's full pre-cutover history stays visible; off narrows to
  // the live network. The toggle only surfaces once we've actually seen a devnet row, so a fresh testnet-only
  // account never sees it. everDevnet latches true and never flips back, so narrowing can't hide the control.
  const [showDevnet, setShowDevnet] = useState(true)
  const [everDevnet, setEverDevnet] = useState(false)
  const q = useQuery(historyQuery(showDevnet))

  // Warm the share-card template art so the share sheet's first open renders instantly. Held until the
  // push transition has finished: this decodes ~250KB of WebP and can mount a second WebGL rig, and this
  // effect fires on the exact frame the slide-in starts.
  useEffect(() => {
    const t = window.setTimeout(preloadPlayCardAssets, 700)
    return () => window.clearTimeout(t)
  }, [])

  useEffect(() => {
    if (!everDevnet && (q.data?.plays ?? []).some((p) => p.network === 'devnet')) setEverDevnet(true)
  }, [q.data, everDevnet])

  // The push transition holds the screen frozen until React finishes committing this page, and this is the
  // longest list in the menu. Mount only what can physically be on screen inside that window; the rest
  // lands on the first frame of the slide, long before you could scroll to it.
  const [fullList, setFullList] = useState(false)
  useEffect(() => {
    if (fullList) return
    const raf = requestAnimationFrame(() => setFullList(true))
    return () => cancelAnimationFrame(raf)
  }, [fullList])

  // All settled plays feed the 7-day strip (game-filter-independent, it sits above the tabs); the list
  // below narrows by the active game pill.
  const allSettled = (q.data?.plays ?? []).filter((p) => SHOWN.has(p.status))
  const rows = allSettled.filter((p) => filter === 'all' || p.game === filter)

  return (
    <MenuScreen title="History">
      <div className="flex flex-col gap-4">
        {q.isLoading ? (
          <div className="shimmer h-[150px] w-full rounded-card" />
        ) : allSettled.length > 0 ? (
          <WeekStrip plays={allSettled} />
        ) : null}

        <div className="flex gap-2">
          {FILTERS.map((f) => (
            <div key={f.key} className="relative">
              <button
                type="button"
                onClick={() => {
                  haptic('selection')
                  setFilter(f.key)
                }}
                className={cnm(
                  'pointer-events-none flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-extrabold uppercase tracking-wide transition-colors',
                  filter === f.key ? 'bg-white/[0.92] text-black' : 'surface-skeuo text-text-2',
                )}
              >
                {f.key !== 'all' && <GameIcon game={f.key} size={13} />}
                {f.label}
              </button>
              <HapticOverlay
                className="absolute inset-0 rounded-full"
                preset="selection"
                onTap={() => setFilter(f.key)}
              />
            </div>
          ))}
        </div>

        {everDevnet && (
          <div className="surface-skeuo flex items-center justify-between gap-3 rounded-card px-4 py-3">
            <div className="min-w-0">
              <div className="text-[14px] font-bold text-text">Show devnet history</div>
              <div className="mt-0.5 text-[12px] leading-snug text-text-3">Your older plays from before the testnet move.</div>
            </div>
            <Hw3DToggle
              label="Show devnet history"
              isSelected={showDevnet}
              onChange={setShowDevnet}
            />
          </div>
        )}

        {q.isLoading ? (
          <div className="flex flex-col gap-2.5">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="shimmer h-[72px] w-full rounded-card" />
            ))}
          </div>
        ) : q.isError ? (
          <ScreenError message="Could not load your history." onRetry={() => void q.refetch()} />
        ) : rows.length === 0 ? (
          <ScreenEmpty title="No plays yet" sub="Play your first game and it'll show up here." />
        ) : (
          <div className="flex flex-col gap-2.5">
            {(fullList ? rows : rows.slice(0, VISIBLE_ROWS)).map((p) => (
              <HistoryRow key={p.id} play={p} />
            ))}
          </div>
        )}
      </div>
    </MenuScreen>
  )
}

function headOf(play: PlayDTO): { asset: string; line: string } {
  if (play.game === 'lucky' || play.game === 'moonshot') {
    const lp = play.params as LuckyParams
    const dir = play.game === 'moonshot' ? (lp.side === 'up' ? 'LONG' : 'SHORT') : lp.side === 'up' ? 'UP' : 'DOWN'
    return { asset: lp.asset, line: `${dir} · ${fmtMult(play.multiplier)}` }
  }
  const rp = play.params as RangeParams
  return { asset: rp.asset, line: rp.widthPct ? `Range · ${rp.widthPct}% band` : 'Range' }
}

// The labelled debug rows for the expanded panel. Lucky shows its target strike; range shows its band.
function detailRows(play: PlayDTO): Array<[string, ReactNode]> {
  const rows: Array<[string, ReactNode]> = [
    ['Duration', `${play.params.duration}s`],
    ['Multiplier', fmtMult(play.multiplier)],
  ]
  if (play.game === 'lucky' || play.game === 'moonshot') {
    rows.push(['Target', fmtPrice(play.market.strike)])
  } else {
    rows.push(['Band', `${fmtPrice(play.market.lower)} – ${fmtPrice(play.market.upper)}`])
  }
  rows.push(
    ['Entry price', fmtPrice(play.entrySpot)],
    ['Settlement price', play.status === 'cashed_out' ? 'Not applicable' : fmtPrice(play.settlePrice)],
    ['Selected stake', `$${money(play.stake)}`],
    ['Actual cost', `$${money(play.entryValue)}`],
    ['Payout', play.payout ? `$${money(play.payout)}` : '—'],
    [
      'Realized PnL',
      `${parseFloat(play.pnl) >= 0 ? '+' : '-'}$${money(play.pnl, true)}`,
    ],
    ['Opened', fmtTime(play.openedAt)],
    ['Settled', fmtTime(play.settledAt)],
  )
  return rows
}

function HistoryRow({ play }: { play: PlayDTO }) {
  const detail = useOverlayState()
  const share = useOverlayState()
  const pnl = parseFloat(play.pnl ?? '0')
  const positive = play.status === 'won' || (play.status === 'cashed_out' && pnl > 0)
  const label = play.status === 'won' ? 'Won' : play.status === 'cashed_out' ? 'Cashed' : 'Lost'
  const { asset, line } = headOf(play)
  // Headline: wins show total payout (stake + profit), matching the in-game result pops; losses show the
  // cost that burned, a red $0.00 payout reads like a bug. Fall back to cost + pnl for legacy rows.
  const total = play.payout ?? String(parseFloat(play.entryValue ?? '0') + pnl)
  const headline = play.status === 'lost' ? `-$${money(play.entryValue, true)}` : `${positive ? '+' : ''}$${money(total, true)}`

  return (
    <div className="surface-skeuo flex items-stretch overflow-hidden rounded-card">
      {/* The row body opens the detail modal; the technical readout lives there now, not an accordion. */}
      <div className="relative min-w-0 flex-1">
        <button
          type="button"
          className="pointer-events-none flex w-full items-center justify-between gap-3 p-4 text-left transition-transform active:scale-[0.99]"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <GameIcon game={play.game} size={15} className="text-text-2" />
              <span className="text-[15px] font-bold capitalize">{play.game}</span>
              <span className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-text-2">{asset}</span>
              {play.network && play.network !== NETWORK && (
                <span className="rounded-full bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-text-3">
                  {networkName(play.network)}
                </span>
              )}
            </div>
            <div className="mt-1 flex items-center gap-2 text-[13px] text-text-2">
              <span>{line}</span>
              <span className="text-text-3">·</span>
              <span className="text-text-3">{timeAgo(play.settledAt ?? play.openedAt)}</span>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className={cnm('text-[11px] font-bold uppercase tracking-wide', positive ? 'text-up' : 'text-down')}>{label}</div>
            <div className={cnm('tnum text-[17px] font-extrabold leading-tight', positive ? 'text-up' : 'text-down')}>{headline}</div>
          </div>
        </button>
        <HapticOverlay className="absolute inset-0" preset="selection" onTap={() => detail.open()} />
      </div>

      {/* Share is always one tap away, never buried in the detail view. */}
      <div className="relative flex items-center border-l border-white/[0.06] px-3">
        <button
          type="button"
          aria-label="Share this play"
          className="pointer-events-none flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.05] text-brand-300 transition-transform active:scale-90"
        >
          <Share2 className="h-[17px] w-[17px]" strokeWidth={2.6} />
        </button>
        <HapticOverlay className="absolute inset-0" preset="medium" onTap={() => share.open()} />
      </div>

      <PlayDetailModal
        play={play}
        isOpen={detail.isOpen}
        onOpenChange={detail.setOpen}
        onShare={() => {
          detail.close()
          share.open()
        }}
      />
      <PlayShareModal play={play} isOpen={share.isOpen} onOpenChange={share.setOpen} />
    </div>
  )
}

// One stat cell in the modal hero: big number over a mono micro-label, recessed into the lighter plate.
function HeroStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl bg-black/[0.22] px-2 py-2.5 text-center shadow-[inset_0_1px_3px_rgba(0,0,0,0.35)]">
      <div className={cnm('tnum text-[15px] font-extrabold leading-none', tone ?? 'text-white')}>{value}</div>
      <div className="mt-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-white/40">{label}</div>
    </div>
  )
}

// The play detail sheet: hero PnL up top, one share CTA, and the full technical readout tucked
// behind a collapsed "Trade details" section so the default view stays dead simple.
function PlayDetailModal({
  play,
  isOpen,
  onOpenChange,
  onShare,
}: {
  play: PlayDTO
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onShare: () => void
}) {
  const [showDetails, setShowDetails] = useState(false)
  const pnl = parseFloat(play.pnl ?? '0')
  const positive = play.status === 'won' || (play.status === 'cashed_out' && pnl > 0)
  const entry = parseFloat(play.entryValue ?? '0')
  const roi = entry > 0 ? (pnl / entry) * 100 : 0
  const tone = positive ? 'text-up' : 'text-down'
  const title = play.status === 'cashed_out' ? 'Cashed Out' : positive ? 'Profit' : 'Rekt'
  const { asset } = headOf(play)

  // A fresh open always starts collapsed.
  useEffect(() => {
    if (isOpen) setShowDetails(false)
  }, [isOpen])

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="md" placement="center" title={title}>
      <div className="flex flex-col gap-3 pb-1">
        {/* Hero: the play at a glance, on a quiet outcome-tinted skeuo plate (deep green win, deep red loss).
            Inner shadows only, no border, no glow, keeps it modern. */}
        <div
          className="rounded-card px-4 py-5 text-center"
          style={
            positive
              ? {
                  background: 'linear-gradient(180deg,#17352a 0%,#102a20 52%,#0b1f18 100%)',
                  boxShadow: 'inset 0 1px 0 rgba(148,233,192,0.14), inset 0 -2px 8px rgba(0,0,0,0.45), 0 1px 0 rgba(0,0,0,0.6)',
                }
              : {
                  background: 'linear-gradient(180deg,#3a1d19 0%,#2b1512 52%,#1f100e 100%)',
                  boxShadow: 'inset 0 1px 0 rgba(255,170,160,0.12), inset 0 -2px 8px rgba(0,0,0,0.45), 0 1px 0 rgba(0,0,0,0.6)',
                }
          }
        >
          <div className="flex items-center justify-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-white/50">
            <GameIcon game={play.game} size={12} />
            <span className="capitalize">{play.game}</span> · {asset} · {fmtWhen(play.settledAt ?? play.openedAt)}
          </div>
          <div className={cnm('tnum mt-2.5 text-[40px] font-black leading-none', tone)}>
            {pnl >= 0 ? '+' : '-'}${money(play.pnl, true)}
          </div>
          <div className="mt-5 grid grid-cols-3 gap-2">
            <HeroStat label="Amount" value={`$${money(play.entryValue)}`} />
            <HeroStat label="Multiplier" value={fmtMult(play.multiplier)} />
            {/* A full loss is always -100%, useless. Show the payout that got away instead. */}
            {play.status === 'lost' && missedProfit(play) > 0 ? (
              <HeroStat label="Missed profit" value={`$${missedProfit(play).toFixed(2)}`} tone="text-brand-300" />
            ) : (
              <HeroStat label="PnL" value={`${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`} tone={tone} />
            )}
          </div>
        </div>

        {/* Share CTA: turn the round into a card. */}
        <div className="surface-skeuo flex items-center justify-between gap-3 rounded-card px-4 py-3.5">
          <div className="min-w-0">
            <div className="text-[15px] font-bold text-white">{positive ? 'Share your gain' : 'Share your rekt'}</div>
            <div className="mt-0.5 text-[12px] leading-snug text-text-3">Turn this play into a card.</div>
          </div>
          <Hw3DButton size="sm" variant="primary" icon={Share2} haptic="medium" onPress={onShare} className="shrink-0">
            Share
          </Hw3DButton>
        </div>

        {/* The technical record, collapsed by default. */}
        <div className="surface-skeuo rounded-card">
          <div className="relative">
            <button type="button" className="pointer-events-none flex w-full items-center justify-between px-4 py-3.5 text-left">
              <span className="text-[14px] font-bold text-text">Trade details</span>
              <ChevronDown className={cnm('h-5 w-5 text-text-3 transition-transform', showDetails && 'rotate-180')} strokeWidth={2.4} />
            </button>
            <HapticOverlay className="absolute inset-0" preset="selection" onTap={() => setShowDetails((s) => !s)} />
          </div>
          {showDetails && (
            <div className="border-t border-white/[0.06] px-4 pb-4 pt-3">
              <div className="flex flex-col gap-y-2">
                {detailRows(play).map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-[11px] uppercase tracking-wide text-text-3">{k}</span>
                    <span className="tnum truncate text-right text-[13px] font-semibold text-text-2">{v}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-col gap-2 border-t border-white/[0.06] pt-3">
                {play.txMint && <LinkRow label="Mint tx" id={play.txMint} href={explorerTxUrl(play.txMint)} />}
                {/* The tx that froze the settlement price this round resolved against. Falls back to the
                    oracle object when this play settled on a chain push we didn't author (follower mode). */}
                {play.txSettle ? (
                  <LinkRow label="Settle tx" id={play.txSettle} href={explorerTxUrl(play.txSettle)} />
                ) : (
                  play.market.oracleId && <LinkRow label="Oracle" id={play.market.oracleId} href={explorerObjectUrl(play.market.oracleId)} />
                )}
                {play.txRedeem && <LinkRow label="Redeem tx" id={play.txRedeem} href={explorerTxUrl(play.txRedeem)} />}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

// The share sheet: a live preview of the exported PNG and one Share button (native sheet, download fallback).
function PlayShareModal({ play, isOpen, onOpenChange }: { play: PlayDTO; isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)
  // Dollar PnL is private for a lot of people, so it's opt-in. The ROI % always shows.
  const [showPnl, setShowPnl] = useState(false)
  const urlRef = useRef<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setUrl(null)
    renderPlayCard(play, { showPnl }).then((blob) => {
      if (cancelled || !blob) return
      const next = URL.createObjectURL(blob)
      urlRef.current = next
      setUrl(next)
    })
    return () => {
      cancelled = true
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [isOpen, play, showPnl])

  const doShare = async () => {
    if (sharing) return
    // No press haptic here: the Hw3DButton below already has an explicit haptic="medium" prop.
    setSharing(true)
    try {
      await sharePlayCard(play, { showPnl })
      haptic('success')
    } catch {
      const { default: toast } = await import('react-hot-toast')
      toast.error('Could not make your card. Try again.', { id: 'share-play' })
    } finally {
      setSharing(false)
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="md"
      placement="center"
      title="Share PnL"
      description="Turn this play into a card to share."
    >
      <div className="flex flex-col gap-4 pb-1">
        <div className="relative aspect-[16/9] w-full overflow-hidden rounded-md bg-black/50 ring-1 ring-white/10">
          {url ? (
            <img src={url} alt="Your play as a shareable card" className="h-full w-full object-contain" />
          ) : (
            <div className="absolute inset-0 grid place-items-center">
              <Loader2 className="h-5 w-5 animate-spin text-white/50" strokeWidth={2.6} />
            </div>
          )}
        </div>

        {/* The one knob: the dollar PnL is private for a lot of people. ROI % stays on either way. */}
        <div className="surface-skeuo flex items-center gap-3 rounded-card px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-bold text-white">Show PnL value</div>
            <div className="mt-0.5 text-[12px] leading-snug text-text-3">Your net dollar PnL on the card.</div>
          </div>
          <Hw3DToggle label="Show PnL value" isSelected={showPnl} onChange={setShowPnl} />
        </div>

        <Hw3DButton
          variant="primary"
          wide
          loading={sharing}
          icon={Share2}
          haptic="medium"
          onPress={() => void doShare()}
        >
          {sharing ? 'Making your card' : 'Share card'}
        </Hw3DButton>
      </div>
    </Modal>
  )
}

// One labelled explorer link row (a tx digest or an object id), styled like the readout rows.
function LinkRow({ label, id, href }: { label: string; id: string; href: string }) {
  return (
    <div className="relative">
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={() => haptic('selection')}
        className="pointer-events-none flex items-center justify-between gap-2 rounded-xl bg-white/[0.04] px-3 py-2 transition-colors active:bg-white/[0.08]"
      >
        <span className="font-mono text-[11px] uppercase tracking-wide text-text-3">{label}</span>
        <span className="flex items-center gap-1.5 font-mono text-[12px] text-text">
          {shortId(id)}
          <ExternalLink className="h-3.5 w-3.5 text-text-3" strokeWidth={2.4} />
        </span>
      </a>
      <HapticOverlay
        className="absolute inset-0 rounded-xl"
        preset="selection"
        onTap={() => window.open(href, '_blank', 'noreferrer')}
      />
    </div>
  )
}
