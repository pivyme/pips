import { useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Check, Copy, ExternalLink, Info } from 'lucide-react'
import toast from 'react-hot-toast'
import { explorerAddressUrl, NETWORK_LABEL } from '@/lib/sui/config'
import { haptic } from '@/lib/haptics'
import { HapticOverlay } from '@/components/HapticOverlay'
import { Alert } from '@/ui/Alert'

// Receive mode: the chip asset on Sui needs no bridge at all, the address just receives it. This is the
// one deposit path that fully works today, so it stays the plain, boring, correct address screen.

// The chip is DeepBook Predict's own test token. Never claim a network we're not on.
const CHIP_ORIGIN = `DeepBook Predict's test token on ${NETWORK_LABEL}`

export function ReceivePanel({ address, chipSymbol, minUsd }: { address: string; chipSymbol: string; minUsd: number }) {
  const [copied, setCopied] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)

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
    <div className="flex flex-col gap-5">
      {/* The one thing that loses funds here: sending the wrong asset or the wrong chain. Say it first. */}
      <Alert tone="warning">
        Send only <span className="font-bold text-text">{chipSymbol}</span> on{' '}
        <span className="font-bold text-text">{NETWORK_LABEL}</span> to this address. Anything else is lost.
      </Alert>

      {/* The QR sits in the amber handheld plate, same bezel + recessed screen as the player card, so the
          deposit screen reads as a little PIPS device rather than a plain white square. */}
      <div className="trader-bezel overflow-hidden rounded-[26px] p-2.5">
        <div className="flex items-center justify-between px-1.5 pb-2.5 pt-1">
          <img src="/assets/logos/pips-horizontal-black.svg" alt="PIPS" className="h-6 w-auto" />
          <span
            className="text-[10px] font-extrabold uppercase tracking-[0.18em]"
            style={{ color: 'rgba(46,30,0,0.58)', textShadow: '0 1px 0 rgba(255,255,255,0.28)' }}
          >
            Deposit {chipSymbol}
          </span>
        </div>
        <div className="trader-screen flex flex-col items-center gap-4 rounded-[18px] p-6">
          <div className="rounded-2xl bg-white p-4">
            {address ? (
              <QRCodeSVG value={address} size={184} level="M" marginSize={0} />
            ) : (
              <div className="h-[184px] w-[184px] animate-pulse rounded bg-black/10" />
            )}
          </div>
          <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/55">Scan to send</span>
          <span className="text-[12px] text-white/55">
            Minimum <span className="tnum font-bold text-white/80">${minUsd}</span> recommended
          </span>
        </div>
      </div>

      {/* Tap the whole row to copy. */}
      <button
        onClick={copy}
        className="surface-skeuo flex items-center gap-3 rounded-card p-4 text-left transition-transform active:scale-[0.99]"
      >
        <span className="tnum min-w-0 flex-1 truncate text-[13px] leading-snug text-text-2">{address || '—'}</span>
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-text">
          {copied ? <Check className="h-5 w-5 text-up" strokeWidth={2.6} /> : <Copy className="h-5 w-5" strokeWidth={2.4} />}
        </span>
      </button>

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

      {/* What the chip is, kept as a disclosure so the screen stays about the address. */}
      <button
        onClick={() => {
          haptic('selection')
          setInfoOpen((v) => !v)
        }}
        className="flex items-center gap-2 px-1 text-left text-[13px] font-semibold text-text-3"
      >
        <Info className="h-4 w-4" strokeWidth={2.4} />
        What is {chipSymbol}?
      </button>
      {infoOpen && (
        <p className="-mt-2 px-1 text-[13px] leading-snug text-text-3">
          <span className="font-bold text-text-2">{chipSymbol}</span> is {CHIP_ORIGIN}. It is free play money with no
          real value, use it to try every game. Funds appear in your balance once the transfer confirms.
        </p>
      )}
    </div>
  )
}
