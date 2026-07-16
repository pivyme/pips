import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Check, Copy, MoreHorizontal, X } from 'lucide-react'
import toast from 'react-hot-toast'
import { MenuScreen, ScreenError } from '@/components/menu/shared'
import { Modal, useOverlayState } from '@/ui/Modal'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { buildReferralLink } from '@/lib/referral'
import { haptic } from '@/lib/haptics'
import { HapticOverlay } from '@/components/HapticOverlay'
import { cnm } from '@/utils/style'

// Track-only referrals: your link, a format toggle, who joined through it. No payout (see
// .claude/REFERRALS.md), so this is purely "invite friends, see your crew," never "earn."
export const Route = createFileRoute('/_app/menu/referrals')({ component: ReferralsScreen })

function ReferralsScreen() {
  const { user } = useAuth()
  const q = useQuery({ queryKey: ['referral'], queryFn: () => api.referral() })
  const info = q.data
  const hasUsername = Boolean(user?.username)

  const [copied, setCopied] = useState(false)
  const [savingAnon, setSavingAnon] = useState(false)
  // Optimistic pick: the checkmark and link snap the instant you tap, the server call follows. Null
  // = no pending pick, defer to the server's stored value.
  const [pendingAnon, setPendingAnon] = useState<boolean | null>(null)
  const fmt = useOverlayState()

  // A user with no username can't use the username format, no matter what the server has stored:
  // fold that into one effective flag so the link, the picker's checkmark, and buildReferralLink's
  // own fallback all agree instead of the picker showing "Use My Username" as selected-but-disabled
  // while the link above it is actually the anon one.
  const effectiveAnon = (pendingAnon ?? info?.anon ?? false) || !hasUsername
  const link = info ? buildReferralLink({ code: info.code, anon: effectiveAnon, username: info.username }) : ''

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

  const setFormat = async (anon: boolean) => {
    if (savingAnon || !info || effectiveAnon === anon || (!anon && !hasUsername)) return
    haptic('selection')
    setPendingAnon(anon) // check + link snap now, no waiting on the server
    setSavingAnon(true)
    // Let the checkmark land, then animate the sheet out. The server write keeps going underneath.
    setTimeout(() => fmt.close(), 260)
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
    <MenuScreen title="My Referrals">
      <div className="flex flex-col gap-6">
        <p className="px-1 text-[15px] leading-snug text-text-2">
          Share your link. Invite friends, track your crew.
        </p>

        {q.isLoading ? (
          <div className="shimmer h-[172px] rounded-card" />
        ) : q.isError || !info ? (
          <ScreenError message="Could not load your referral link." onRetry={() => void q.refetch()} />
        ) : (
          <>
            {/* The link is the whole point of this screen: full-width hero with the amber inner glow,
                the link in a bright pill you tap to copy, and format tucked behind the 3-dot. */}
            <div
              className="rounded-card border border-brand-500/25 p-5"
              style={{
                background: 'linear-gradient(180deg,#1c1810 0%,#141109 56%,#0c0a05 100%)',
                boxShadow:
                  'inset 0 0 64px rgba(255,192,22,0.20), inset 0 1px 0 rgba(255,224,138,0.22), inset 0 0 0 1px rgba(255,192,22,0.10), 0 22px 44px -30px rgba(0,0,0,0.95)',
              }}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-[21px] font-black leading-none text-white">My Referral Link</span>
                <button
                  type="button"
                  onClick={() => {
                    haptic('selection')
                    fmt.open()
                  }}
                  aria-label="Link format"
                  className="-mr-1.5 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-white/70 transition-transform active:scale-90"
                >
                  <MoreHorizontal className="h-5 w-5" strokeWidth={2.6} />
                </button>
              </div>

              <button
                onClick={copy}
                className="mt-4 flex w-full items-center gap-2 rounded-full border border-white/[0.14] bg-white/[0.07] py-3 pl-5 pr-2.5 text-left transition-transform active:scale-[0.99]"
              >
                <span className="tnum min-w-0 flex-1 truncate text-[15px] font-semibold text-white/90">{link}</span>
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/70">
                  {copied ? (
                    <Check className="h-[18px] w-[18px] text-up" strokeWidth={2.8} />
                  ) : (
                    <Copy className="h-[18px] w-[18px]" strokeWidth={2.4} />
                  )}
                </span>
              </button>
            </div>

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
                    <div key={`${r.handle}-${i}`} className="surface-skeuo flex items-center justify-between rounded-card p-4">
                      <div className="min-w-0">
                        <div className="truncate text-[15px] font-bold">{r.handle}</div>
                        <div className="text-sm text-text-3">Joined {new Date(r.joinedAt).toLocaleDateString()}</div>
                      </div>
                      <div className="tnum shrink-0 text-[15px] font-bold text-text-2">{r.plays} plays</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
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
