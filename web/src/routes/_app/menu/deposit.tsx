import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Check, Copy, Coins } from 'lucide-react'
import toast from 'react-hot-toast'
import { MenuScreen } from '@/components/menu/shared'
import { useAuth } from '@/lib/auth'
import { api, ApiError } from '@/lib/api'
import { haptic } from '@/lib/haptics'

// Receive USDC. Pure address screen, no chain call: anything sent to this address lands in the
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
      toast.success(`Received ${Number(res.amount)} test USDC`, { id: 'faucet' })
    } catch (e) {
      haptic('error')
      toast.error(e instanceof ApiError ? e.message : 'Could not get test USDC', { id: 'faucet' })
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
      toast.error('Could not copy the address')
    }
  }

  return (
    <MenuScreen title="Deposit">
      <div className="flex flex-col gap-5">
        <p className="px-1 text-[15px] leading-snug text-text-2">
          Send USDC to your address to top up your balance. Scan the code, or
          copy the address below.
        </p>

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
            Your USDC address
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

        <p className="px-1 text-[13px] leading-snug text-text-3">
          Pips network USDC only. Funds appear in your balance once the transfer
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
          {claiming ? 'Sending…' : 'Get 100 test USDC'}
        </button>
        <p className="px-1 text-[13px] leading-snug text-text-3">
          Instant play money on the Pips network. One batch per minute.
        </p>
      </div>
    </MenuScreen>
  )
}
