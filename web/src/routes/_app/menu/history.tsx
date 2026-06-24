import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ExternalLink } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { MenuScreen, ScreenEmpty, ScreenError } from '@/components/menu/shared'
import { api, type Game, type LuckyParams, type PlayDTO, type RangeParams } from '@/lib/api'
import { explorerObjectUrl, explorerTxUrl } from '@/lib/sui/config'
import { haptic } from '@/lib/haptics'
import { cnm } from '@/utils/style'
import { formatExactDecimal } from '@/utils/format'

// The full play history across every game, the canonical record (the in-game overlays are just a
// quick glance). App Surface language: rounded cards on black. Tap a row to expand the full debug
// panel, duration, entry/exit price, target, cost, payout, oracle, and links to both transactions.
// Settled rounds only, newest first; in-flight plays are left out (they still move).
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

const money = (value: string, absolute = false): string =>
  formatExactDecimal(value, { absolute })

const fmtMult = (n: number): string => `${n.toFixed(2).replace(/\.?0+$/, '')}x`
const shortId = (d: string): string => `${d.slice(0, 6)}…${d.slice(-4)}`

const fmtPrice = (s?: string): string => {
  if (!s) return '—'
  const n = parseFloat(s)
  if (!Number.isFinite(n)) return '—'
  const d = n >= 1 ? 2 : 6
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d })}`
}
const fmtTime = (iso?: string): string => (iso ? new Date(iso).toLocaleString() : '—')

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

function HistoryPage() {
  const [filter, setFilter] = useState<Filter>('all')
  const q = useQuery({ queryKey: ['plays', 'history'], queryFn: () => api.plays({ limit: 50 }) })

  const rows = (q.data?.plays ?? [])
    .filter((p) => SHOWN.has(p.status))
    .filter((p) => filter === 'all' || p.game === filter)

  return (
    <MenuScreen title="History">
      <div className="flex flex-col gap-4">
        <div className="flex gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => {
                haptic('selection')
                setFilter(f.key)
              }}
              className={cnm(
                'rounded-full px-4 py-2 text-xs font-extrabold uppercase tracking-wide transition-colors',
                filter === f.key ? 'bg-white/[0.92] text-black' : 'surface-skeuo text-text-2',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        {q.isLoading ? (
          <div className="flex flex-col gap-2.5">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="shimmer h-[72px] w-full rounded-card" />
            ))}
          </div>
        ) : q.isError ? (
          <ScreenError message="Could not load your history." onRetry={() => void q.refetch()} />
        ) : rows.length === 0 ? (
          <ScreenEmpty illo="vault" title="No plays yet" sub="Your settled rounds show up here, with the full detail and a link to each one on-chain." />
        ) : (
          <div className="flex flex-col gap-2.5">
            {rows.map((p) => (
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
      'Realized P&L',
      `${parseFloat(play.pnl) >= 0 ? '+' : '-'}$${money(play.pnl, true)}`,
    ],
    ['Opened', fmtTime(play.openedAt)],
    ['Settled', fmtTime(play.settledAt)],
  )
  return rows
}

function HistoryRow({ play }: { play: PlayDTO }) {
  const [open, setOpen] = useState(false)
  const pnl = parseFloat(play.pnl ?? '0')
  const positive = play.status === 'won' || (play.status === 'cashed_out' && pnl > 0)
  const label = play.status === 'won' ? 'Won' : play.status === 'cashed_out' ? 'Cashed' : 'Lost'
  const { asset, line } = headOf(play)

  return (
    <div className="surface-skeuo rounded-card">
      <button
        type="button"
        onClick={() => {
          haptic('selection')
          setOpen((o) => !o)
        }}
        className="flex w-full items-start justify-between gap-3 p-4 text-left transition-transform active:scale-[0.99]"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-bold capitalize">{play.game}</span>
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-text-2">{asset}</span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-[13px] text-text-2">
            <span>{line}</span>
            <span className="text-text-3">·</span>
            <span>Cost ${money(play.entryValue)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-start gap-2">
          <div className="text-right">
            <div className={cnm('text-[11px] font-bold uppercase tracking-wide', positive ? 'text-up' : 'text-down')}>{label}</div>
            <div className={cnm('tnum text-[17px] font-extrabold leading-tight', pnl >= 0 ? 'text-up' : 'text-down')}>
              {pnl >= 0 ? '+' : '-'}${money(play.pnl, true)}
            </div>
            <div className="mt-0.5 text-[11px] text-text-3">{timeAgo(play.settledAt ?? play.openedAt)}</div>
          </div>
          <ChevronDown className={cnm('mt-0.5 h-5 w-5 shrink-0 text-text-3 transition-transform', open && 'rotate-180')} strokeWidth={2.4} />
        </div>
      </button>

      {open && (
        <div className="border-t border-white/[0.06] px-4 pb-4 pt-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
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
  )
}

// One labelled explorer link row (a tx digest or an object id), styled like the readout rows.
function LinkRow({ label, id, href }: { label: string; id: string; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={() => haptic('selection')}
      className="flex items-center justify-between gap-2 rounded-xl bg-white/[0.04] px-3 py-2 transition-colors active:bg-white/[0.08]"
    >
      <span className="font-mono text-[11px] uppercase tracking-wide text-text-3">{label}</span>
      <span className="flex items-center gap-1.5 font-mono text-[12px] text-text">
        {shortId(id)}
        <ExternalLink className="h-3.5 w-3.5 text-text-3" strokeWidth={2.4} />
      </span>
    </a>
  )
}
