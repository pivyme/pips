import { createFileRoute } from '@tanstack/react-router'
import { ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import { MenuScreen } from '@/components/menu/shared'
import { HapticOverlay } from '@/components/HapticOverlay'
import { haptic } from '@/lib/haptics'
import { config } from '@/config'
import { cnm } from '@/utils/style'

// The story behind the product: who built it, where it was born, what it settles against. Static
// copy, no data fetch. Reached from Settings > About PIPS.
export const Route = createFileRoute('/_app/menu/about')({ component: AboutScreen })

function AboutScreen() {
  return (
    <MenuScreen title="About">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col items-center gap-3 py-1 text-center">
          <div className="h-24 w-24 overflow-hidden rounded-[28px] border border-white/10 shadow-[0_18px_36px_-24px_rgba(0,0,0,0.9)]">
            <img
              src="/assets/logos/pips-square-logo-3d.png"
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          </div>
          <div>
            <div className="text-2xl font-black tracking-tight">PIPS</div>
            <div className="text-sm text-text-3">{config.tagline}</div>
          </div>
        </div>

        <div className="card-neo rounded-card p-5">
          <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">
            Why we built it
          </span>
          <p className="mt-2.5 text-[15px] leading-snug text-text-2">
            Trading terminals all look and feel the same: a wall of candles and jargon that takes
            real effort to even parse. PIPS is the opposite, one handheld device, two buttons, a
            dial. Real trades against DeepBook Predict, played like a game instead of read like a
            terminal.
          </p>
          <p className="mt-3 text-[15px] leading-snug text-text-2">
            We did not want another piece of cool tech bolted onto Sui just to look impressive. We
            wanted one thing: something fun enough that people actually come back to it, built to
            put Sui in the spotlight.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <AboutRow
            leading={<LogoBadge src="/assets/images/pivy-logo.jpg" />}
            title="Made by PIVY Team"
            sub="A user-friendly privacy platform on Sui"
            href={config.links.pivy}
          />
          <AboutRow
            leading={<LogoBadge src="/assets/images/deepbook-logo.jpg" />}
            title="Powered by DeepBook Predict"
            sub="Every play settles on-chain, never simulated"
            href={config.links.docs}
          />
          <AboutRow
            leading={<LogoBadge src="/assets/images/overflow-logo.jpg" />}
            title="Born at Sui Overflow 2026"
            sub="Built during Sui's global hackathon"
          />
        </div>
      </div>
    </MenuScreen>
  )
}

function LogoBadge({ src }: { src: string }) {
  return (
    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-2xl">
      <img src={src} alt="" className="h-full w-full object-cover" draggable={false} />
    </div>
  )
}

function AboutRow({
  leading,
  title,
  sub,
  href,
}: {
  leading: ReactNode
  title: string
  sub: string
  href?: string
}) {
  const content = (
    <>
      {leading}
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-bold">{title}</div>
        <div className="text-sm leading-snug text-text-3">{sub}</div>
      </div>
      {href && <ExternalLink className="h-4 w-4 shrink-0 text-text-3" strokeWidth={2.4} />}
    </>
  )

  if (!href) {
    return <div className="surface-skeuo flex items-center gap-3 rounded-card p-4">{content}</div>
  }

  return (
    <TapCard href={href} className="flex items-center gap-3">
      {content}
    </TapCard>
  )
}

// A whole card that opens an external link: real anchor for right-click/long-press, plus the
// native-switch overlay so the tap gets a genuine haptic (see HapticOverlay.tsx).
function TapCard({
  href,
  className,
  children,
}: {
  href: string
  className?: string
  children: ReactNode
}) {
  return (
    <div className="relative">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => haptic('selection')}
        className={cnm(
          'surface-skeuo pointer-events-none rounded-card p-4 transition-transform active:scale-[0.99]',
          className,
        )}
      >
        {children}
      </a>
      <HapticOverlay
        className="absolute inset-0 rounded-card"
        preset="selection"
        onTap={() => window.open(href, '_blank', 'noopener,noreferrer')}
      />
    </div>
  )
}
