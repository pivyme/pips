// The console is a persistent shell with a swappable screen (docs/DESIGN.md).
// The physical controls (Main / Action 1·2 / Knob / Number Wheel / status) belong to the shell,
// but each game screen *registers* what they do when it mounts. Same device,
// different bindings, like a real handheld.
//
// Usage from a screen:
//   useConsoleControls({
//     main:    { label: 'PLAY', onPress: play },
//     action1: { label: 'LONG', color: 'up',   onPress: () => setSide('long') },
//     action2: { label: 'SHORT', color: 'down', onPress: () => setSide('short') },
//     knob:    { min: 1, max: 100, step: 1, value: bet, onChange: setBet, label: 'BET' },
//     numberWheel: { min: 0, max: 5, step: 1, value: stakeIndex, onChange: setStakeIndex },
//   })
//
// Handlers stay fresh (kept in a ref) so screens don't fight stale closures;
// only the renderable bits (labels, colors, knob value) re-render the shell.
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'

export type ButtonColor = 'amber' | 'up' | 'down' | 'neutral'

export interface ActionSpec {
  label: string
  onPress: () => void
  color?: ButtonColor
  disabled?: boolean
}

export interface MainSpec {
  label: string
  onPress: () => void
  color?: ButtonColor
  disabled?: boolean
  loading?: boolean
}

export interface KnobSpec {
  min: number
  max: number
  step: number
  value: number
  onChange: (value: number) => void
  label?: string
  format?: (value: number) => string
  disabled?: boolean
}

export interface StatusSpec {
  left?: ReactNode
  right?: ReactNode
}

export interface ConsoleControls {
  main?: MainSpec | null
  action1?: ActionSpec | null
  action2?: ActionSpec | null
  knob?: KnobSpec | null
  numberWheel?: KnobSpec | null
  status?: StatusSpec | null
}

// Renderable snapshot (drives shell re-renders). Handlers live in a ref instead.
export interface ConsoleView {
  main: Omit<MainSpec, 'onPress'> | null
  action1: Omit<ActionSpec, 'onPress'> | null
  action2: Omit<ActionSpec, 'onPress'> | null
  knob: Omit<KnobSpec, 'onChange'> | null
  numberWheel: Omit<KnobSpec, 'onChange'> | null
  status: StatusSpec | null
}

interface Handlers {
  main?: () => void
  action1?: () => void
  action2?: () => void
  knob?: (value: number) => void
  numberWheel?: (value: number) => void
}

const EMPTY_VIEW: ConsoleView = {
  main: null,
  action1: null,
  action2: null,
  knob: null,
  numberWheel: null,
  status: null,
}

interface Ctx {
  view: ConsoleView
  handlers: React.MutableRefObject<Handlers>
  setView: (view: ConsoleView) => void
}

const ConsoleControlsContext = createContext<Ctx | null>(null)

export function ConsoleControlsProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<ConsoleView>(EMPTY_VIEW)
  const handlers = useRef<Handlers>({})
  return (
    <ConsoleControlsContext.Provider value={{ view, handlers, setView }}>
      {children}
    </ConsoleControlsContext.Provider>
  )
}

function useCtx(): Ctx {
  const ctx = useContext(ConsoleControlsContext)
  if (!ctx) throw new Error('Console controls used outside ConsoleControlsProvider')
  return ctx
}

// Read side: the shell.
export function useConsoleView() {
  const { view, handlers } = useCtx()
  return { view, handlers }
}

function toView(c: ConsoleControls): ConsoleView {
  return {
    main: c.main
      ? { label: c.main.label, color: c.main.color, disabled: c.main.disabled, loading: c.main.loading }
      : null,
    action1: c.action1
      ? { label: c.action1.label, color: c.action1.color, disabled: c.action1.disabled }
      : null,
    action2: c.action2
      ? { label: c.action2.label, color: c.action2.color, disabled: c.action2.disabled }
      : null,
    knob: c.knob
      ? {
          min: c.knob.min,
          max: c.knob.max,
          step: c.knob.step,
          value: c.knob.value,
          label: c.knob.label,
          format: c.knob.format,
          disabled: c.knob.disabled,
        }
      : null,
    numberWheel: c.numberWheel
      ? {
          min: c.numberWheel.min,
          max: c.numberWheel.max,
          step: c.numberWheel.step,
          value: c.numberWheel.value,
          label: c.numberWheel.label,
          format: c.numberWheel.format,
          disabled: c.numberWheel.disabled,
        }
      : null,
    status: c.status ?? null,
  }
}

// Cheap key over the renderable bits, so the shell only re-renders on real change.
function viewKey(v: ConsoleView): string {
  const btn = (b: { label?: string; color?: string; disabled?: boolean; loading?: boolean } | null) =>
    b ? `${b.label}/${b.color ?? ''}/${b.disabled ? 1 : 0}/${b.loading ? 1 : 0}` : '-'
  const dial = (d: ConsoleView['knob']) => d
    ? `${d.min}/${d.max}/${d.step}/${d.value}/${d.label ?? ''}/${d.disabled ? 1 : 0}`
    : '-'
  const txt = (x: ReactNode) =>
    typeof x === 'string' || typeof x === 'number' ? String(x) : x ? '#' : '-'
  const status = v.status ? `${txt(v.status.left)}|${txt(v.status.right)}` : '-'
  return [btn(v.main), btn(v.action1), btn(v.action2), dial(v.knob), dial(v.numberWheel), status].join(';')
}

// Write side: a game screen.
export function useConsoleControls(controls: ConsoleControls) {
  const { setView, handlers } = useCtx()

  // Keep handlers current every render (event-callback pattern, no stale closures).
  handlers.current = {
    main: controls.main?.onPress,
    action1: controls.action1?.onPress,
    action2: controls.action2?.onPress,
    knob: controls.knob?.onChange,
    numberWheel: controls.numberWheel?.onChange,
  }

  const view = toView(controls)
  const key = viewKey(view)

  useEffect(() => {
    setView(view)
    return () => setView(EMPTY_VIEW)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}
