import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDownLeft, ArrowUpRight, ChevronRight, Copy, ExternalLink, X } from 'lucide-react'
import toast from 'react-hot-toast'
import { MenuScreen, ScreenEmpty, ScreenError } from '@/components/menu/shared'
import { CoinLogo } from '@/components/menu/deposit/CoinLogo'
import { HapticOverlay } from '@/components/HapticOverlay'
import { Modal, useOverlayState } from '@/ui/Modal'
import { api } from '@/lib/api'
import type { WalletTxDTO } from '@/lib/api'
import { walletTransactionsQuery } from '@/lib/menuQueries'
import { haptic } from '@/lib/haptics'
import { cnm } from '@/utils/style'
import { NETWORK } from '@/lib/sui/config'

// The wallet activity feed: deposits, sends, faucet/grant top-ups, and bridge landings, grouped by day.
// App Surface language (rounded skeuo rows), NOT the in-device screen language. Polls while open so a fresh
// receive appears on its own; a row opens a centered detail modal (amount, hash, explorer link), not the scanner.
export const Route = createFileRoute('/_app/menu/transactions')({
  component: () => (
    <MenuScreen title="Wallet Activity">
      <ActivityFeed />
    </MenuScreen>
  ),
})

const CHAIN_LABEL: Record<string, string> = {
  sui: NETWORK === 'testnet' ? 'Sui Testnet' : 'Sui',
  base: 'Base',
  arbitrum: 'Arbitrum',
  ethereum: 'Ethereum',
  solana: 'Solana',
}

const kindTitle = (r: WalletTxDTO): string => {
  switch (r.kind) {
    case 'send':
      return 'Sent'
    case 'faucet':
      return 'Faucet'
    case 'grant':
      return 'Bonus'
    case 'bridge':
      return 'Bridged'
    default:
      return 'Received'
  }
}

