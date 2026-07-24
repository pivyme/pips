import { Link, useNavigate, useRouter } from '@tanstack/react-router'
import { ArrowDownToLine, ArrowUpFromLine, History } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { prepareMenuTransition } from '@/components/menu/shared'
import { useAuth } from '@/lib/auth'
import { haptic } from '@/lib/haptics'
import { HapticOverlay } from '@/components/HapticOverlay'
import { formatCompactMoney } from '@/utils/format'
import { cnm } from '@/utils/style'

// The money card: balance headline (DUSDC chips) on the left, a history button top-right that opens the
// activity feed, and Deposit / Send below. The old dead DUSDC chip is gone; the balance IS DUSDC chips.
export function BalanceCard() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const balance = formatCompactMoney(user?.balance ?? '0')

  const openActivity = () => {
    prepareMenuTransition('forward')
    void navigate({ to: '/menu/transactions', viewTransition: true })
  }

  return (
    <div className="card-neo rounded-card relative p-4">
      <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">My Balance</span>
      {/* Activity: tucked top-right, absolute so it never inflates the header height. */}
      <div className="absolute right-3 top-3 h-9 w-9">
        <Link
          to="/menu/transactions"
          viewTransition
          aria-label="Activity"
          onClick={() => {
            prepareMenuTransition('forward')
            haptic('selection')
          }}
          className="pointer-events-none flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.06] text-text-2 transition-transform active:scale-95"
        >
          <History className="h-[17px] w-[17px]" strokeWidth={2.4} />
        </Link>
        <HapticOverlay className="absolute inset-0 rounded-full" preset="selection" silent onTap={openActivity} />
      </div>
      <div className="mt-6 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <img
            src="/assets/icons/dusdc-logo.webp"
            alt=""
            className="h-10 w-10 shrink-0 rounded-full"
            draggable={false}
          />
          <div className="flex min-w-0 items-baseline gap-0.5">
            <span className="text-xl font-black text-text-3">$</span>
            <span className="tnum truncate text-[34px] font-black leading-none text-text">{balance}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <MoneyButton to="/menu/deposit" icon={ArrowDownToLine} label="Deposit" primary />
          <MoneyButton to="/menu/withdraw" icon={ArrowUpFromLine} label="Send" />
        </div>
      </div>
    </div>
  )
}

// Warm a route's JS chunk on finger-down so the tap doesn't wait on a cold module fetch. The buttons navigate
// through the HapticOverlay (the Link is pointer-events-none), so the router never sees hover intent.
function usePreload() {
  const router = useRouter()
  return (to: string) => void router.preloadRoute({ to }).catch(() => {})
}

function MoneyButton({
  to,
  icon: Icon,
  label,
  primary = false,
}: {
  to: string
  icon: LucideIcon
  label: string
  primary?: boolean
}) {
  const navigate = useNavigate()
  const preload = usePreload()
  const go = () => {
    prepareMenuTransition('forward')
    void navigate({ to, viewTransition: true })
  }
  return (
    <div className="relative h-11" onPointerDownCapture={() => preload(to)}>
      <Link
        to={to}
        viewTransition
        onClick={() => {
          prepareMenuTransition('forward')
          haptic('selection')
        }}
        className={cnm(
          'pointer-events-none flex h-11 items-center gap-1 rounded-xl px-2.5 text-[11px] font-extrabold uppercase tracking-wide',
          primary ? 'btn-primary' : 'border border-white/10 bg-white/[0.05] text-text',
        )}
      >
        <Icon className="h-[14px] w-[14px]" strokeWidth={2.6} />
        {label}
      </Link>
      <HapticOverlay className="absolute inset-0 rounded-xl" preset="selection" silent onTap={go} />
    </div>
  )
}
