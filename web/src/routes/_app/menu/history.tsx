import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ExternalLink, Loader2, Share2, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MenuScreen, ScreenEmpty, ScreenError } from '@/components/menu/shared'
import { api, type Game, type LuckyParams, type PlayDTO, type RangeParams } from '@/lib/api'
import { explorerObjectUrl, explorerTxUrl, NETWORK } from '@/lib/sui/config'
import { haptic } from '@/lib/haptics'
import { HapticOverlay } from '@/components/HapticOverlay'
import { Modal, useOverlayState } from '@/ui/Modal'
import { Switch } from '@/ui/Switch'
import { renderPlayCard, sharePlayCard } from '@/lib/playCard'
import { cnm } from '@/utils/style'
import { formatExactDecimal } from '@/utils/format'

// Full play history, the canonical record (in-game overlays are just a glance). Tap a row to expand
// duration, entry/exit, target, cost, payout, oracle, and tx links. Settled rounds only, newest first.
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
  // "Show devnet" defaults on so a returning player's full pre-cutover history stays visible; off narrows to
  // the live network. The toggle only surfaces once we've actually seen a devnet row, so a fresh testnet-only
  // account never sees it. everDevnet latches true and never flips back, so narrowing can't hide the control.
  const [showDevnet, setShowDevnet] = useState(true)
  const [everDevnet, setEverDevnet] = useState(false)
  const q = useQuery({
    queryKey: ['plays', 'history', showDevnet],
    queryFn: () => api.plays({ limit: 50, network: showDevnet ? undefined : NETWORK }),
  })

  useEffect(() => {
    if (!everDevnet && (q.data?.plays ?? []).some((p) => p.network === 'devnet')) setEverDevnet(true)
  }, [q.data, everDevnet])

  const rows = (q.data?.plays ?? [])
    .filter((p) => SHOWN.has(p.status))
    .filter((p) => filter === 'all' || p.game === filter)

  return (
    <MenuScreen title="History">
      <div className="flex flex-col gap-4">
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
                  'pointer-events-none rounded-full px-4 py-2 text-xs font-extrabold uppercase tracking-wide transition-colors',
                  filter === f.key ? 'bg-white/[0.92] text-black' : 'surface-skeuo text-text-2',
                )}
              >
                {f.label}
              </button>
              <HapticOverlay
                className="absolute inset-0 rounded-full"
                preset="selection"
                silent
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
            <Switch
              label="Show devnet history"
              isSelected={showDevnet}
              onChange={(v) => {
                haptic('selection')
                setShowDevnet(v)
              }}
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
  const share = useOverlayState()
  const pnl = parseFloat(play.pnl ?? '0')
  const positive = play.status === 'won' || (play.status === 'cashed_out' && pnl > 0)
  const label = play.status === 'won' ? 'Won' : play.status === 'cashed_out' ? 'Cashed' : 'Lost'
  const { asset, line } = headOf(play)

  return (
    <div className="surface-skeuo rounded-card">
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            haptic('selection')
            setOpen((o) => !o)
          }}
          className="pointer-events-none flex w-full items-start justify-between gap-3 p-4 text-left transition-transform active:scale-[0.99]"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
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
        <HapticOverlay className="absolute inset-0" preset="selection" silent onTap={() => setOpen((o) => !o)} />
      </div>

      {open && (
        <div className="border-t border-white/[0.06] px-4 pb-4 pt-3">
          {/* Turn any settled round into a shareable 16:9 P&L card. */}
          <div className="relative mb-3">
            <button
              type="button"
              className="pointer-events-none flex w-full items-center justify-center gap-2 rounded-xl bg-white/[0.06] py-2.5 text-[13px] font-extrabold uppercase tracking-wide text-text transition-colors active:bg-white/[0.1]"
            >
              <Share2 className="h-[15px] w-[15px]" strokeWidth={2.6} />
              Share P&L card
            </button>
            <HapticOverlay className="absolute inset-0 rounded-xl" preset="medium" silent onTap={() => share.open()} />
          </div>

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

      <PlayShareModal play={play} isOpen={share.isOpen} onOpenChange={share.setOpen} />
    </div>
  )
}

// The share sheet: a live preview of the exported PNG and one Share button (native sheet, download fallback).
function PlayShareModal({ play, isOpen, onOpenChange }: { play: PlayDTO; isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)
  // Dollar P&L is private for a lot of people, so it's opt-in. The ROI % always shows.
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
    haptic('medium')
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
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="md" placement="center" className="border border-line bg-[#161615]">
      {/* Own header (matches the referrals modal): app-style Gabarito heading + a top-right close button. */}
      <button
        type="button"
        onClick={() => onOpenChange(false)}
        aria-label="Close"
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.06] text-white/70 transition-transform active:scale-90"
      >
        <X className="h-[18px] w-[18px]" strokeWidth={2.6} />
      </button>
      <h2 className="pr-10 font-sans text-[22px] font-black leading-none text-white">Share P&L</h2>
      <p className="mt-2 text-[14px] leading-snug text-text-3">Turn this play into a card to share.</p>

      <div className="mt-5 flex flex-col gap-4 pb-1">
        <div className="relative aspect-[16/9] w-full overflow-hidden rounded-md bg-black/50 ring-1 ring-white/10">
          {url ? (
            <img src={url} alt="Your play as a shareable card" className="h-full w-full object-contain" />
          ) : (
            <div className="absolute inset-0 grid place-items-center">
              <Loader2 className="h-5 w-5 animate-spin text-white/50" strokeWidth={2.6} />
            </div>
          )}
        </div>

        {/* The one knob: the dollar P&L is private for a lot of people. ROI % stays on either way. */}
        <div className="surface-skeuo flex items-center gap-3 rounded-card px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-bold text-white">Show P&L value</div>
            <div className="mt-0.5 text-[12px] leading-snug text-text-3">Your net dollar profit on the card.</div>
          </div>
          <Switch
            label="Show P&L value"
            isSelected={showPnl}
            onChange={(v) => {
              haptic('selection')
              setShowPnl(v)
            }}
          />
        </div>

        <div className="relative">
          <button
            type="button"
            disabled={sharing}
            className="btn-primary pointer-events-none flex w-full items-center justify-center gap-2 rounded-md py-3.5 text-[15px] font-extrabold uppercase tracking-wide disabled:opacity-70"
          >
            {sharing ? <Loader2 className="h-[18px] w-[18px] animate-spin" strokeWidth={2.6} /> : <Share2 className="h-[18px] w-[18px]" strokeWidth={2.6} />}
            {sharing ? 'Making your card' : 'Share card'}
          </button>
          <HapticOverlay className="absolute inset-0 rounded-md" preset="medium" disabled={sharing} silent onTap={() => void doShare()} />
        </div>
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
