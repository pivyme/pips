import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { AtSign } from 'lucide-react'
import { useLinkAccount, usePrivy } from '@privy-io/react-auth'
import type { ReactNode } from 'react'
import type { HapticPreset } from '@/lib/haptics'
import { MenuScreen } from '@/components/menu/shared'
import { GoogleGlyph, XGlyph } from '@/components/menu/BrandGlyphs'
import { HapticOverlay } from '@/components/HapticOverlay'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { PRIVY_ENABLED } from '@/lib/privy'
import { haptic } from '@/lib/haptics'
import { cnm } from '@/utils/style'

// Linked Accounts: Google, Email, X, driven live off the Privy session (link/unlink), with X singled
// out (promo card + verified leaderboard badge). Read-only in dev/demo where no Privy provider is mounted (see StaticLinkedAccounts).
export const Route = createFileRoute('/_app/menu/account')({ component: AccountScreen })

function AccountScreen() {
  return (
    <MenuScreen title="Account Settings">
      {PRIVY_ENABLED ? <LiveLinkedAccounts /> : <StaticLinkedAccounts />}
    </MenuScreen>
  )
}

type Kind = 'google' | 'email' | 'twitter'

function LiveLinkedAccounts() {
  const { refresh } = useAuth()
  const { user: pUser, unlinkGoogle, unlinkEmail, unlinkTwitter } = usePrivy()
  const [busy, setBusy] = useState<Kind | null>(null)

  // The one write path for linked-account state: re-read Privy server-side and persist it, so the leaderboard badge never trusts a client-reported handle.
  const afterChange = async () => {
    try {
      await api.linkRefresh()
      await refresh()
    } catch {
      toast.error('Could not refresh your linked accounts', { id: 'link-refresh-error' })
    }
  }

  const { linkGoogle, linkEmail, linkTwitter } = useLinkAccount({
    onSuccess: () => {
      haptic('success')
      setBusy(null)
      void afterChange()
    },
    onError: (error) => {
      setBusy(null)
      if (error !== 'exited_link_flow') {
        haptic('error')
        toast.error('Could not link that account. Try again.', { id: 'link-error' })
      }
    },
  })

  const START_LINK: Record<Kind, () => void> = { google: linkGoogle, email: linkEmail, twitter: linkTwitter }
  const startLink = (kind: Kind) => {
    haptic('selection')
    setBusy(kind)
    START_LINK[kind]()
  }

  // Bounded to this app's actual login methods (google/email/twitter, see lib/privy.tsx loginMethods), so
  // a plain presence count is enough: never let it drop to 0, that would orphan the login and the embedded wallet.
  const linkedLoginCount = [pUser?.google, pUser?.email, pUser?.twitter].filter(Boolean).length

  const doUnlink = async (kind: Kind) => {
    if (linkedLoginCount <= 1) return
    setBusy(kind)
    haptic('medium')
    try {
      if (kind === 'google' && pUser?.google) await unlinkGoogle(pUser.google.subject)
      else if (kind === 'email' && pUser?.email) await unlinkEmail(pUser.email.address)
      else if (kind === 'twitter' && pUser?.twitter) await unlinkTwitter(pUser.twitter.subject)
      haptic('success')
      await afterChange()
    } catch {
      haptic('error')
      toast.error('Could not unlink. This may be your only way to sign in.', { id: 'unlink-error' })
    } finally {
      setBusy(null)
    }
  }

  const rowAction = (kind: Kind, linked: boolean): ReactNode => {
    if (!linked) return <TapButton label="Link account" busy={busy === kind} onTap={() => startLink(kind)} />
    if (linkedLoginCount > 1) {
      return <TapButton label="Unlink" variant="ghost" preset="medium" busy={busy === kind} onTap={() => void doUnlink(kind)} />
    }
    return <span className="shrink-0 text-right text-[11px] font-semibold leading-tight text-text-3">Required to sign in</span>
  }

  const twitterLinked = Boolean(pUser?.twitter)

  return (
    <div className="flex flex-col gap-3">
      <Row
        glyph={<GoogleGlyph className="h-5 w-5" />}
        name="Google"
        value={pUser?.google?.email ?? null}
        action={rowAction('google', Boolean(pUser?.google))}
      />
      <Row
        glyph={<AtSign className="h-5 w-5 text-text-2" strokeWidth={2.2} />}
        name="Email"
        value={pUser?.email?.address ?? null}
        action={rowAction('email', Boolean(pUser?.email))}
      />
      <Row
        glyph={<XGlyph className="h-5 w-5" />}
        name="X"
        value={pUser?.twitter?.username ? `@${pUser.twitter.username}` : null}
        action={rowAction('twitter', twitterLinked)}
      />

      {!twitterLinked && (
        <div className="card-neo mt-1 rounded-card p-4">
          <div className="flex items-center gap-2">
            <XGlyph className="h-5 w-5 shrink-0" />
            <span className="text-[15px] font-bold">Link your X account</span>
          </div>
          <p className="mt-1.5 text-sm leading-snug text-text-2">
            Earn a verified badge on the leaderboard, so everyone knows it&apos;s really you.
          </p>
          <TapButton
            label="Link X"
            busy={busy === 'twitter'}
            onTap={() => startLink('twitter')}
            className="mt-3 h-10 w-fit px-5 text-sm"
          />
        </div>
      )}
    </div>
  )
}

// dev / demo: no Privy provider is mounted (PRIVY_ENABLED false), shows whatever the backend session already carries, no link/unlink actions.
function StaticLinkedAccounts() {
  const { user } = useAuth()
  return (
    <div className="flex flex-col gap-3">
      <p className="px-1 text-[13px] leading-snug text-text-3">
        Linking is available when signed in with Google, email, or X.
      </p>
      <Row glyph={<GoogleGlyph className="h-5 w-5" />} name="Google" value={null} />
      <Row
        glyph={<AtSign className="h-5 w-5 text-text-2" strokeWidth={2.2} />}
        name="Email"
        value={user?.email ?? null}
      />
      <Row
        glyph={<XGlyph className="h-5 w-5" />}
        name="X"
        value={user?.twitter ? `@${user.twitter.username}` : null}
      />
    </div>
  )
}

function Row({
  glyph,
  name,
  value,
  action,
}: {
  glyph: ReactNode
  name: string
  value: string | null
  action?: ReactNode
}) {
  return (
    <div className="surface-skeuo flex items-center gap-3 rounded-card p-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/[0.06]">
        {glyph}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-bold">{name}</div>
        <div className="truncate text-sm text-text-3">{value ?? 'Not linked'}</div>
      </div>
      {action}
    </div>
  )
}

function TapButton({
  label,
  onTap,
  variant = 'primary',
  busy,
  preset = 'selection',
  className,
}: {
  label: string
  onTap: () => void
  variant?: 'primary' | 'ghost'
  busy?: boolean
  preset?: HapticPreset
  className?: string
}) {
  return (
    <div className={cnm('relative shrink-0', className)}>
      <button
        type="button"
        disabled={busy}
        onClick={onTap}
        className={cnm(
          'pointer-events-none flex h-full w-full items-center justify-center whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide transition-transform active:scale-95 disabled:opacity-40',
          variant === 'primary' ? 'btn-primary' : 'border border-line bg-white/[0.05] text-text-2',
        )}
      >
        {busy ? '…' : label}
      </button>
      {!busy && <HapticOverlay className="absolute inset-0 rounded-full" preset={preset} silent onTap={onTap} />}
    </div>
  )
}
