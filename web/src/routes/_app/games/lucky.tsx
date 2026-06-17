import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { useConsoleControls } from '@/components/console/controls'
import { haptic } from '@/lib/haptics'
import { cnm } from '@/utils/style'

// Phase 1 stub: wires the console controls end to end so the device feels real.
// Phase 4 swaps the fake spin for the backend round engine (real Predict oracle
// prices, live PnL, cash out). The control bindings below stay the same.
export const Route = createFileRoute('/_app/games/lucky')({ component: LuckyScreen })

const ASSETS = ['SUI', 'BTC', 'ETH', 'SOL', 'DEEP']
const LEVS = ['2x', '5x', '10x', '25x', '100x']

type Side = 'long' | 'short'
interface Spin {
  asset: string
  lev: string
  side: Side
}

function LuckyScreen() {
  const [bet, setBet] = useState(10)
  const [side, setSide] = useState<Side>('long')
  const [spin, setSpin] = useState<Spin | null>(null)

  useConsoleControls({
    status: { right: `${bet} pts` },
    action1: { label: 'Long', color: 'up', onPress: () => setSide('long') },
    action2: { label: 'Short', color: 'down', onPress: () => setSide('short') },
    knob: { label: 'Bet', min: 1, max: 100, step: 1, value: bet, onChange: setBet },
    main: {
      label: spin ? 'Cash Out' : 'Play',
      onPress: () => {
        if (spin) {
          haptic('success')
          toast.success('Cashed out (stub)')
          setSpin(null)
          return
        }
        const pick: Spin = {
          asset: ASSETS[Math.floor(Math.random() * ASSETS.length)],
          lev: LEVS[Math.floor(Math.random() * LEVS.length)],
          side,
        }
        setSpin(pick)
        haptic('heavy')
        toast(`${pick.lev} · ${pick.asset} · ${pick.side.toUpperCase()}`)
      },
    },
  })

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <h1 className="px-1 pt-1 text-xl font-extrabold tracking-tight">I Feel Lucky</h1>

      <div className="grid grid-cols-3 gap-2">
        <Reel label="Leverage" value={spin?.lev ?? '—'} />
        <Reel label="Asset" value={spin?.asset ?? '—'} />
        <Reel label="Side" value={spin ? spin.side.toUpperCase() : side.toUpperCase()} tone={spin ? spin.side : side} />
      </div>

      <div className="screen card-neo flex flex-1 items-center justify-center rounded-card text-center">
        <div className="px-6">
          <div className="text-sm text-text-2">
            {spin ? 'Live PnL + smooth chart land in Phase 4.' : 'Set your bet, pick a side, hit Play.'}
          </div>
          <div className="mt-1 text-xs text-text-3">
            Spin → real Predict oracle price → live mark → cash out.
          </div>
        </div>
      </div>
    </div>
  )
}

function Reel({ label, value, tone }: { label: string; value: string; tone?: Side }) {
  return (
    <div className="card-neo flex flex-col items-center justify-center gap-1 py-4">
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-3">{label}</span>
      <span
        className={cnm(
          'tnum text-lg font-extrabold',
          tone === 'long' && 'text-up',
          tone === 'short' && 'text-down',
        )}
      >
        {value}
      </span>
    </div>
  )
}
