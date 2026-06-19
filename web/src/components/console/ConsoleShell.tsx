// The persistent device shell. The screen swaps per route (children), the
// chrome (status strip, action buttons, knob, Menu/Games tabs) stays put and
// is driven by whatever screen registered via useConsoleControls().
// CSS/SVG fidelity for now; a 3D pass comes later (docs/DESIGN.md "The Device").
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { cnm } from '@/utils/style'
import { haptic } from '@/lib/haptics'
import { useAuth } from '@/lib/auth'
import { isDemo } from '@/lib/demo'
import { formatStringToNumericDecimals } from '@/utils/format'
import { useConsoleView } from './controls'
import type { ButtonColor, ConsoleView } from './controls'
import { Knob } from './Knob'

function colorClasses(color: ButtonColor = 'neutral'): string {
  switch (color) {
    case 'amber':
      return 'btn-primary'
    case 'up':
      return 'bg-up/15 text-up border border-up/40 active:scale-[0.97]'
    case 'down':
      return 'bg-down/15 text-down border border-down/40 active:scale-[0.97]'
    default:
      return 'bg-surface text-text border border-line active:scale-[0.97]'
  }
}

function ActionButton({
  spec,
  onPress,
}: {
  spec: ConsoleView['action1']
  onPress: () => void
}) {
  const unavailable = !spec
  return (
    <button
      type="button"
      disabled={unavailable}
      onPointerDown={() => !unavailable && haptic('medium')}
      onClick={() => !unavailable && onPress()}
      className={cnm(
        'flex h-full w-full items-center justify-center rounded-md text-center text-sm font-bold uppercase tracking-wide transition-transform',
        unavailable ? 'bg-surface/40 text-text-3 border border-line' : colorClasses(spec.color),
      )}
    >
      {spec?.label ?? ''}
    </button>
  )
}

function MainButton({
  spec,
  onPress,
}: {
  spec: ConsoleView['main']
  onPress: () => void
}) {
  const unavailable = !spec
  return (
    <button
      type="button"
      disabled={unavailable}
      onPointerDown={() => !unavailable && haptic('rigid')}
      onClick={() => !unavailable && onPress()}
      className={cnm(
        'flex h-[68px] w-full items-center justify-center rounded-card text-center text-base font-extrabold uppercase tracking-wide transition-transform',
        unavailable ? 'bg-surface/40 text-text-3 border border-line' : colorClasses(spec.color ?? 'amber'),
      )}
    >
      {spec?.loading ? '···' : (spec?.label ?? 'PLAY')}
    </button>
  )
}

function TabPill({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      className={cnm(
        'flex h-9 items-center justify-center rounded-full text-xs font-bold uppercase tracking-[0.08em] transition-colors',
        active ? 'bg-surface-2 text-brand-500' : 'bg-surface/60 text-text-3',
      )}
    >
      {label}
    </span>
  )
}

// Device sensor bar: network + connection on the left, live chip balance on the right. The
// balance is persistent chrome (it reflects the auth session, refreshed as plays settle), so
// it wins over any screen-supplied status.right.
function StatusStrip({ status, balance }: { status: ConsoleView['status']; balance: string | null }) {
  return (
    <div className="flex h-8 items-center justify-between px-5 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-3">
      <span className="flex items-center gap-1.5">
        {isDemo() ? (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
            Demo
          </>
        ) : (
          status?.left ?? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-up" />
              Testnet
            </>
          )
        )}
      </span>
      <span className="tnum text-text-2">
        {balance != null ? `$${formatStringToNumericDecimals(balance)}` : (status?.right ?? 'Pips')}
      </span>
    </div>
  )
}

export function ConsoleShell({ children }: { children: ReactNode }) {
  const { view, handlers } = useConsoleView()
  const { user } = useAuth()

  return (
    <div className="flex h-full w-full select-none flex-col bg-black">
      <StatusStrip status={view.status} balance={user?.balance ?? null} />

      {/* The screen: true black, recessed. Routed content renders inside. */}
      <div className="screen console-screen-surface relative mx-3 min-h-0 flex-1 overflow-hidden rounded-[28px]">
        <div className="h-full w-full overflow-y-auto overflow-x-hidden">{children}</div>
      </div>

      {/* Control deck */}
      <div className="flex gap-2.5 px-3 pb-4 pt-2.5" style={{ height: 196 }}>
        {/* left: the two contextual action buttons, then the nav tabs */}
        <div className="flex flex-1 flex-col gap-2.5">
          <div className="grid min-h-0 flex-1 grid-cols-2 gap-2.5">
            <ActionButton spec={view.action1} onPress={() => handlers.current.action1?.()} />
            <ActionButton spec={view.action2} onPress={() => handlers.current.action2?.()} />
          </div>
          <div className="flex gap-2">
            <Link to="/menu" activeOptions={{ exact: false }} onClick={() => haptic('selection')} className="flex-1">
              {({ isActive }) => <TabPill label="Menu" active={isActive} />}
            </Link>
            <Link to="/games" activeOptions={{ exact: false }} onClick={() => haptic('selection')} className="flex-1">
              {({ isActive }) => <TabPill label="Home" active={isActive} />}
            </Link>
          </div>
        </div>

        {/* right: the main commit button over the knob */}
        <div className="flex w-[92px] flex-col gap-2.5">
          <MainButton spec={view.main} onPress={() => handlers.current.main?.()} />
          <Knob spec={view.knob} onChange={(v) => handlers.current.knob?.(v)} />
        </div>
      </div>
    </div>
  )
}
