import { Link, createFileRoute } from '@tanstack/react-router'
import { ChevronRight, Vibrate } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { WebHaptics } from 'web-haptics'
import { isHapticsEnabled } from '@/lib/haptics'
import { cnm } from '@/utils/style'

export const Route = createFileRoute('/dev/haptics')({ component: HapticsLab })

// Phase 0.5 probe (HAPTICS.md §7). Answers 8 feel questions on a real phone before Phase 1 picks
// an iOS architecture. The switch experiments below stay self-contained (no lib/haptics.ts calls),
// since they are testing the raw platform mechanism, not our engine. The one import above is a
// deliberate exception: lib/haptics.ts has since shipped for real, so the readout strip reads
// isHapticsEnabled() straight from it. Delete this file's switch experiments once the answers are
// recorded in HAPTICS.md and Phase 1 ships the real engine.

const LEVELS = [
  { id: 'low', label: 'Low', ms: 10 },
  { id: 'mid', label: 'Mid', ms: 15 },
  { id: 'high', label: 'High', ms: 20 },
] as const

// Shared visual chrome for a decorative "button" with a real interactive element hidden on top of
// it. The switch is the actual hit target; the div underneath is paint only (pointer-events: none).
function TapPad({
  id,
  wide,
  appearance,
  inputRef,
  onFire,
  onDragFire,
}: {
  id: string
  wide?: boolean
  appearance?: 'none' | 'auto'
  inputRef?: React.RefObject<HTMLInputElement | null>
  onFire?: () => void
  onDragFire?: () => void
}) {
  return (
    <div className={cnm('relative flex h-14 items-center justify-center border border-line-strong', wide ? 'w-full' : 'w-40')}>
      <div className="pointer-events-none flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-text-2">
        <Vibrate size={14} />
        {wide ? 'Slide across' : 'Tap'}
      </div>
      <input
        ref={inputRef}
        id={id}
        type="checkbox"
        {...{ switch: '' }}
        aria-label={id}
        onChange={() => onFire?.()}
        onPointerMove={(e) => {
          if (e.buttons === 1) onDragFire?.()
        }}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          margin: 0,
          appearance,
          opacity: 0,
          clipPath: 'inset(0 round 999px)',
          touchAction: 'none',
        }}
      />
    </div>
  )
}

// A strip of adjacent real switches, one per would-be detent. Deliberately has ONLY a real onChange
// handler (no onPointerMove noise, unlike TapPad's drag test above, which conflated a real native toggle
// count with a per-pixel pointermove count and made the earlier drag result ambiguous). This answers the
// question that actually matters for the knob/wheel: does dragging a finger across MULTIPLE physical
// switches toggle each one as it's crossed, or does touch/pointer capture lock everything to the first
// element touched (which would kill the idea outright, per the git-history warning in HAPTICS.md).
const STRIP_COUNT = 14
const STRIP_SEGMENT_PX = 26

function DetentStrip({ log, onToggle }: { log: number[]; onToggle: (i: number) => void }) {
  return (
    <div
      className="relative flex h-16 items-center border border-line-strong"
      style={{ width: STRIP_COUNT * STRIP_SEGMENT_PX, touchAction: 'none' }}
    >
      {Array.from({ length: STRIP_COUNT }, (_, i) => (
        <input
          key={i}
          type="checkbox"
          {...{ switch: '' }}
          aria-label={`detent-${i}`}
          onChange={() => onToggle(i)}
          style={{
            width: STRIP_SEGMENT_PX,
            height: '100%',
            margin: 0,
            opacity: 0,
            touchAction: 'none',
          }}
        />
      ))}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-between px-1">
        {Array.from({ length: STRIP_COUNT }, (_, i) => (
          <span
            key={i}
            className={cnm('h-6 w-px', log.includes(i) ? 'bg-brand-500' : 'bg-line-strong')}
            style={{ marginLeft: i === 0 ? 0 : undefined }}
          />
        ))}
      </div>
    </div>
  )
}

// The vertical twin of DetentStrip above. The product's real drag controls (the stake wheel, the knob)
// move on the Y axis, not X, and a switch's flip line is horizontal (WebKit recomputes it from the
// element's local midpoint), so vertical travel INSIDE one switch may never cross it. Segment height is
// selectable so the strip can mirror the two real controls exactly. Auto-resets on every new touch so one
// slide gives one clean sequence, since an accumulated multi-gesture log reads as noise (a prior test on
// the horizontal strip mixed several slides into one scrambled array).
const V_STRIP_HEIGHT_PX = 280

const SEGMENT_OPTIONS = [
  { px: 28, label: '28px (stake wheel)' },
  { px: 40, label: '40px (knob)' },
  { px: 20, label: '20px (denser)' },
] as const

