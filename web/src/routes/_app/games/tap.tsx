import { createFileRoute } from '@tanstack/react-router'
import toast from 'react-hot-toast'
import { useConsoleControls } from '@/components/console/controls'
import { Illo } from '@/ui/Illo'

// Scaffold. Tap: boxes drift across the chart, tap one to bet the price reaches
// it. Runs on the backend round engine (real Predict oracle prices) since the
// "touch" framing isn't native to Predict. Real wiring lands with the engine.
export const Route = createFileRoute('/_app/games/tap')({ component: TapScreen })

function TapScreen() {
  useConsoleControls({
    action1: { label: 'Up', color: 'up', onPress: () => toast('Tap engine: Phase 5') },
    action2: { label: 'Down', color: 'down', onPress: () => toast('Tap engine: Phase 5') },
    main: { label: 'Arm', onPress: () => toast('Tap engine wires up with the round engine') },
  })

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <Illo name="bolt" size={72} />
      <div>
        <h1 className="text-xl font-extrabold tracking-tight">Tap</h1>
        <p className="mt-1 text-sm text-text-2">
          Boxes drift across the chart. Tap the ones the price will hit.
        </p>
      </div>
      <p className="text-xs text-text-3">Scaffold · reuses the round engine + smooth chart from I Feel Lucky.</p>
    </div>
  )
}
