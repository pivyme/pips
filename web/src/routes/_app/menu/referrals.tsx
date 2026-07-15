import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import toast from 'react-hot-toast'
import { MenuScreen, ScreenEmpty, ScreenError } from '@/components/menu/shared'
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

  // A user with no username can't use the username format, no matter what the server has stored:
  // fold that into one effective flag so the link, the picker's checkmark, and buildReferralLink's
  // own fallback all agree instead of the picker showing "Use My Username" as selected-but-disabled
  // while the link above it is actually the anon one.
  const effectiveAnon = info ? info.anon || !hasUsername : false
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
    if (savingAnon || !info || info.anon === anon || (!anon && !hasUsername)) return
    haptic('selection')
    setSavingAnon(true)
    try {
      await api.setReferralAnon(anon)
      await q.refetch()
    } catch {
      toast.error('Could not update your link', { id: 'referral-format' })
    } finally {
      setSavingAnon(false)
    }
  }

  return (
    <MenuScreen title="My Referrals">
      <div className="flex flex-col gap-5">
        <p className="px-1 text-[15px] leading-snug text-text-2">
          Share your link. Invite friends, track your crew.
        </p>

        {q.isLoading ? (
          <div className="shimmer h-[168px] rounded-card" />
        ) : q.isError || !info ? (
          <ScreenError message="Could not load your referral link." onRetry={() => void q.refetch()} />
        ) : (
          <>
            <div className="card-neo rounded-card p-5">
              <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">Your link</span>
              <button
                onClick={copy}
                className="surface-skeuo mt-3 flex items-center gap-3 rounded-card p-4 text-left transition-transform active:scale-[0.99]"
              >
                <span className="tnum min-w-0 flex-1 break-all text-[13px] leading-snug text-text-2">{link}</span>
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-text">
                  {copied ? <Check className="h-5 w-5 text-up" strokeWidth={2.6} /> : <Copy className="h-5 w-5" strokeWidth={2.4} />}
                </span>
              </button>
            </div>

            <div className="flex flex-col gap-2">
              <span className="px-1 text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">Link format</span>
              <FormatRow
                label="Use My Username"
                sub={hasUsername ? `playpips.fun/@${info.username}` : 'Set a username to use this'}
                selected={!effectiveAnon}
                disabled={!hasUsername || savingAnon}
                onTap={() => void setFormat(false)}
              />
              <FormatRow
                label="Anonymous"
                sub="playpips.fun/r/CODE"
                selected={effectiveAnon}
                disabled={savingAnon}
                onTap={() => void setFormat(true)}
              />
            </div>

            <div className="flex flex-col gap-2">
              <span className="px-1 text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">
                Your crew{info.count > 0 ? ` · ${info.count}` : ''}
              </span>
              {info.referrals.length === 0 ? (
                <ScreenEmpty illo="gift" title="No referrals yet" sub="Share your referral link to get started!" />
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
          <div className="text-[15px] font-bold">{label}</div>
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
