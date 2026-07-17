// One official account, one standing warning, shown at the foot of the landing door and the menu
// drawer (both App-Surface). The no-token line is not decoration: impersonator coins are the real risk.
import { ShieldAlert } from 'lucide-react'
import { config } from '@/config'
import { XGlyph } from '@/components/menu/BrandGlyphs'
import { HapticOverlay } from '@/components/HapticOverlay'
import { haptic } from '@/lib/haptics'
import { cnm } from '@/utils/style'

const X_HANDLE = '@PlayPipsFun'

// `dense` is the one-row layout (X + DeepBook credit share a line, warning beneath). `large` scales it
// up a notch for the menu drawer, which has the room; the landing door stays compact so it never rides
// up over the device.
export function SocialFooter({
  dense = false,
  large = false,
  className,
}: {
  dense?: boolean
  large?: boolean
  className?: string
}) {
  if (dense) {
    return (
      <div className={cnm('flex flex-col items-center', large ? 'gap-4' : 'gap-3', className)}>
        <div className={cnm('flex items-center', large ? 'gap-4' : 'gap-3')}>
          <XButton large={large} />
          <span className={cnm('w-px bg-line-strong', large ? 'h-7' : 'h-5')} />
          <PoweredBy large={large} />
        </div>
        <p
          className={cnm(
            'text-balance text-center leading-snug text-text-3',
            large ? 'max-w-[24rem] text-[15px]' : 'max-w-[19rem] text-[11px]',
          )}
        >
          <span className="font-bold text-text-2">PIPS has no token.</span> Any coin claiming to be
          PIPS is a scam.
        </p>
      </div>
    )
  }

  return (
    <div className={cnm('flex flex-col items-center gap-3', className)}>
      <XButton />
      <div className="flex w-full items-start gap-2.5 rounded-2xl border border-line bg-white/[0.02] px-3.5 py-3">
        <ShieldAlert className="mt-px h-4 w-4 shrink-0 text-text-3" strokeWidth={2.2} />
        <p className="text-[12px] leading-snug text-text-3">
          <span className="font-bold text-text-2">PIPS has no token.</span> We have never launched
          one. Any coin, presale, or airdrop claiming to be PIPS is a scam. {X_HANDLE} is our only
          account.
        </p>
      </div>
    </div>
  )
}

function XButton({ large = false }: { large?: boolean }) {
  const open = () => window.open(config.links.twitter, '_blank', 'noopener,noreferrer')
  return (
    <div className="relative">
      <a
        href={config.links.twitter}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => haptic('rigid')}
        className={cnm(
          'pointer-events-none flex items-center gap-2.5 rounded-full border border-line-strong bg-white/[0.04] font-bold text-text transition-colors hover:bg-white/[0.08]',
          large ? 'h-[52px] pl-5 pr-6 text-[16px]' : 'h-9 pl-3 pr-3.5 text-[12.5px]',
        )}
      >
        <XGlyph className={large ? 'h-[18px] w-[18px]' : 'h-3.5 w-3.5'} />
        Follow
      </a>
      <HapticOverlay className="absolute inset-0 rounded-full" preset="rigid" onTap={open} />
    </div>
  )
}

function PoweredBy({ large = false }: { large?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span
        className={cnm(
          'font-medium uppercase tracking-[0.12em] text-text-3',
          large ? 'text-[11px]' : 'text-[9px]',
        )}
      >
        Powered by
      </span>
      <img
        src="/assets/db-predict-horizontal-logo.svg"
        alt="DeepBook Predict"
        draggable={false}
        className={cnm('w-auto select-none opacity-90', large ? 'h-[24px]' : 'h-[15px]')}
      />
    </div>
  )
}