function SegmentPicker({ value, onChange }: { value: number; onChange: (px: number) => void }) {
  return (
    <div className="flex gap-2">
      {SEGMENT_OPTIONS.map((opt) => (
        <button
          key={opt.px}
          onClick={() => onChange(opt.px)}
          className={cnm(
            'flex-1 border px-3 py-2 font-mono text-[11px] uppercase tracking-wider transition active:scale-[0.98]',
            value === opt.px ? 'border-brand-500 text-brand-500' : 'border-line-strong text-text-2 hover:text-text',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function VerticalDetentStrip({
  count,
  segmentPx,
  log,
  onToggle,
  onGestureStart,
}: {
  count: number
  segmentPx: number
  log: number[]
  onToggle: (i: number) => void
  onGestureStart: () => void
}) {
  return (
    <div
      className="relative flex w-16 flex-col border border-line-strong"
      style={{ height: count * segmentPx, touchAction: 'none' }}
      onPointerDown={onGestureStart}
      onTouchStart={onGestureStart}
    >
      {Array.from({ length: count }, (_, i) => (
        <input
          key={i}
          type="checkbox"
          {...{ switch: '' }}
          aria-label={`vdetent-${i}`}
          onChange={() => onToggle(i)}
          style={{
            width: '100%',
            height: segmentPx,
            margin: 0,
            appearance: 'auto',
            opacity: 0,
            touchAction: 'none',
          }}
        />
      ))}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-between py-1">
        {Array.from({ length: count }, (_, i) => (
          <span key={i} className={cnm('h-px w-6', log.includes(i) ? 'bg-brand-500' : 'bg-line-strong')} />
        ))}
      </div>
    </div>
  )
}

// The corrected transform-teleport mechanism. The flip line is recomputed from the switch's absolute
// bounding box on EVERY move, with transforms applied, so teleporting the switch far off to one side
// under a roughly stationary finger manufactures a fresh midpoint crossing per detent, independent of
// whether vertical travel alone can flip it (section 7's question). The switch itself must be the touch
// target and the listeners must live on it directly, not on a wrapping div, or iOS's touch retargeting
// (undocumented, see the memory note) may never deliver the move to this element at all.
const TELEPORT_ARM_MS = 200 // WebKit's switchHeldDelay, CheckboxInputType.cpp:202
const TELEPORT_FAR_PX = 10000 // always past 1.4x the element width, so the flip line is always crossed

function useTeleportSwitch(segmentPx: number) {
  const elRef = useRef<HTMLInputElement | null>(null)
  const armTimerRef = useRef<number | undefined>(undefined)
  const armedRef = useRef(false)
  const originYRef = useRef(0)
  const lastNRef = useRef(0)
  const signRef = useRef(1)
  const [detentsCrossed, setDetentsCrossed] = useState(0)
  const [stepCalls, setStepCalls] = useState(0)
  const [nativeToggles, setNativeToggles] = useState(0)

  function reset() {
    window.clearTimeout(armTimerRef.current)
    armedRef.current = false
    lastNRef.current = 0
    signRef.current = 1
    setDetentsCrossed(0)
    setStepCalls(0)
    setNativeToggles(0)
    const el = elRef.current
    if (el) {
      el.style.transform = ''
      el.checked = false
    }
  }

  useEffect(() => {
    const el = elRef.current
    if (!el) return

    function step() {
      setStepCalls((v) => v + 1)
      signRef.current = -signRef.current
      el!.style.transform = `translateX(${signRef.current * TELEPORT_FAR_PX}px)`
      el!.getBoundingClientRect() // forces style + layout synchronously, before WebKit's default handler runs
    }

    function onTouchStart(e: TouchEvent) {
      const t = e.targetTouches[0]
      if (!t) return
      originYRef.current = t.clientY // the touchdown y, per spec (not the arming-instant y)
      armedRef.current = false
      lastNRef.current = 0
      window.clearTimeout(armTimerRef.current)
      armTimerRef.current = window.setTimeout(() => {
        armedRef.current = true
      }, TELEPORT_ARM_MS)
    }

    function onTouchMove(e: TouchEvent) {
      if (!armedRef.current) return
      const t = e.targetTouches[0]
      if (!t) return
      const n = Math.round((originYRef.current - t.clientY) / segmentPx)
      if (n === lastNRef.current) return
      lastNRef.current = n
      setDetentsCrossed((v) => v + 1)
      step()
    }

    function onTouchEnd() {
      window.clearTimeout(armTimerRef.current)
      armedRef.current = false
      el!.style.transform = ''
      el!.checked = false
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })
    return () => {
      window.clearTimeout(armTimerRef.current)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [segmentPx])

  return { elRef, detentsCrossed, stepCalls, nativeToggles, onNativeChange: () => setNativeToggles((v) => v + 1), reset }
}

// One full-size switch, opacity 0, IS the drag surface (no decorative wrapper carrying the listeners).
function TeleportSwitchPad({
  elRef,
  appearance,
  onNativeChange,
  ariaLabel,
}: {
  elRef: React.RefObject<HTMLInputElement | null>
  appearance: 'none' | 'auto'
  onNativeChange: () => void
  ariaLabel: string
}) {
  return (
    <div
      className="relative flex w-full items-center justify-center overflow-hidden border border-line-strong"
      style={{ height: V_STRIP_HEIGHT_PX, touchAction: 'none' }}
    >
      <div className="pointer-events-none flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-text-2">
        <Vibrate size={14} />
        Drag vertically
      </div>
      <input
        ref={elRef}
        type="checkbox"
        {...{ switch: '' }}
        aria-label={ariaLabel}
        onChange={onNativeChange}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          margin: 0,
          appearance,
          opacity: 0,
          touchAction: 'none',
        }}
      />
    </div>
  )
}

// Ground truth for the A/B matrix below: our own finger-travel count, independent of whatever the real
// switches actually fire, so a mismatch between "toggles" and "detents" is visible immediately.
function useDetentGroundTruth(segmentPx: number) {
  const originYRef = useRef<number | null>(null)
  const lastNRef = useRef(0)
  const [detents, setDetents] = useState(0)

  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0]
    originYRef.current = t ? t.clientY : null
    lastNRef.current = 0
    setDetents(0)
  }

  function onTouchMove(e: React.TouchEvent) {
    if (originYRef.current === null) return
    const t = e.touches[0]
    if (!t) return
    const n = Math.round((originYRef.current - t.clientY) / segmentPx)
    if (n === lastNRef.current) return
    lastNRef.current = n
    setDetents((v) => v + 1)
  }

  function reset() {
    originYRef.current = null
    lastNRef.current = 0
    setDetents(0)
  }

  return { detents, onTouchStart, onTouchMove, reset }
}

// A vertical strip of real switches, same shape as section 7, but reporting a raw toggle count and
// taking its appearance as a prop so it can stand on either side of the A/B matrix.
function ABStripSwitches({
  count,
  segmentPx,
  appearance,
  fired,
  onToggle,
  labelPrefix,
}: {
  count: number
  segmentPx: number
  appearance: 'none' | 'auto'
  fired: number[]
  onToggle: (i: number) => void
  labelPrefix: string
}) {
  return (
    <div className="relative flex w-full flex-col border border-line-strong" style={{ height: count * segmentPx, touchAction: 'none' }}>
      {Array.from({ length: count }, (_, i) => (
        <input
          key={i}
          type="checkbox"
          {...{ switch: '' }}
          aria-label={`${labelPrefix}-${i}`}
          onChange={() => onToggle(i)}
          style={{ width: '100%', height: segmentPx, margin: 0, appearance, opacity: 0, touchAction: 'none' }}
        />
      ))}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-between py-1">
        {Array.from({ length: count }, (_, i) => (
          <span key={i} className={cnm('h-px w-6', fired.includes(i) ? 'bg-brand-500' : 'bg-line-strong')} />
        ))}
      </div>
    </div>
  )
}

// The big readable result of the A/B matrix: does the native toggle count match our ground truth.
function RatioReadout({ toggles, detents }: { toggles: number; detents: number }) {
  const settled = detents > 0
  const match = settled && toggles === detents
  return (
    <p className={cnm('mt-2 font-mono text-2xl font-bold tabular-nums', !settled ? 'text-text-3' : match ? 'text-up' : 'text-down')}>
      {toggles} / {detents}
    </p>
  )
}

// Section 10: menu row sim, just-in-time `switch` attribute vs. an always-on control, in a real scroll
// list. Only the touched element ever receives that gesture's events, so the tap-qualification state
// machine is ONE module-level object shared by every row, not per-row state, per
// menu-haptics-ios-2026-08.md section 5.
const ROW_SIM_COUNT = 20
const ROW_SIM_TAP_SLOP_PX = 10
const ROW_SIM_TAP_MAX_MS = 700

type RowSimMode = 'jit' | 'always'

type RowSimGesture = {
  active: boolean
  ok: boolean
  x: number
  y: number
  t: number
  scrollTopAtStart: number
  fired: boolean
}

function freshRowSimGesture(): RowSimGesture {
  return { active: false, ok: false, x: 0, y: 0, t: 0, scrollTopAtStart: 0, fired: false }
}

let rowSimGesture = freshRowSimGesture()

function RowSimModePicker({ value, onChange }: { value: RowSimMode; onChange: (mode: RowSimMode) => void }) {
  const options: { id: RowSimMode; label: string }[] = [
    { id: 'jit', label: 'Just-in-time (recommended)' },
    { id: 'always', label: 'Always-on switch (control)' },
  ]
  return (
    <div className="flex gap-2">
      {options.map((opt) => (
        <button
          key={opt.id}
          onClick={() => onChange(opt.id)}
          className={cnm(
            'flex-1 border px-3 py-2 font-mono text-[11px] uppercase tracking-wider transition active:scale-[0.98]',
            value === opt.id ? 'border-brand-500 text-brand-500' : 'border-line-strong text-text-2 hover:text-text',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function RowSimMetric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      {label}
      <div className="mt-1 text-lg font-bold text-brand-500">{value}</div>
    </div>
  )
}

// A real menu-like row: a label, a chevron, and an absolutely positioned opacity:0 checkbox overlay as
// the actual hit target. `always` mode renders the `switch` attribute permanently (the naive control);
// `jit` mode never renders it, the parent adds/removes it imperatively at touchend/touchstart.
function MenuSimRow({
  index,
  mode,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
  onTouchCancel,
  onClick,
  onChange,
}: {
  index: number
  mode: RowSimMode
  onTouchStart: (e: React.TouchEvent<HTMLInputElement>, input: HTMLInputElement) => void
  onTouchMove: (e: React.TouchEvent<HTMLInputElement>) => void
  onTouchEnd: (e: React.TouchEvent<HTMLInputElement>, input: HTMLInputElement) => void
  onTouchCancel: () => void
  onClick: (e: React.MouseEvent<HTMLInputElement>) => void
  onChange: () => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  return (
    <div className="relative flex h-11 items-center justify-between border-b border-line px-4">
      <span className="text-sm text-text">Menu row {index + 1}</span>
      <ChevronRight size={16} className="pointer-events-none text-text-3" />
      <input
        ref={inputRef}
        type="checkbox"
        {...(mode === 'always' ? { switch: '' } : {})}
        aria-hidden="true"
        tabIndex={-1}
        onTouchStart={(e) => onTouchStart(e, inputRef.current!)}
        onTouchMove={onTouchMove}
        onTouchEnd={(e) => onTouchEnd(e, inputRef.current!)}
        onTouchCancel={onTouchCancel}
        onClick={onClick}
        onChange={onChange}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', margin: 0, appearance: 'none', opacity: 0 }}
      />
    </div>
  )
}

// Section 11: four buttons firing the identical trigger('success') call at different points relative
// to the tap, per ios-async-haptic-paths-2026-08.md section 4. "Immediate" is the same call section 1
// already makes; the other three probe whether the user-gesture token survives a deferred continuation.
type AsyncGateId = 'immediate' | 'timeout0' | 'timeout1500' | 'promise'

const ASYNC_GATE_BUTTONS: { id: AsyncGateId; label: string; sub: string }[] = [
  { id: 'immediate', label: 'Immediate', sub: 'Inside the tap handler' },
  { id: 'timeout0', label: 'setTimeout 0', sub: 'Next tick' },
  { id: 'timeout1500', label: 'setTimeout 1500', sub: '1.5s later' },
  { id: 'promise', label: 'Promise chain', sub: 'After an awaited fetch' },
]

// Section 12: swipe to collect. The real grammar from src/lib/haptics.ts PATTERN_VIBRATIONS, copied here
// since this probe stays self-contained (see the file header note), no lib/haptics.ts import.
type SwipePattern = 'win' | 'lose' | 'cashOut' | 'achievement'

interface Pulse {
  duration: number
  delay?: number
}

const SWIPE_PATTERNS: Record<SwipePattern, Pulse[]> = {
  win: [{ duration: 20 }, { delay: 50, duration: 30 }, { delay: 50, duration: 70 }],
  lose: [{ duration: 70 }, { delay: 40, duration: 25 }],
  cashOut: [{ duration: 25 }, { delay: 45, duration: 25 }],
  achievement: [{ duration: 20 }, { delay: 40, duration: 20 }, { delay: 40, duration: 20 }, { delay: 60, duration: 90 }],
}

// Each pulse starts its own delay past the previous pulse's end. Returns the onset offset (ms from
// pattern start) for every pulse, which is the beat clock the swipe scheduler plays against.
function pulseOffsets(pulses: Pulse[]): number[] {
  let cursor = 0
  const offsets: number[] = []
  for (const p of pulses) {
    cursor += p.delay ?? 0
    offsets.push(cursor)
    cursor += p.duration
  }
  return offsets
}

const SWIPE_TRACK_WIDTH_PX = 280
// WebKit's own switchHeldDelay (CheckboxInputType.cpp:202), same constant as ConsoleCanvas.tsx's
// DIAL_TELEPORT_ARM_MS. The beat clock starts at this arming instant, not at touchdown.
const SWIPE_ARM_MS = 200
const SWIPE_TELEPORT_FAR_PX = 10000
const SWIPE_COLLECT_THRESHOLD = 0.85

function SwipePatternPicker({ value, onChange }: { value: SwipePattern; onChange: (p: SwipePattern) => void }) {
  const options: { id: SwipePattern; label: string }[] = [
    { id: 'win', label: 'Win' },
    { id: 'lose', label: 'Lose' },
    { id: 'cashOut', label: 'Cash out' },
    { id: 'achievement', label: 'Achievement' },
  ]
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => (
        <button
          key={opt.id}
          onClick={() => onChange(opt.id)}
          className={cnm(
            'flex-1 border px-3 py-2 font-mono text-[11px] uppercase tracking-wider transition active:scale-[0.98]',
            value === opt.id ? 'border-brand-500 text-brand-500' : 'border-line-strong text-text-2 hover:text-text',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// The teleport switch IS the touch target, same mechanism as DialTeleportSwitch (ConsoleCanvas.tsx),
// with a clock driving the beats instead of a detent index. `overflow: hidden` on the wrapper stops the
// ±10000px transform from creating document scroll, unlike the console canvas where the wrapper is
// already clipped by the fixed 3D viewport; this page is a normal scrolling document.
function SwipeCollectPad({ elRef, progress }: { elRef: React.RefObject<HTMLInputElement | null>; progress: number }) {
  return (
    <div
      className="relative overflow-hidden border border-line-strong"
      style={{ width: SWIPE_TRACK_WIDTH_PX, height: 56, touchAction: 'none' }}
    >
      <div className="pointer-events-none absolute inset-y-0 left-0 bg-brand-500/20" style={{ width: `${progress * 100}%` }} />
      <div
        className="pointer-events-none absolute inset-y-0 flex items-center"
        style={{ left: `calc(${Math.min(progress, 1) * 100}% - 14px)` }}
      >
        <div className="h-8 w-7 border border-brand-500 bg-black" />
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[11px] uppercase tracking-wider text-text-2">
        Swipe to collect
      </div>
      <input
        ref={elRef}
        type="checkbox"
        {...{ switch: '' }}
        aria-label="swipe-collect"
        onChange={() => {}}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          margin: 0,
          appearance: 'none',
          opacity: 0,
          touchAction: 'none',
        }}
      />
    </div>
  )
}

// Drives the beat scheduler off real elapsed time, checked once per touchmove: WebKit only ever flips
// its switch inside its own touchmove default handler (at most one flip per delivered move), so this
// checks the next scheduled beat and fires at most one teleport per move too, the same ceiling.
function useSwipeCollect(beats: number[]) {
  const elRef = useRef<HTMLInputElement | null>(null)
  const armTimerRef = useRef<number | undefined>(undefined)
  const armedRef = useRef(false)
  const startClockRef = useRef(0)
  const startXRef = useRef(0)
  const nextBeatRef = useRef(0)
  const signRef = useRef(1)
  const collectedRef = useRef(false)
  const beatsRef = useRef(beats)
  beatsRef.current = beats

  const [beatsFired, setBeatsFired] = useState(0)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [progress, setProgress] = useState(0)
  const [collectedCount, setCollectedCount] = useState(0)

  function reset() {
    window.clearTimeout(armTimerRef.current)
    armedRef.current = false
    nextBeatRef.current = 0
    signRef.current = 1
    collectedRef.current = false
    setBeatsFired(0)
    setElapsedMs(0)
    setProgress(0)
    const el = elRef.current
    if (el) {
      el.style.transform = ''
      el.checked = false
    }
  }

  useEffect(() => {
    const el = elRef.current
    if (!el) return

    function tick() {
      signRef.current = -signRef.current
      el!.style.transform = `translateX(${signRef.current * SWIPE_TELEPORT_FAR_PX}px)`
      el!.getBoundingClientRect() // forces style + layout synchronously, before WebKit's default handler runs
    }

    function onTouchStart(e: TouchEvent) {
      const t = e.targetTouches[0]
      if (!t) return
      el!.style.transform = ''
      startXRef.current = t.clientX
      armedRef.current = false
      nextBeatRef.current = 0
      collectedRef.current = false
      setBeatsFired(0)
      setElapsedMs(0)
      setProgress(0)
      window.clearTimeout(armTimerRef.current)
      armTimerRef.current = window.setTimeout(() => {
        armedRef.current = true
        startClockRef.current = performance.now() // beats are scheduled from the ARMING instant, not touchdown
        // No warm-up tick here: teleporting before WebKit captures its touchdown anchor kills every later
        // flip (ConsoleCanvas.tsx's DialTeleportSwitch comment, the same regression).
      }, SWIPE_ARM_MS)
    }

    function onTouchMove(e: TouchEvent) {
      const t = e.targetTouches[0]
      if (!t) return
      const dx = t.clientX - startXRef.current
      const p = Math.max(0, Math.min(1, dx / SWIPE_TRACK_WIDTH_PX))
      setProgress(p)
      if (p >= SWIPE_COLLECT_THRESHOLD && !collectedRef.current) {
        collectedRef.current = true
        setCollectedCount((v) => v + 1)
      }
      if (!armedRef.current) return
      const elapsed = performance.now() - startClockRef.current
      setElapsedMs(Math.round(elapsed))
      const scheduled = beatsRef.current
      if (nextBeatRef.current < scheduled.length && elapsed >= scheduled[nextBeatRef.current]) {
        tick()
        nextBeatRef.current += 1
        setBeatsFired((v) => v + 1)
      }
    }

    function onTouchEnd() {
      window.clearTimeout(armTimerRef.current)
      armedRef.current = false
      el!.style.transform = ''
      el!.checked = false
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })
    return () => {
      window.clearTimeout(armTimerRef.current)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [])

  return { elRef, beatsFired, elapsedMs, progress, collectedCount, reset }
}

function NoteField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={3}
      className="mt-3 w-full resize-none border border-line bg-transparent px-3 py-2 text-sm text-text placeholder:text-text-3 focus:border-brand-500 focus:outline-none"
    />
  )
}

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line pt-6">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-[11px] text-brand-500">{n}</span>
        <h2 className="text-base font-bold tracking-tight">{title}</h2>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  )
}

// Read-only device facts, resolved client-side only. Never read navigator during render (hydration
// mismatch): render the "checking..." placeholder on both server and first client pass, then fill in
// the real values from an effect once mounted.
type DeviceReadout = {
  supported: string
  vibrateType: string
  hapticsEnabled: string
  ua: string
}

const CHECKING: DeviceReadout = { supported: 'checking...', vibrateType: 'checking...', hapticsEnabled: 'checking...', ua: 'checking...' }

function useDeviceReadout(): DeviceReadout {
  const [readout, setReadout] = useState<DeviceReadout>(CHECKING)

  useEffect(() => {
    if (typeof navigator === 'undefined') return
    setReadout({
      supported: String(WebHaptics.isSupported),
      vibrateType: typeof navigator.vibrate,
      hapticsEnabled: String(isHapticsEnabled()),
      ua: navigator.userAgent,
    })
  }, [])

  return readout
}

function ReadoutStrip({ readout }: { readout: DeviceReadout }) {
  return (
    <div className="border border-line-strong bg-surface px-4 py-3 font-mono text-[11px] uppercase tracking-wider text-text-2">
      <div>
        WebHaptics.isSupported: <span className="text-brand-500">{readout.supported}</span>
      </div>
      <div>
        typeof navigator.vibrate: <span className="text-brand-500">{readout.vibrateType}</span>
      </div>
      <div>
        isHapticsEnabled(): <span className="text-brand-500">{readout.hapticsEnabled}</span>
      </div>
      <div className="mt-1 truncate normal-case tracking-normal text-text-3">{readout.ua}</div>
    </div>
  )
}

function HapticsLab() {
  const [notes, setNotes] = useState<Record<string, string>>({
    q1: '',
    q2: '',
    q3: '',
    q4: '',
    q5: '',
    q6: '',
    q7: '',
    q8: '',
    q9: '',
    q10: '',
    q11: '',
    q12: '',
  })
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'unavailable'>('idle')
  const dragFireCount = useRef(0)
  const [dragFires, setDragFires] = useState(0)
  const webHapticsRef = useRef<WebHaptics | null>(null)
  const tapPadRef = useRef<HTMLInputElement | null>(null)
  const [stripLog, setStripLog] = useState<number[]>([])
  const readout = useDeviceReadout()

  // Section 7: vertical detent strip.
  const vLogRef = useRef<number[]>([])
  const [vSegmentPx, setVSegmentPxState] = useState<number>(28)
  const [vLog, setVLog] = useState<number[]>([])
  const [vPrevLog, setVPrevLog] = useState<number[]>([])
  const vCount = Math.max(1, Math.round(V_STRIP_HEIGHT_PX / vSegmentPx))

  useEffect(() => {
    vLogRef.current = vLog
  }, [vLog])

  // Section 8: the corrected transform-teleport mechanism.
  const [wSegmentPx, setWSegmentPxState] = useState<number>(28)
  const s8 = useTeleportSwitch(wSegmentPx)

  // Section 9: the A/B matrix, same segment size as section 8.
  const abCount = Math.max(1, Math.round(V_STRIP_HEIGHT_PX / wSegmentPx))
  const gt9a = useDetentGroundTruth(wSegmentPx)
  const gt9b = useDetentGroundTruth(wSegmentPx)
  const s9c = useTeleportSwitch(wSegmentPx)
  const s9d = useTeleportSwitch(wSegmentPx)
  const [toggles9a, setToggles9a] = useState(0)
  const [toggles9b, setToggles9b] = useState(0)
  const [fired9a, setFired9a] = useState<number[]>([])
  const [fired9b, setFired9b] = useState<number[]>([])

  function onStripToggle(i: number) {
    setStripLog((prev) => [...prev, i])
  }

  function setVSegment(px: number) {
    setVSegmentPxState(px)
    setVLog([])
    setVPrevLog([])
  }

  function onVToggle(i: number) {
    setVLog((prev) => [...prev, i])
  }

  function onVGestureStart() {
    if (vLogRef.current.length > 0) setVPrevLog(vLogRef.current)
    setVLog([])
  }

  function setWSegment(px: number) {
    setWSegmentPxState(px)
    s8.reset()
    s9c.reset()
    s9d.reset()
    gt9a.reset()
    gt9b.reset()
    setToggles9a(0)
    setToggles9b(0)
    setFired9a([])
    setFired9b([])
  }

  function onGesture9aStart(e: React.TouchEvent) {
    setToggles9a(0)
    setFired9a([])
    gt9a.onTouchStart(e)
  }

  function onToggle9a(i: number) {
    setToggles9a((v) => v + 1)
    setFired9a((prev) => [...prev, i])
  }

  function onGesture9bStart(e: React.TouchEvent) {
    setToggles9b(0)
    setFired9b([])
    gt9b.onTouchStart(e)
  }

  function onToggle9b(i: number) {
    setToggles9b((v) => v + 1)
    setFired9b((prev) => [...prev, i])
  }

  // Section 10: menu row sim.
  const [rowSimMode, setRowSimMode] = useState<RowSimMode>('jit')
  const [tapsQualified, setTapsQualified] = useState(0)
  const [attributeAdds, setAttributeAdds] = useState(0)
  const [actionsFired, setActionsFired] = useState(0)
  const [nativeChanges, setNativeChanges] = useState(0)
  const [gesturesRejected, setGesturesRejected] = useState(0)
  const rowSimContainerRef = useRef<HTMLDivElement | null>(null)
  const rowSimModeRef = useRef(rowSimMode)

  useEffect(() => {
    rowSimModeRef.current = rowSimMode
  }, [rowSimMode])

  function finishRowSimGesture(qualifies: boolean) {
    if (!rowSimGesture.active) return
    rowSimGesture.active = false
    if (qualifies) setTapsQualified((v) => v + 1)
    else setGesturesRejected((v) => v + 1)
  }

  function onRowSimContainerScroll() {
    if (rowSimGesture.active) finishRowSimGesture(false)
  }

  function onRowSimTouchStart(e: React.TouchEvent<HTMLInputElement>, input: HTMLInputElement) {
    // inert at rest: remove any attribute a previous gesture left behind before arming the next one
    if (rowSimModeRef.current === 'jit' && input.hasAttribute('switch')) input.removeAttribute('switch')
    const t = e.touches[0]
    const container = rowSimContainerRef.current
    if (!t || !container) return
    rowSimGesture = {
      active: true,
      ok: e.touches.length === 1,
      x: t.clientX,
      y: t.clientY,
      t: performance.now(),
      scrollTopAtStart: container.scrollTop,
      fired: false,
    }
  }

  function onRowSimTouchMove(e: React.TouchEvent<HTMLInputElement>) {
    if (!rowSimGesture.active) return
    if (e.touches.length !== 1) {
      rowSimGesture.ok = false
      return
    }
    const t = e.touches[0]
    if (!t) return
    if (Math.abs(t.clientX - rowSimGesture.x) > ROW_SIM_TAP_SLOP_PX || Math.abs(t.clientY - rowSimGesture.y) > ROW_SIM_TAP_SLOP_PX) {
      rowSimGesture.ok = false
    }
  }

  function onRowSimTouchEnd(_e: React.TouchEvent<HTMLInputElement>, input: HTMLInputElement) {
    if (!rowSimGesture.active) return
    const container = rowSimContainerRef.current
    const elapsed = performance.now() - rowSimGesture.t
    const scrolled = container ? container.scrollTop !== rowSimGesture.scrollTopAtStart : false
    const qualifies = rowSimGesture.ok && elapsed <= ROW_SIM_TAP_MAX_MS && !scrolled
    finishRowSimGesture(qualifies)
    if (!qualifies || rowSimModeRef.current !== 'jit') return

    // gate on the absence of navigator.vibrate and isHapticsEnabled(), read live, not at render
    const iosNoVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate !== 'function'
    if (iosNoVibrate && isHapticsEnabled()) {
      input.setAttribute('switch', '')
      input.getBoundingClientRect() // forces style + layout before WebKit's default handler runs
      setAttributeAdds((v) => v + 1)
    }
  }

  function onRowSimTouchCancel() {
    finishRowSimGesture(false)
  }

  function onRowSimClick(e: React.MouseEvent<HTMLInputElement>) {
    e.preventDefault() // no stray `change`, CheckboxInputType.cpp:257-268
    if (rowSimGesture.fired) return
    rowSimGesture.fired = true
    setActionsFired((v) => v + 1)
  }

  function onRowSimChange() {
    setNativeChanges((v) => v + 1)
  }

  function resetRowSimCounters() {
    rowSimGesture = freshRowSimGesture()
    setTapsQualified(0)
    setAttributeAdds(0)
    setActionsFired(0)
    setNativeChanges(0)
    setGesturesRejected(0)
  }

  // Section 11: async gate probe.
  const [asyncGateCounts, setAsyncGateCounts] = useState<Record<AsyncGateId, number>>({
    immediate: 0,
    timeout0: 0,
    timeout1500: 0,
    promise: 0,
  })
  const [uaCopyState, setUaCopyState] = useState<'idle' | 'copied' | 'unavailable'>('idle')

  function runAsyncGate(id: AsyncGateId) {
    function fire() {
      getWebHaptics().trigger('success')
      setAsyncGateCounts((prev) => ({ ...prev, [id]: prev[id] + 1 }))
    }
    if (id === 'immediate') {
      fire()
      return
    }
    if (id === 'timeout0') {
      window.setTimeout(fire, 0)
      return
    }
    if (id === 'timeout1500') {
      window.setTimeout(fire, 1500)
      return
    }
    // Promise chain: fires after an awaited same-origin fetch, the more honest stand-in for an SSE frame.
    fetch('/favicon.ico', { cache: 'no-store' }).then(fire).catch(fire)
  }

  async function copyUA() {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard')
      await navigator.clipboard.writeText(readout.ua)
      setUaCopyState('copied')
      setTimeout(() => setUaCopyState('idle'), 2000)
    } catch {
      setUaCopyState('unavailable')
    }
  }

  // Section 12: swipe to collect.
  const [swipePattern, setSwipePattern] = useState<SwipePattern>('win')
  const swipeBeats = useMemo(() => pulseOffsets(SWIPE_PATTERNS[swipePattern]), [swipePattern])
  const swipe = useSwipeCollect(swipeBeats)

  function changeSwipePattern(p: SwipePattern) {
    setSwipePattern(p)
    swipe.reset()
  }

  function getWebHaptics() {
    if (!webHapticsRef.current) webHapticsRef.current = new WebHaptics()
    return webHapticsRef.current
  }

  function note(key: string, v: string) {
    setNotes((prev) => ({ ...prev, [key]: v }))
  }

  async function copyAll() {
    const text = [
      '## Phase 0.5 probe results',
      '',
      `Readout: WebHaptics.isSupported=${readout.supported}, typeof navigator.vibrate=${readout.vibrateType}, isHapticsEnabled()=${readout.hapticsEnabled}`,
      `UA: ${readout.ua}`,
      '',
      '1. web-haptics default (showSwitch: false):',
      notes.q1 || '(no notes)',
      '',
      '2. Rendered opacity:0 switch (direct tap + programmatic click):',
      notes.q2 || '(no notes)',
      '',
      '3. Rendered switch, dragged:',
      notes.q3 || '(no notes)',
      '',
      '4. Level comparison (low/mid/high):',
      notes.q4 || '(no notes)',
      '',
      '5. appearance:none vs appearance:auto:',
      notes.q5 || '(no notes)',
      '',
      '6. Detent strip (real per-switch toggle log, no pointermove noise):',
      `Raw sequence: [${stripLog.join(', ')}]`,
      notes.q6 || '(no notes)',
      '',
      '7. Vertical detent strip (the real dial axis):',
      `Segment: ${vSegmentPx}px, switch count: ${vCount}`,
      `Sequence: [${vLog.join(', ')}], toggles: ${vLog.length}, distinct: ${new Set(vLog).size}`,
      `Previous slide: [${vPrevLog.join(', ')}] (${vPrevLog.length} toggles)`,
      notes.q7 || '(no notes)',
      '',
      '8. Transform-teleport wheel sim, switch is the drag surface:',
      `Segment: ${wSegmentPx}px, detents crossed: ${s8.detentsCrossed}, step() calls: ${s8.stepCalls}, native toggles: ${s8.nativeToggles}`,
      notes.q8 || '(no notes)',
      '',
      '9. A/B matrix (toggles / detents), same segment size as section 8:',
      `9a strip+auto: ${toggles9a} / ${gt9a.detents}`,
      `9b strip+none: ${toggles9b} / ${gt9b.detents}`,
      `9c teleport+auto: ${s9c.nativeToggles} / ${s9c.detentsCrossed}`,
      `9d teleport+none: ${s9d.nativeToggles} / ${s9d.detentsCrossed}`,
      notes.q9 || '(no notes)',
      '',
      '10. Menu row sim (just-in-time switch in a scroll list):',
      `Mode at time of copy: ${rowSimMode}`,
      `Taps qualified: ${tapsQualified}, attribute adds: ${attributeAdds}, actions fired: ${actionsFired}, native change events: ${nativeChanges}, gestures rejected: ${gesturesRejected}`,
      notes.q10 || '(no notes)',
      '',
      '11. Async gate (same trigger(\'success\') call, different timing):',
      `Presses: immediate=${asyncGateCounts.immediate}, setTimeout0=${asyncGateCounts.timeout0}, setTimeout1500=${asyncGateCounts.timeout1500}, promise=${asyncGateCounts.promise}`,
      notes.q11 || '(no notes)',
      '',
      '12. Swipe to collect (teleport switch, real multi-pulse rhythm):',
      `Pattern: ${swipePattern}, beats scheduled: ${swipeBeats.length}, beats fired: ${swipe.beatsFired}, elapsed: ${swipe.elapsedMs}ms, collected: ${swipe.collectedCount}`,
      notes.q12 || '(no notes)',
    ].join('\n')

    try {
      if (!navigator.clipboard) throw new Error('no clipboard')
      await navigator.clipboard.writeText(text)
      setCopyState('copied')
      setTimeout(() => setCopyState('idle'), 2000)
    } catch {
      setCopyState('unavailable')
    }
  }

  const allNotesText = Object.values(notes).some((v) => v.trim())
    ? [
        `1. ${notes.q1}`,
        `2. ${notes.q2}`,
        `3. ${notes.q3}`,
        `4. ${notes.q4}`,
        `5. ${notes.q5}`,
        `6. [${stripLog.join(', ')}] ${notes.q6}`,
        `7. [${vLog.join(', ')}] prev=[${vPrevLog.join(', ')}] ${notes.q7}`,
        `8. crossed=${s8.detentsCrossed} steps=${s8.stepCalls} toggled=${s8.nativeToggles} ${notes.q8}`,
        `9. 9a=${toggles9a}/${gt9a.detents} 9b=${toggles9b}/${gt9b.detents} 9c=${s9c.nativeToggles}/${s9c.detentsCrossed} 9d=${s9d.nativeToggles}/${s9d.detentsCrossed} ${notes.q9}`,
        `10. mode=${rowSimMode} qualified=${tapsQualified} adds=${attributeAdds} fired=${actionsFired} change=${nativeChanges} rejected=${gesturesRejected} ${notes.q10}`,
        `11. immediate=${asyncGateCounts.immediate} timeout0=${asyncGateCounts.timeout0} timeout1500=${asyncGateCounts.timeout1500} promise=${asyncGateCounts.promise} ${notes.q11}`,
        `12. pattern=${swipePattern} scheduled=${swipeBeats.length} fired=${swipe.beatsFired} elapsed=${swipe.elapsedMs}ms collected=${swipe.collectedCount} ${notes.q12}`,
      ].join('\n\n')
    : ''

  return (
    <div className="min-h-dvh w-full bg-black px-5 pb-24 pt-[max(env(safe-area-inset-top),1.25rem)] text-text sm:px-8">
      <div className="mx-auto w-full max-w-2xl">
        <ReadoutStrip readout={readout} />

        <header className="mt-6 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-6">
          <div>
            <div className="flex items-center gap-2 text-brand-500">
              <Vibrate size={16} />
              <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em]">Haptics Probe</span>
            </div>
            <h1 className="mt-2 text-2xl font-bold tracking-tight">Phase 0.5: answer by feel</h1>
            <p className="mt-1 max-w-xl text-sm text-text-3">
              Open on the phone. Work top to bottom, write what you feel in each box, then copy all notes back into
              HAPTICS.md §3. This page is throwaway, delete it once the answers are recorded.
            </p>
          </div>
          <Link
            to="/dev"
            className="border border-line-strong px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-text-2 transition hover:text-text"
          >
            Back to /dev
          </Link>
        </header>

        <div className="mt-8 space-y-8">
          <Section n={1} title="web-haptics default (showSwitch: false)">
            <p className="text-sm text-text-2">
              <code className="text-brand-500">new WebHaptics().trigger(&apos;success&apos;)</code> with the library&apos;s
              default options.
            </p>
            <button
              onClick={() => getWebHaptics().trigger('success')}
              className="mt-3 border border-line-strong px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-text-2 transition active:scale-[0.98] hover:border-brand-500 hover:text-brand-500"
            >
              Trigger &apos;success&apos;
            </button>
            <p className="mt-3 font-mono text-[11px] uppercase tracking-wider text-text-3">Does this tick on iOS?</p>
            <NoteField value={notes.q1} onChange={(v) => note('q1', v)} placeholder="What did you feel, if anything?" />
          </Section>

          <Section n={2} title="Rendered opacity:0 switch, tap">
            <p className="text-sm text-text-2">
              A real <code className="text-brand-500">{'<input type="checkbox" switch>'}</code>, hidden with opacity + clip-path
              (never display:none), sized to fill the pill below. The pill is decoration only.
            </p>
            <div className="mt-3">
              <TapPad id="tap-pad-1" inputRef={tapPadRef} />
            </div>
            <button
              onClick={() => tapPadRef.current?.click()}
              className="mt-3 border border-line-strong px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-text-2 transition active:scale-[0.98] hover:border-brand-500 hover:text-brand-500"
            >
              Click it programmatically
            </button>
            <p className="mt-3 font-mono text-[11px] uppercase tracking-wider text-text-3">
              Two paths, answer both. (a) Tap the pill directly. (b) Press the button above, which calls
              <code className="text-brand-500"> .click()</code> on the same switch from a separate gesture, the ios-haptics shape.
              Does either tick?
            </p>
            <NoteField value={notes.q2} onChange={(v) => note('q2', v)} placeholder="a) direct tap: ... b) programmatic click: ..." />
          </Section>

          <Section n={3} title="Rendered switch, dragged">
            <p className="text-sm text-text-2">Same construction, wider, like a slider track.</p>
            <div className="mt-3">
              <TapPad
                id="tap-pad-2"
                wide
                onFire={() => {
                  dragFireCount.current += 1
                  setDragFires(dragFireCount.current)
                }}
                onDragFire={() => {
                  dragFireCount.current += 1
                  setDragFires(dragFireCount.current)
                }}
              />
            </div>
            <p className="mt-3 font-mono text-[11px] uppercase tracking-wider text-text-3">
              Press and slide your finger across this bar without lifting. Does it tick once, multiple times, or never?
            </p>
            <p className="mt-1 font-mono text-[11px] text-text-3">
              Toggle events fired this session: <span className="text-brand-500">{dragFires}</span>
            </p>
            <NoteField value={notes.q3} onChange={(v) => note('q3', v)} placeholder="Once, multiple, or never? Describe the feel." />
          </Section>

          <Section n={4} title="Level comparison">
            <p className="text-sm text-text-2">Raw navigator.vibrate, intensity baked into duration only, single pulses.</p>
            <div className="mt-3 flex gap-2">
              {LEVELS.map((lvl) => (
                <button
                  key={lvl.id}
                  onClick={() => navigator.vibrate?.(lvl.ms)}
                  className="flex-1 border border-line-strong px-4 py-3 text-center font-mono text-[11px] uppercase tracking-wider text-text-2 transition active:scale-[0.98] hover:border-brand-500 hover:text-brand-500"
                >
                  {lvl.label}
                  <span className="mt-0.5 block text-text-3">{lvl.ms}ms</span>
                </button>
              ))}
            </div>
            <p className="mt-3 font-mono text-[11px] uppercase tracking-wider text-text-3">
              Press each in sequence with eyes closed. Can you tell them apart?
            </p>
            <NoteField value={notes.q4} onChange={(v) => note('q4', v)} placeholder="Distinguishable? Which felt strongest/weakest?" />
          </Section>

          <Section n={5} title="Console button appearance test (B6.5)">
            <p className="text-sm text-text-2">
              Left = <code className="text-brand-500">appearance: none</code> (what ConsoleCanvas ships today). Right ={' '}
              <code className="text-brand-500">appearance: auto</code>. Both opacity:0 otherwise identical.
            </p>
            <div className="mt-3 flex gap-2">
              <TapPad id="tap-pad-appearance-none" appearance="none" />
              <TapPad id="tap-pad-appearance-auto" appearance="auto" />
            </div>
            <p className="mt-3 font-mono text-[11px] uppercase tracking-wider text-text-3">
              Tap each. Does either tick? Also press a real physical console button on the device (in the actual app,
              not this page) and note whether you feel anything at all today.
            </p>
            <NoteField value={notes.q5} onChange={(v) => note('q5', v)} placeholder="None, auto, both, or neither?" />
          </Section>

          <Section n={6} title="Detent strip: does dragging cross multiple real switches?">
            <p className="text-sm text-text-2">
              {STRIP_COUNT} adjacent real switches, {STRIP_SEGMENT_PX}px each. Unlike section 3, this ONLY logs a
              genuine native toggle (<code className="text-brand-500">onChange</code>), never a raw pointer move, so
              the count below is trustworthy. This is the actual mechanism a working scroll wheel needs: does each
              switch toggle as your finger crosses it, or does the touch stay locked to the first one you touched?
            </p>
            <div className="mt-3 overflow-x-auto">
              <DetentStrip log={stripLog} onToggle={onStripToggle} />
            </div>
            <p className="mt-3 font-mono text-[11px] uppercase tracking-wider text-text-3">
              Drag one finger, without lifting, all the way from left to right across the strip. Do you feel one
              buzz, several separate buzzes as you cross each tick mark, or nothing?
            </p>
            <p className="mt-1 font-mono text-[11px] text-text-3">
              Real toggle sequence, in order: <span className="text-brand-500">[{stripLog.join(', ')}]</span>
              {' · '}
              distinct switches fired: <span className="text-brand-500">{new Set(stripLog).size}</span> / {STRIP_COUNT}
            </p>
            <button
              onClick={() => setStripLog([])}
              className="mt-2 border border-line-strong px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-text-2 transition active:scale-[0.98] hover:border-brand-500 hover:text-brand-500"
            >
              Reset log
            </button>
            <NoteField
              value={notes.q6}
              onChange={(v) => note('q6', v)}
              placeholder="One buzz, several distinct buzzes, or nothing? Does the sequence above look like [0,1,2,3...] (each one fired in order) or all zeros/stuck on one number (locked to the first switch)?"
            />
          </Section>

          <Section n={7} title="Vertical detent strip (the real dial axis)">
            <p className="text-sm text-text-2">
              The stake wheel and knob drag vertically, not horizontally like section 6&apos;s strip, and a
              switch&apos;s flip line is horizontal, so vertical travel inside a single switch may never cross it.
              This stacks real switches vertically at a real control&apos;s segment height. The log clears on every
              new touch, so each slide down (or up) gives one clean sequence instead of several gestures mixed
              together.
            </p>
            <div className="mt-3">
              <SegmentPicker value={vSegmentPx} onChange={setVSegment} />
            </div>
            <p className="mt-2 font-mono text-[11px] uppercase tracking-wider text-text-3">
              Switch count: <span className="text-brand-500">{vCount}</span>
            </p>
            <div className="mt-3">
              <VerticalDetentStrip
                count={vCount}
                segmentPx={vSegmentPx}
                log={vLog}
                onToggle={onVToggle}
                onGestureStart={onVGestureStart}
              />
            </div>
            <p className="mt-3 font-mono text-[11px] uppercase tracking-wider text-text-3">
              Slide one finger down (or up) the column, without lifting. Do you feel one buzz per switch, several
              buzzes, or does it lock to the first one you touched?
            </p>
            <p className="mt-1 font-mono text-[11px] text-text-3">
              Sequence: <span className="text-brand-500">[{vLog.join(', ')}]</span>
              {' · '}
              toggles: <span className="text-brand-500">{vLog.length}</span>
              {' · '}
              distinct: <span className="text-brand-500">{new Set(vLog).size}</span> / {vCount}
            </p>
            <p className="mt-1 font-mono text-[11px] text-text-3">
              Previous slide: <span className="text-brand-500">[{vPrevLog.join(', ')}]</span> ({vPrevLog.length} toggles)
            </p>
            <NoteField
              value={notes.q7}
              onChange={(v) => note('q7', v)}
              placeholder="One buzz per switch, several, locked to the first one, or nothing? Compare to section 6's horizontal result."
            />
          </Section>

          <Section n={8} title="Corrected wheel sim: switch is the drag surface, transform teleport">
            <p className="text-sm text-text-2">
              Fixes section 7&apos;s dead-end two ways: the switch itself is the touch target (listeners live on
              the input via a ref, not on a wrapping div), and the transform is written directly to{' '}
              <code className="text-brand-500">el.style</code>, flushed with a synchronous{' '}
              <code className="text-brand-500">getBoundingClientRect()</code>, never through React state. 200ms
              after touchstart (WebKit&apos;s own arming delay) the drag arms and the detent index is computed from
              the touchdown y. Appearance is fixed at <code className="text-brand-500">none</code> here (section 9
              isolates that variable).
            </p>
            <div className="mt-3">
              <SegmentPicker value={wSegmentPx} onChange={setWSegment} />
            </div>
            <div className="mt-3">
              <TeleportSwitchPad elRef={s8.elRef} appearance="none" onNativeChange={s8.onNativeChange} ariaLabel="teleport-switch-8" />
            </div>
            <p className="mt-3 font-mono text-[11px] uppercase tracking-wider text-text-3">
              Drag one finger straight down (or up) inside the pad, without lifting, holding past the 200ms mark.
              These three numbers are the result: do they climb together?
            </p>
            <div className="mt-2 grid grid-cols-3 gap-3 font-mono text-[11px] uppercase tracking-wider text-text-3">
              <div>
                Detents crossed
                <div className="mt-1 text-lg font-bold text-brand-500">{s8.detentsCrossed}</div>
              </div>
              <div>
                step() calls
                <div className="mt-1 text-lg font-bold text-brand-500">{s8.stepCalls}</div>
              </div>
              <div>
                Native toggles
                <div className="mt-1 text-lg font-bold text-brand-500">{s8.nativeToggles}</div>
              </div>
            </div>
            <button
              onClick={s8.reset}
              className="mt-3 border border-line-strong px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-text-2 transition active:scale-[0.98] hover:border-brand-500 hover:text-brand-500"
            >
              Reset
            </button>
            <NoteField
              value={notes.q8}
              onChange={(v) => note('q8', v)}
              placeholder="Do detents crossed, step() calls, and native toggles all match? If not, which one lags and by how much?"
            />
          </Section>

          <Section n={9} title="A/B matrix: strip vs. transform, appearance auto vs. none">
            <p className="text-sm text-text-2">
              Four identical pads, all at the same segment size selected above. Each isolates one variable against
              today&apos;s known-working baseline (9a) so the strip&apos;s success and the transform&apos;s silence
              stop being two unrelated facts. Every pad shows its own native toggle count against an independent
              ground-truth detent count computed from raw finger travel, and resets both on every new touch.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-4">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-wider text-text-3">
                  9a. Strip, appearance auto <span className="text-text-3">(today&apos;s baseline)</span>
                </p>
                <div className="mt-2" onTouchStart={onGesture9aStart} onTouchMove={gt9a.onTouchMove}>
                  <ABStripSwitches
                    count={abCount}
                    segmentPx={wSegmentPx}
                    appearance="auto"
                    fired={fired9a}
                    onToggle={onToggle9a}
                    labelPrefix="ab-9a"
                  />
                </div>
                <RatioReadout toggles={toggles9a} detents={gt9a.detents} />
              </div>
              <div>
                <p className="font-mono text-[11px] uppercase tracking-wider text-text-3">9b. Strip, appearance none</p>
                <div className="mt-2" onTouchStart={onGesture9bStart} onTouchMove={gt9b.onTouchMove}>
                  <ABStripSwitches
                    count={abCount}
                    segmentPx={wSegmentPx}
                    appearance="none"
                    fired={fired9b}
                    onToggle={onToggle9b}
                    labelPrefix="ab-9b"
                  />
                </div>
                <RatioReadout toggles={toggles9b} detents={gt9b.detents} />
              </div>
              <div>
                <p className="font-mono text-[11px] uppercase tracking-wider text-text-3">
                  9c. Transform teleport, appearance auto
                </p>
                <div className="mt-2">
                  <TeleportSwitchPad elRef={s9c.elRef} appearance="auto" onNativeChange={s9c.onNativeChange} ariaLabel="ab-9c" />
                </div>
                <RatioReadout toggles={s9c.nativeToggles} detents={s9c.detentsCrossed} />
              </div>
              <div>
                <p className="font-mono text-[11px] uppercase tracking-wider text-text-3">
                  9d. Transform teleport, appearance none <span className="text-text-3">(what shipped, silent)</span>
                </p>
                <div className="mt-2">
                  <TeleportSwitchPad elRef={s9d.elRef} appearance="none" onNativeChange={s9d.onNativeChange} ariaLabel="ab-9d" />
                </div>
                <RatioReadout toggles={s9d.nativeToggles} detents={s9d.detentsCrossed} />
              </div>
            </div>
            <p className="mt-4 font-mono text-[11px] uppercase tracking-wider text-text-3">
              Drag each pad the same slow, deliberate way, one continuous slide, holding past the 200ms mark on 9c
              and 9d. Report all four toggles/detents ratios below.
            </p>
            <NoteField
              value={notes.q9}
              onChange={(v) => note('q9', v)}
              placeholder="9a: x/y  9b: x/y  9c: x/y  9d: x/y. Which ratios match? Does appearance or the mechanism explain the gap?"
            />
          </Section>

          <Section n={10} title="Menu row sim: just-in-time switch in a scroll list">
            <p className="text-sm text-text-2">
              The design from <code className="text-brand-500">menu-haptics-ios-2026-08.md</code> section 5. At rest
              every row is an inert checkbox, no <code className="text-brand-500">switch</code> attribute. On a
              qualifying tap the attribute is added at <code className="text-brand-500">touchend</code>, before
              WebKit&apos;s default handler runs, then removed again on the next touchstart. The action stays on{' '}
              <code className="text-brand-500">click</code>, latched once per gesture. Flip to the always-on control
              to feel the difference, scrolling still works normally either way.
            </p>

            <div className="mt-3">
              <RowSimModePicker value={rowSimMode} onChange={setRowSimMode} />
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 font-mono text-[11px] uppercase tracking-wider text-text-3 sm:grid-cols-5">
              <RowSimMetric label="Taps qualified" value={tapsQualified} />
              <RowSimMetric label="Attribute adds" value={attributeAdds} />
              <RowSimMetric label="Actions fired" value={actionsFired} />
              <RowSimMetric label="Native change" value={nativeChanges} />
              <RowSimMetric label="Rejected" value={gesturesRejected} />
            </div>

            <div
              ref={rowSimContainerRef}
              onScroll={onRowSimContainerScroll}
              className="mt-4 overflow-y-auto overscroll-contain border border-line-strong"
              style={{ height: 260 }}
            >
              {Array.from({ length: ROW_SIM_COUNT }, (_, i) => (
                <MenuSimRow
                  key={i}
                  index={i}
                  mode={rowSimMode}
                  onTouchStart={onRowSimTouchStart}
                  onTouchMove={onRowSimTouchMove}
                  onTouchEnd={onRowSimTouchEnd}
                  onTouchCancel={onRowSimTouchCancel}
                  onClick={onRowSimClick}
                  onChange={onRowSimChange}
                />
              ))}
            </div>

            <button
              onClick={resetRowSimCounters}
              className="mt-3 border border-line-strong px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-text-2 transition active:scale-[0.98] hover:border-brand-500 hover:text-brand-500"
            >
              Reset counters
            </button>

            <div className="mt-4 space-y-1 font-mono text-[11px] uppercase tracking-wider text-text-3">
              <p>1. Tap ten rows deliberately. How many buzzed?</p>
              <p>2. Flick-scroll the list hard, ten times. How many buzzed?</p>
              <p>3. Slow drag-scroll the list. How many buzzed?</p>
              <p>4. Flip to always-on, repeat the flick-scroll. Does the control misfire?</p>
            </div>
            <NoteField
              value={notes.q10}
              onChange={(v) => note('q10', v)}
              placeholder="1) taps buzzed: ...  2) flick-scroll buzzed: ...  3) slow drag buzzed: ...  4) always-on misfired: ..."
            />
          </Section>

          <Section n={11} title="Async gate: does a delayed haptic still fire?">
            <p className="text-sm text-text-2">
              All four buttons call the exact same{' '}
              <code className="text-brand-500">getWebHaptics().trigger(&apos;success&apos;)</code>, differing only
              in when it runs relative to this tap.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {ASYNC_GATE_BUTTONS.map((btn) => (
                <button
                  key={btn.id}
                  onClick={() => runAsyncGate(btn.id)}
                  className="border border-line-strong px-4 py-3 text-center font-mono text-[11px] uppercase tracking-wider text-text-2 transition active:scale-[0.98] hover:border-brand-500 hover:text-brand-500"
                >
                  {btn.label}
                  <span className="mt-0.5 block normal-case tracking-normal text-text-3">{btn.sub}</span>
                  <span className="mt-1 block text-brand-500">{asyncGateCounts[btn.id]} presses</span>
                </button>
              ))}
            </div>

            <div className="mt-4 border border-line-strong bg-surface px-3 py-2 font-mono text-[11px]">
              <span className="block uppercase tracking-wider text-text-3">navigator.userAgent</span>
              <span className="mt-1 block break-all normal-case tracking-normal text-text-2">{readout.ua}</span>
            </div>
            <button
              onClick={copyUA}
              className="mt-2 border border-line-strong px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-text-2 transition active:scale-[0.98] hover:border-brand-500 hover:text-brand-500"
            >
              {uaCopyState === 'copied' ? 'Copied' : 'Copy user agent'}
            </button>
            {uaCopyState === 'unavailable' && (
              <p className="mt-2 font-mono text-[11px] uppercase tracking-wider text-text-3">
                Clipboard unavailable, copy the string above by hand.
              </p>
            )}

            <p className="mt-4 font-mono text-[11px] uppercase tracking-wider text-text-3">
              Press each one, wait a beat, and report which ones you FEEL as a buzz.
            </p>
            <NoteField
              value={notes.q11}
              onChange={(v) => note('q11', v)}
              placeholder="Immediate: ...  setTimeout 0: ...  setTimeout 1500: ...  Promise chain: ..."
            />
          </Section>

          <Section n={12} title="Swipe to collect: a real multi-pulse rhythm on current iOS">
            <p className="text-sm text-text-2">
              A real <code className="text-brand-500">{'<input type="checkbox" switch>'}</code> overlays the whole
              track and IS the touch target. <code className="text-brand-500">SwitchTrigger::PointerTracking</code>{' '}
              is not user-gesture gated and fires on every flip with no cap, so dragging this teleports the switch on
              a schedule and plays a real pattern, one detent-crossing per pulse, on 26.5 and 26.6 alike.
            </p>
            <div className="mt-3">
              <SwipePatternPicker value={swipePattern} onChange={changeSwipePattern} />
            </div>
            <div className="mt-3">
              <SwipeCollectPad elRef={swipe.elRef} progress={swipe.progress} />
            </div>
            <div className="mt-3 grid grid-cols-4 gap-3 font-mono text-[11px] uppercase tracking-wider text-text-3">
              <div>
                Beats scheduled
                <div className="mt-1 text-lg font-bold text-brand-500">{swipeBeats.length}</div>
              </div>
              <div>
                Beats fired
                <div className="mt-1 text-lg font-bold text-brand-500">{swipe.beatsFired}</div>
              </div>
              <div>
                Elapsed
                <div className="mt-1 text-lg font-bold text-brand-500">{swipe.elapsedMs}ms</div>
              </div>
              <div>
                Collected
                <div className="mt-1 text-lg font-bold text-brand-500">{swipe.collectedCount}</div>
              </div>
            </div>
            <button
              onClick={swipe.reset}
              className="mt-3 border border-line-strong px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-text-2 transition active:scale-[0.98] hover:border-brand-500 hover:text-brand-500"
            >
              Reset
            </button>
            <p className="mt-3 font-mono text-[11px] uppercase tracking-wider text-text-3">
              Swipe slowly and steadily all the way across. Did you feel a rhythm, distinct pulses in a pattern,
              rather than a single tick or a mush? Switch patterns and compare: did they feel different from each
              other?
            </p>
            <NoteField
              value={notes.q12}
              onChange={(v) => note('q12', v)}
              placeholder="Rhythm or mush? Did win/lose/cashOut/achievement feel distinct from each other?"
            />
          </Section>
        </div>

        <div className="mt-10 border-t border-line pt-6">
          <button
            onClick={copyAll}
            className="border border-brand-500 px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-brand-500 transition active:scale-[0.98] hover:bg-brand-500/10"
          >
            {copyState === 'copied' ? 'Copied' : 'Copy all notes'}
          </button>
          {copyState === 'unavailable' && (
            <div className="mt-3">
              <p className="font-mono text-[11px] uppercase tracking-wider text-text-3">
                Clipboard unavailable (plain http over LAN). Copy manually:
              </p>
              <pre className="mt-2 whitespace-pre-wrap border border-line bg-surface p-3 text-[12px] text-text-2">{allNotesText}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
