import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { useConsoleControls } from '@/components/console/controls'
import { Illo } from '@/ui/Illo'

// Scaffold. Range maps natively to Predict vertical-range positions (mint_range):
// tighter band -> lower probability -> bigger payout. The knob widens/narrows the
// band; Action 1/2 pick the round length. Real wiring lands after the Predict layer.
export const Route = createFileRoute('/_app/games/range')({ component: RangeScreen })

const DURATIONS = ['10s', '30s', '1m']

function RangeScreen() {
  const [widthPct, setWidthPct] = useState(4) // half-band width, % of spot
  const [duration, setDuration] = useState('30s')

  useConsoleControls({
    status: { right: `±${widthPct}%` },
    action1: {
      label: 'Faster',
      onPress: () => setDuration(DURATIONS[Math.max(0, DURATIONS.indexOf(duration) - 1)]),
    },
    action2: {
      label: 'Slower',
      onPress: () => setDuration(DURATIONS[Math.min(DURATIONS.length - 1, DURATIONS.indexOf(duration) + 1)]),
    },
    knob: { label: 'Band', min: 1, max: 20, step: 1, value: widthPct, onChange: setWidthPct, format: (v) => `±${v}%` },
    main: { label: 'Play', onPress: () => toast('Range mint wires up after the Predict layer') },
  })

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <Illo name="target" size={72} />
      <div>
        <h1 className="text-xl font-extrabold tracking-tight">Range</h1>
        <p className="mt-1 text-sm text-text-2">
          Land the price inside your band when the round ends. Tighter band, bigger win.
        </p>
      </div>
      <div className="card-neo px-5 py-3">
        <div className="tnum text-2xl font-extrabold text-brand-500">±{widthPct}%</div>
        <div className="text-xs uppercase tracking-[0.08em] text-text-3">{duration} round</div>
      </div>
      <p className="text-xs text-text-3">Scaffold · knob sets the band, Action 1/2 set the round length.</p>
    </div>
  )
}