// The feed body for the Wallet Activity page.
function ActivityFeed() {
  const q = useQuery({ ...walletTransactionsQuery(), refetchInterval: 8000 })
  // Page 1 is the reactive (polled) query; older pages are loaded once and appended locally.
  const [more, setMore] = useState<WalletTxDTO[]>([])
  const [moreCursor, setMoreCursor] = useState<string | null | undefined>(undefined) // undefined = not paged yet
  const [loadingMore, setLoadingMore] = useState(false)

  const nextCursor = moreCursor === undefined ? (q.data?.nextCursor ?? null) : moreCursor

  // Merge page 1 + appended pages, deduped by id (a poll refetch of page 1 overlaps with the loaded tail).
  const all = useMemo(() => {
    const seen = new Set<string>()
    const out: WalletTxDTO[] = []
    for (const r of [...(q.data?.transactions ?? []), ...more]) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      out.push(r)
    }
    return out
  }, [q.data, more])

  const groups = useMemo(() => groupByDay(all), [all])

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    haptic('selection')
    try {
      const res = await api.walletTransactions({ cursor: nextCursor, limit: 50 })
      setMore((m) => [...m, ...res.transactions])
      setMoreCursor(res.nextCursor)
    } catch {
      // leave the button; a retry re-fires
    } finally {
      setLoadingMore(false)
    }
  }

  return q.isLoading ? (
    <FeedSkeleton />
  ) : q.isError ? (
    <ScreenError message="Could not load your activity." onRetry={() => void q.refetch()} />
  ) : all.length === 0 ? (
    <ScreenEmpty title="No activity yet" sub="Deposits and sends show up here." />
  ) : (
    <div className="flex flex-col gap-6 pb-4">
      {groups.map((g) => (
        <section key={g.label} className="flex flex-col gap-2">
          <div className="px-1 text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">{g.label}</div>
          <div className="flex flex-col gap-2">
            {g.rows.map((r) => (
              <ActivityRow key={r.id} row={r} />
            ))}
          </div>
        </section>
      ))}
      {nextCursor && (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          className="surface-skeuo mx-auto mt-1 rounded-full px-5 py-2.5 text-[13px] font-bold text-text-2 transition-transform active:scale-95 disabled:opacity-60"
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}

function ActivityRow({ row }: { row: WalletTxDTO }) {
  const detail = useOverlayState()
  const isIn = row.direction === 'in'
  const pending = row.status === 'pending'
  const sub =
    row.kind === 'bridge'
      ? `${CHAIN_LABEL[row.chain] ?? row.chain} → Sui`
      : timeAgo(Number(row.timestampMs))

  return (
    <div className="relative">
      <button
        type="button"
        className="pointer-events-none surface-skeuo flex w-full items-center gap-3 rounded-card p-3.5 text-left transition-transform active:scale-[0.99]"
      >
        {/* Direction glyph in a tinted circle, with the coin logo as a small badge. */}
        <div className="relative shrink-0">
          <span
            className={cnm(
              'flex h-10 w-10 items-center justify-center rounded-full',
              isIn ? 'bg-up/15 text-up' : 'bg-white/[0.07] text-text-2',
            )}
          >
            {isIn ? <ArrowDownLeft className="h-5 w-5" strokeWidth={2.6} /> : <ArrowUpRight className="h-5 w-5" strokeWidth={2.6} />}
          </span>
          <CoinLogo
            src={row.logo}
            name={row.symbol ?? '?'}
            size={18}
            className="absolute -bottom-0.5 -right-0.5 ring-2 ring-[#0e0e0e]"
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[15px] font-bold">{kindTitle(row)}</span>
            {pending && (
              <span className="rounded-full bg-brand-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-500">
                Pending
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[12px] text-text-3">{sub}</div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <span className={cnm('tnum text-[15px] font-extrabold', isIn ? 'text-up' : 'text-text')}>
            {isIn ? '+' : '-'}
            {row.amount} {row.symbol ?? ''}
          </span>
          <ChevronRight className="h-4 w-4 text-text-3" strokeWidth={2.4} />
        </div>
      </button>
      <HapticOverlay className="absolute inset-0 rounded-card" preset="selection" silent onTap={() => detail.open()} />

      <TxDetailModal row={row} isOpen={detail.isOpen} onOpenChange={detail.setOpen} />
    </div>
  )
}

// The detail modal: full tx info (amount, status, network, from/to, tx hash) with copy + an explorer button,
// so a tap reads the movement without leaving the app. Uses the shared centered Modal, same shell as the
// play-history detail / Share PnL modals.
function TxDetailModal({ row, isOpen, onOpenChange }: { row: WalletTxDTO; isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const isIn = row.direction === 'in'
  const network =
    row.kind === 'bridge' ? `${CHAIN_LABEL[row.chain] ?? row.chain} → Sui` : CHAIN_LABEL[row.chain] ?? row.chain
  const when = new Date(Number(row.timestampMs)).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  const copy = (label: string, value: string) => {
    if (!value) return
    haptic('success')
    void navigator.clipboard
      ?.writeText(value)
      .then(() => toast.success(`${label} copied`, { id: 'tx-copy' }))
      .catch(() => {})
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="md" placement="center" className="border border-line bg-[#161615]">
      <button
        type="button"
        onClick={() => onOpenChange(false)}
        aria-label="Close"
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.06] text-white/70 transition-transform active:scale-90"
      >
        <X className="h-[18px] w-[18px]" strokeWidth={2.6} />
      </button>

      {/* Header: glyph + coin badge, kind + time, signed amount hero. */}
      <div className="flex items-center gap-3 pr-10">
        <div className="relative shrink-0">
          <span
            className={cnm(
              'flex h-12 w-12 items-center justify-center rounded-full',
              isIn ? 'bg-up/15 text-up' : 'bg-white/[0.07] text-text-2',
            )}
          >
            {isIn ? <ArrowDownLeft className="h-6 w-6" strokeWidth={2.6} /> : <ArrowUpRight className="h-6 w-6" strokeWidth={2.6} />}
          </span>
          <CoinLogo
            src={row.logo}
            name={row.symbol ?? '?'}
            size={20}
            className="absolute -bottom-0.5 -right-0.5 ring-2 ring-[#161615]"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-extrabold">{kindTitle(row)}</div>
          <div className="mt-0.5 text-[12px] text-text-3">{when}</div>
        </div>
      </div>

      <div className={cnm('tnum mt-4 text-[32px] font-black leading-none', isIn ? 'text-up' : 'text-text')}>
        {isIn ? '+' : '-'}
        {row.amount} {row.symbol ?? ''}
      </div>

      {/* Fields. */}
      <div className="mt-5 flex flex-col divide-y divide-white/[0.06] rounded-2xl bg-white/[0.03] px-4">
        <Field
          label="Status"
          value={row.status === 'pending' ? 'Pending' : 'Confirmed'}
          valueClass={row.status === 'pending' ? 'text-brand-400' : 'text-up'}
        />
        <Field label="Network" value={network} />
        {row.counterparty && (
          <Field label={isIn ? 'From' : 'To'} value={shorten(row.counterparty)} onCopy={() => copy('Address', row.counterparty!)} />
        )}
        {row.digest && <Field label="Transaction" value={shorten(row.digest)} onCopy={() => copy('Tx hash', row.digest)} />}
      </div>

      {/* Explorer link, the one action worth surfacing (backdrop / X handle dismissal). */}
      {row.explorerUrl && (
        <a
          href={row.explorerUrl}
          target="_blank"
          rel="noreferrer"
          onClick={() => haptic('selection')}
          className="mt-5 flex h-12 items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.05] text-[14px] font-bold text-text transition-transform active:scale-[0.99]"
        >
          <ExternalLink className="h-4 w-4" strokeWidth={2.4} /> View on explorer
        </a>
      )}
    </Modal>
  )
}

function Field({ label, value, valueClass, onCopy }: { label: string; value: string; valueClass?: string; onCopy?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <span className="text-[13px] text-text-3">{label}</span>
      {onCopy ? (
        <button onClick={onCopy} className="flex items-center gap-1.5 transition-transform active:scale-95">
          <span className={cnm('tnum text-[13px] font-semibold text-text', valueClass)}>{value}</span>
          <Copy className="h-3.5 w-3.5 text-text-3" strokeWidth={2.2} />
        </button>
      ) : (
        <span className={cnm('text-[13px] font-semibold text-text', valueClass)}>{value}</span>
      )}
    </div>
  )
}

// Head…tail elision for an address / digest, so the modal shows a copyable short form.
const shorten = (s: string, head = 8, tail = 8): string => (s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s)

function FeedSkeleton() {
  return (
    <div className="flex flex-col gap-2 pt-2">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="surface-skeuo flex items-center gap-3 rounded-card p-3.5">
          <div className="shimmer h-10 w-10 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="shimmer h-3.5 w-28 rounded" />
            <div className="shimmer h-3 w-16 rounded" />
          </div>
          <div className="shimmer h-4 w-14 shrink-0 rounded" />
        </div>
      ))}
    </div>
  )
}

// Group a newest-first list into day sections (Today / Yesterday / a short date).
function groupByDay(rows: WalletTxDTO[]): { label: string; rows: WalletTxDTO[] }[] {
  const out: { label: string; rows: WalletTxDTO[] }[] = []
  for (const r of rows) {
    const label = dayLabel(Number(r.timestampMs))
    const last = out[out.length - 1]
    if (last && last.label === label) last.rows.push(r)
    else out.push({ label, rows: [r] })
  }
  return out
}

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

function dayLabel(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(d, now)) return 'Today'
  if (sameDay(d, yesterday)) return 'Yesterday'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
}

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
