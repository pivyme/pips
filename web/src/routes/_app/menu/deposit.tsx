import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Check, Copy, Coins, ExternalLink } from 'lucide-react'
import toast from 'react-hot-toast'
import { MenuScreen } from '@/components/menu/shared'
import { useAuth } from '@/lib/auth'
import { api, ApiError } from '@/lib/api'
import { explorerAddressUrl } from '@/lib/sui/config'
import { haptic } from '@/lib/haptics'
import { HapticOverlay } from '@/components/HapticOverlay'

// Receive DUSDC. Pure address screen, no chain call: anything sent to this address lands in the
// balance. We poll /auth/me lightly while it's open so an incoming deposit shows up on its own.
export const Route = createFileRoute('/_app/menu/deposit')({
  component: DepositScreen,
})

function DepositScreen() {
  const { user, refresh } = useAuth()
  const address = user?.address ?? ''
  const [copied, setCopied] = useState(false)
  const [claiming, setClaiming] = useState(false)

  useEffect(() => {
    void refresh()
    const iv = window.setInterval(() => void refresh(), 8000)
    return () => window.clearInterval(iv)
  }, [refresh])

  // Test faucet: hand the player a batch of free chips so they can play without a real deposit.
  // The backend enforces the per-tap cooldown; we just surface its message.
  const claim = async () => {
    if (claiming || !user) return
    setClaiming(true)
    try {
      const res = await api.requestDusdc()
      await refresh()
      haptic('success')
      toast.success(`Received ${Number(res.amount)} test DUSDC`, { id: 'faucet' })
    } catch (e) {
      haptic('error')
      toast.error(e instanceof ApiError ? e.message : 'Could not get test DUSDC', { id: 'faucet' })
    } finally {
      setClaiming(false)
    }
  }

  const copy = async () => {
    if (!address) return
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      haptic('success')
      toast.success('Address copied', { id: 'copy-address' })
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Could not copy the address', { id: 'copy-address' })
    }
  }

  return (
    <MenuScreen title="Deposit">
      <div className="flex flex-col gap-5">
        <p className="px-1 text-[15px] leading-snug text-text-2">
          Send DUSDC to your address to top up your balance. Scan the code, or
          copy the address below.
        </p>

        {/* What DUSDC is, up front: a test token we mint, not the real thing. */}
        <div className="surface-skeuo flex items-start gap-3 rounded-card p-4">
          <img
            src="/assets/icons/dusdc-logo.webp"
            alt=""
            className="h-9 w-9 shrink-0 rounded-full"
            draggable={false}
          />
          <p className="text-[13px] leading-snug text-text-2">
            <span className="font-bold text-text">DUSDC</span> is a test token
            deployed by the PIPS team on Sui Devnet. It is free play money with
            no real value, use it to try every game.
          </p>
        </div>

        {/* QR on a white panel so any camera reads it cleanly. */}
        <div className="card-neo flex flex-col items-center gap-4 rounded-card p-6">
          <div className="rounded-2xl bg-white p-4">
            {address ? (
              <QRCodeSVG value={address} size={184} level="M" marginSize={0} />
            ) : (
              <div className="h-[184px] w-[184px] animate-pulse rounded bg-black/10" />
            )}
          </div>
          <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">
            Your address QR code
          </span>
        </div>

        {/* Tap the whole row to copy. */}
        <button
          onClick={copy}
          className="surface-skeuo flex items-center gap-3 rounded-card p-4 text-left transition-transform active:scale-[0.99]"
        >
          <span className="tnum min-w-0 flex-1 break-all text-[13px] leading-snug text-text-2">
            {address || '—'}
          </span>
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-text">
            {copied ? (
              <Check className="h-5 w-5 text-up" strokeWidth={2.6} />
            ) : (
              <Copy className="h-5 w-5" strokeWidth={2.4} />
            )}
          </span>
        </button>

        {/* Open the address on the Sui devnet explorer in a new tab. */}
        {address && (
          <div className="relative">
            <a
              href={explorerAddressUrl(address)}
              target="_blank"
              rel="noreferrer"
              onClick={() => haptic('selection')}
              className="pointer-events-none surface-skeuo flex items-center justify-center gap-2 rounded-card p-4 text-[14px] font-semibold text-text transition-transform active:scale-[0.99]"
            >
              <ExternalLink className="h-[18px] w-[18px] text-text-2" strokeWidth={2.4} />
              Check on explorer
            </a>
            <HapticOverlay
              className="absolute inset-0 rounded-card"
              preset="selection"
              onTap={() => window.open(explorerAddressUrl(address), '_blank', 'noreferrer')}
            />
          </div>
        )}

        <p className="px-1 text-[13px] leading-snug text-text-3">
          Sui Devnet DUSDC only. Funds appear in your balance once the transfer
          confirms.
        </p>

        {/* Test faucet: free play money so anyone can jump in without a real deposit. */}
        <div className="flex items-center gap-3 px-1 pt-1">
          <span className="h-px flex-1 bg-white/[0.08]" />
          <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">
            or
          </span>
          <span className="h-px flex-1 bg-white/[0.08]" />
        </div>

        <button
          onClick={claim}
          disabled={claiming || !user}
          className="btn-primary flex h-12 items-center justify-center gap-2 rounded-card text-[15px] font-semibold disabled:opacity-60"
        >
          <Coins className="h-[18px] w-[18px]" strokeWidth={2.4} />
          {claiming ? 'Sending…' : 'Get 500 test DUSDC'}
        </button>
        <p className="px-1 text-[13px] leading-snug text-text-3">
          Instant test DUSDC on Sui Devnet. One batch per minute.
        </p>
      </div>
    </MenuScreen>
  )
}
