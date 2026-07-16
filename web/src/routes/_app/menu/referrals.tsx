import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Check, Coins, Copy, ExternalLink, MoreHorizontal, X } from 'lucide-react'
import toast from 'react-hot-toast'
import { MenuScreen, ScreenError } from '@/components/menu/shared'
import { Modal, useOverlayState } from '@/ui/Modal'
import { api, ApiError, type ReferralClaimDTO } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { buildReferralLink } from '@/lib/referral'
import { explorerTxUrl } from '@/lib/sui/config'
import { haptic } from '@/lib/haptics'
import { HapticOverlay } from '@/components/HapticOverlay'
import { formatStringToNumericDecimals } from '@/utils/format'
import { cnm } from '@/utils/style'

// Referrals + revenue share: your link, who joined, and 25% of their trading fees, earned forever and
// claimed into chips (.claude/REVENUE_SHARING.md). Never surface the underlying fee rate, only the 25% share.
export const Route = createFileRoute('/_app/menu/referrals')({ component: ReferralsScreen })

// DUSDC string -> "$1,234.50", exact, no float. The API already returns >= 2dp.
const usd = (s: string): string => `$${formatStringToNumericDecimals(s || '0', 2)}`

function ReferralsScreen() {
  const { user, refresh } = useAuth()
  const q = useQuery({ queryKey: ['referral'], queryFn: () => api.referral() })
  const info = q.data
  const hasUsername = Boolean(user?.username)

  const [copied, setCopied] = useState(false)
  const [claiming, setClaiming] = useState(false)
  const [savingAnon, setSavingAnon] = useState(false)
  // Optimistic pick: the checkmark and link snap the instant you tap, the server call follows. Null
  // = no pending pick, defer to the server's stored value.
  const [pendingAnon, setPendingAnon] = useState<boolean | null>(null)
  const fmt = useOverlayState()

  // A user with no username can't use the username format, no matter what the server has stored: fold
  // that into one effective flag so the link, the picker's checkmark, and buildReferralLink all agree.
  const effectiveAnon = (pendingAnon ?? info?.anon ?? false) || !hasUsername
  const link = info ? buildReferralLink({ code: info.code, anon: effectiveAnon, username: info.username }) : ''

  const claimable = Number(info?.claimable ?? '0')
  const minClaim = Number(info?.minClaim ?? '1')
  const canClaim = Boolean(info) && claimable >= minClaim

  const copy = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      haptic('success')
      toast.success('Link copied', { id: 'copy-referral' })
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Could not copy the link', { id: 'copy-referral' })
    }
  }

  const claim = async () => {
    if (claiming || !canClaim || !info) return
    setClaiming(true)
    try {
      const amount = info.claimable
      await api.claimReferral()
      await refresh() // the chips just landed in the balance
      await q.refetch() // claimable drops, a new paid row joins the history
      haptic('success')
      toast.success(`Claimed ${usd(amount)}`, { id: 'referral-claim' })
    } catch (e) {
      haptic('error')
      toast.error(e instanceof ApiError ? e.message : 'Could not claim your rewards', { id: 'referral-claim' })
    } finally {
      setClaiming(false)
    }
  }

  const setFormat = async (anon: boolean) => {
    if (savingAnon || !info || effectiveAnon === anon || (!anon && !hasUsername)) return
    haptic('selection')
    setPendingAnon(anon) // check + link snap now, no waiting on the server
    setSavingAnon(true)
    setTimeout(() => fmt.close(), 260) // let the checkmark land, then animate the sheet out
    try {
      await api.setReferralAnon(anon)
      await q.refetch()
      setPendingAnon(null) // server is now source of truth (and matches the pick)
    } catch {
      setPendingAnon(null) // revert the optimistic pick
      toast.error('Could not update your link', { id: 'referral-format' })
    } finally {
      setSavingAnon(false)
    }
  }

  return (
    <MenuScreen title="Referrals">
      <div className="flex flex-col gap-6">
        <p className="px-1 text-[15px] leading-snug text-text-2">
          Invite friends and earn <span className="font-bold text-brand-400">25%</span> of their trading
          fees, forever. Paid to you as chips you can play or cash out.
        </p>

        {q.isLoading ? (
          <div className="flex flex-col gap-6">
            <div className="shimmer h-[228px] rounded-card" />
            <div className="shimmer h-[132px] rounded-card" />
          </div>
        ) : q.isError || !info ? (
          <ScreenError message="Could not load your referrals." onRetry={() => void q.refetch()} />
        ) : (
          <>
            {/* Earnings hero: the money moment. Amber inner glow, the claimable balance big and bright,
                a Claim button, then a summary strip of friends / earned / claimed. */}
            <div
              className="rounded-card border border-brand-500/25 p-5"
              style={{
                background: 'linear-gradient(180deg,#1c1810 0%,#141109 56%,#0c0a05 100%)',
                boxShadow:
                  'inset 0 0 64px rgba(255,192,22,0.20), inset 0 1px 0 rgba(255,224,138,0.22), inset 0 0 0 1px rgba(255,192,22,0.10), 0 22px 44px -30px rgba(0,0,0,0.95)',
              }}
            >
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-brand-300/80">
                  Claimable rewards
                </span>
              </div>
              <div className="mt-2 flex items-end justify-between gap-3">
                <div className="tnum text-[46px] font-black leading-none text-white">{usd(info.claimable)}</div>
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-brand-400 ring-1 ring-brand-500/25">
                  <Coins className="h-6 w-6" strokeWidth={2.4} />
                </div>
              </div>
              <p className="mt-2 text-[13px] leading-snug text-brand-300/70">
                25% of your referrals&apos; trading fees.
              </p>

              {/* Claim button, faucet-claim pattern: HapticOverlay drives the tap so it feels physical. */}
              <div className="relative mt-4">
                <button
                  type="button"
                  disabled={!canClaim || claiming}
                  className={cnm(
                    'pointer-events-none flex h-[52px] w-full items-center justify-center gap-2 rounded-2xl text-[16px] font-bold transition-transform active:scale-[0.99]',
                    canClaim
                      ? 'bg-brand-500 text-black shadow-[0_10px_28px_-12px_rgba(255,192,22,0.7)]'
                      : 'bg-white/[0.06] text-white/40',
                  )}
                >
                  <Coins className="h-[18px] w-[18px]" strokeWidth={2.6} />
                  {claiming ? 'Claiming…' : canClaim ? `Claim ${usd(info.claimable)}` : 'Claim'}
                </button>
                <HapticOverlay
                  className="absolute inset-0 rounded-2xl"
                  preset="success"
                  disabled={!canClaim || claiming}
                  onTap={claim}
                />
              </div>
              {!canClaim && (
                <p className="mt-2.5 text-center text-[13px] leading-snug text-brand-300/60">
                  {claimable > 0
                    ? `${usd(info.claimable)} so far. Reach ${usd(info.minClaim)} to claim.`
                    : `Earn ${usd(info.minClaim)} to make your first claim.`}
                </p>
              )}

              {/* Summary strip: friends brought in, lifetime earned, lifetime claimed. */}
              <div className="mt-5 grid grid-cols-3 divide-x divide-white/[0.08] overflow-hidden rounded-xl border border-white/[0.06] bg-black/30">
                <SummaryCell label="Friends" value={String(info.count)} />
                <SummaryCell label="Earned" value={usd(info.totalEarned)} gold />
                <SummaryCell label="Claimed" value={usd(info.totalClaimed)} />
              </div>
            </div>

            {/* The invite link: a highlighted amber-bezeled slot (thick yellow border + skeuo bevel), so
                the share action reads as a physical control, not a flat card. */}
            <div
              className="rounded-card border-2 border-brand-500/55 p-5"
              style={{
                background: 'linear-gradient(180deg,#17140d 0%,#100d08 60%,#0b0906 100%)',
                boxShadow:
                  'inset 0 1px 0 rgba(255,224,138,0.20), inset 0 0 0 1px rgba(255,192,22,0.08), inset 0 -12px 40px -24px rgba(255,192,22,0.22), 0 14px 34px -22px rgba(0,0,0,0.95)',
              }}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-[17px] font-black leading-none text-white">Your invite link</span>
                <button
                  type="button"
                  onClick={() => {
                    haptic('selection')
                    fmt.open()
                  }}
                  aria-label="Link format"
                  className="-mr-1.5 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-500/12 text-brand-300 ring-1 ring-brand-500/25 transition-transform active:scale-90"
                >
                  <MoreHorizontal className="h-5 w-5" strokeWidth={2.6} />
                </button>
              </div>

              {/* Tap the whole pill to copy. Amber bezel + inner bevel so it pops off the dark slot. */}
              <button
                onClick={copy}
                className="mt-4 flex w-full items-center gap-2 rounded-full border-2 border-brand-500/45 py-3 pl-5 pr-2.5 text-left transition-transform active:scale-[0.99]"
                style={{
                  background: 'linear-gradient(180deg,rgba(255,192,22,0.10) 0%,rgba(255,192,22,0.03) 100%)',
                  boxShadow: 'inset 0 1px 0 rgba(255,224,138,0.22), 0 6px 18px -14px rgba(0,0,0,0.9)',
                }}
              >
                <span className="tnum min-w-0 flex-1 truncate text-[15px] font-bold text-white">{link}</span>
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-brand-300 ring-1 ring-brand-500/25">
                  {copied ? (
                    <Check className="h-[18px] w-[18px] text-up" strokeWidth={2.8} />
                  ) : (
                    <Copy className="h-[18px] w-[18px]" strokeWidth={2.4} />
                  )}
                </span>
              </button>
            </div>

            {/* Who joined, with what each has earned you. */}
            <div className="flex flex-col gap-2">
              <span className="px-1 text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">
                My referrals{info.count > 0 ? ` · ${info.count}` : ''}
              </span>
              {info.referrals.length === 0 ? (
                <div className="surface-skeuo flex flex-col items-center gap-1 rounded-card px-4 py-10 text-center">
                  <div className="text-[15px] font-bold text-text-2">No referrals yet</div>
                  <div className="text-sm text-text-3">Share your link to start earning.</div>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {info.referrals.map((r, i) => (
                    <div key={`${r.handle}-${i}`} className="surface-skeuo flex items-center justify-between gap-3 rounded-card p-4">
                      <div className="min-w-0">
                        <div className="truncate text-[15px] font-bold">{r.handle}</div>
                        <div className="text-sm text-text-3">
                          Joined {new Date(r.joinedAt).toLocaleDateString()} · {r.plays} plays
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="tnum text-[15px] font-extrabold text-brand-400">+{usd(r.earned)}</div>
                        <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-text-3">earned</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Claim history. */}
            {info.claims.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="px-1 text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">Claim history</span>
                <div className="flex flex-col gap-2">
                  {info.claims.map((c) => (
                    <ClaimRow key={c.id} claim={c} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <Modal
        isOpen={fmt.isOpen}
        onOpenChange={fmt.setOpen}
        size="sm"
        placement="center"
        className="border border-line bg-[#161615]"
      >
        {/* Own header (not the wrapper's muted .modal__heading) so it reads like the app's headers. */}
        <button
          type="button"
          onClick={() => fmt.close()}
          aria-label="Close"
          className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.06] text-white/70 transition-transform active:scale-90"
        >
          <X className="h-[18px] w-[18px]" strokeWidth={2.6} />
        </button>
        <h2 className="pr-10 text-[19px] font-black leading-none text-white">Link format</h2>
        <p className="mt-2 text-[15px] leading-snug text-text-3">Pick how your invite link looks.</p>
        <div className="mt-5 flex flex-col gap-2">
          <FormatRow
            label="Use My Username"
            sub={hasUsername ? `playpips.fun/@${info?.username ?? ''}` : 'Set a username to use this'}
            selected={!effectiveAnon}
            disabled={!hasUsername}
            onTap={() => void setFormat(false)}
          />
          <FormatRow
            label="Anonymous"
            sub="playpips.fun/r/CODE"
            selected={effectiveAnon}
            disabled={false}
            onTap={() => void setFormat(true)}
          />
        </div>
      </Modal>
    </MenuScreen>
  )
}

function SummaryCell({ label, value, gold }: { label: string; value: string; gold?: boolean }) {
  return (
    <div className="min-w-0 px-3 py-2.5 text-center">
      <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-white/50">{label}</div>
      <div className={cnm('tnum mt-1 truncate text-[16px] font-extrabold', gold ? 'text-brand-400' : 'text-white')}>
        {value}
      </div>
    </div>
  )
}

// One claim: amount + a status pill (paid green, pending amber "Processing", failed red), the date, and
// a tx-explorer link once the payout landed. Demo digests are placeholders, so they get no dead link.
function ClaimRow({ claim }: { claim: ReferralClaimDTO }) {
  const pill =
    claim.status === 'paid'
      ? { label: 'Paid', cls: 'bg-up/15 text-up' }
      : claim.status === 'pending'
        ? { label: 'Processing', cls: 'bg-brand-500/15 text-brand-400' }
        : { label: 'Failed', cls: 'bg-down/15 text-down' }
  const hasTx = Boolean(claim.txDigest) && !claim.txDigest!.startsWith('demo')

  return (
    <div className="surface-skeuo flex items-center justify-between gap-3 rounded-card p-4">
      <div className="min-w-0">
        <div className="tnum text-[15px] font-extrabold text-white">{usd(claim.amount)}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[13px] text-text-3">
          <span>{new Date(claim.createdAt).toLocaleDateString()}</span>
          {hasTx && (
            <>
              <span className="text-text-3">·</span>
              <a
                href={explorerTxUrl(claim.txDigest!)}
                target="_blank"
                rel="noreferrer"
                onClick={() => haptic('selection')}
                className="inline-flex items-center gap-1 text-text-2 transition-colors active:text-white"
              >
                Receipt
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={2.4} />
              </a>
            </>
          )}
        </div>
      </div>
      <span className={cnm('shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.08em]', pill.cls)}>
        {pill.label}
      </span>
    </div>
  )
}

function FormatRow({
  label,
  sub,
  selected,
  disabled,
  onTap,
}: {
  label: string
  sub: string
  selected: boolean
  disabled: boolean
  onTap: () => void
}) {
  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        className={cnm(
          'surface-skeuo pointer-events-none flex w-full items-center justify-between rounded-card p-4 text-left transition-transform active:scale-[0.99]',
          disabled && 'opacity-50',
        )}
      >
        <div className="min-w-0">
          <div className="text-[16px] font-bold text-white">{label}</div>
          <div className="truncate text-sm text-text-3">{sub}</div>
        </div>
        <span
          className={cnm(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2',
            selected ? 'border-brand-500 bg-brand-500' : 'border-line-strong',
          )}
        >
          {selected && <Check className="h-4 w-4 text-black" strokeWidth={3} />}
        </span>
      </button>
      <HapticOverlay className="absolute inset-0 rounded-card" preset="selection" disabled={disabled} silent onTap={onTap} />
    </div>
  )
}
