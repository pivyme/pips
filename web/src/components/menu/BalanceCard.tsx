import { ArrowDownToLine, ArrowUpFromLine, History } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useAuth } from '@/lib/auth'
import { HapticOverlay } from '@/components/HapticOverlay'
import { prepareMenuTransition } from '@/components/menu/shared'
import { haptic } from '@/lib/haptics'
import { openMoneyModal, type MoneyView } from '@/lib/moneyModalBus'
import { formatCompactMoney } from '@/utils/format'
import { cnm } from '@/utils/style'

// The money card: balance headline (DUSDC chips) on the left, a history button top-right that pushes the
// Wallet Activity page, and Deposit / Send below (those open a centered money modal).
export function BalanceCard() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const balance = formatCompactMoney(user?.balance ?? '0')

  const openActivity = () => {
    prepareMenuTransition('forward')
    haptic('selection')
    void navigate({ to: '/menu/transactions', viewTransition: true })
  }

  return (
    <div className="card-neo rounded-card relative p-4">
      <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">My Balance</span>
      {/* Wallet Activity: tucked top-right, absolute so it never inflates the header height. */}
      <div className="absolute right-3 top-3 h-9 w-9">
        <Link
          to="/menu/transactions"
          viewTransition
          aria-label="Wallet Activity"
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
          <MoneyButton view="deposit" icon={ArrowDownToLine} label="Deposit" primary />
          <MoneyButton view="send" icon={ArrowUpFromLine} label="Send" />
        </div>
      </div>
    </div>
  )
}

function MoneyButton({
  view,
  icon: Icon,
  label,
  primary = false,
}: {
  view: MoneyView
  icon: LucideIcon
  label: string
  primary?: boolean
}) {
  return (
    <div className="relative h-11">
      <button
        type="button"
        className={cnm(
          'pointer-events-none flex h-11 items-center gap-1 rounded-xl px-2.5 text-[11px] font-extrabold uppercase tracking-wide',
          primary ? 'btn-primary' : 'border border-white/10 bg-white/[0.05] text-text',
        )}
      >
        <Icon className="h-[14px] w-[14px]" strokeWidth={2.6} />
        {label}
      </button>
      <HapticOverlay
        className="absolute inset-0 rounded-xl"
        preset={primary ? 'medium' : 'selection'}
        silent
        onTap={() => openMoneyModal(view)}
      />
    </div>
  )
}
