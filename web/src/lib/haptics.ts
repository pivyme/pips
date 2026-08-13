// Vibration-based haptic feedback. The engine is `web-haptics` (WebHaptics.trigger), a module-level
// scheduler on top decides WHEN it may fire: a detent burst for the knob/wheel, a plain button press,
// and a game-outcome pattern (win/lose/cashOut/achievement) all share one physical actuator.
//
// - Lazy singleton, gated on `typeof window === 'undefined'`: this file is imported by ~49 others, so it
//   must not allocate anything at SSR render time (same guard as audioContext.ts / track.ts).
// - `WebHaptics.isSupported` is a STATIC field computed once, the moment the `web-haptics` module first
//   evaluates (verified against node_modules/web-haptics/dist/index.js), not a live getter. Every export
//   below routes through `ready()`, which reads it once via the memoized singleton, so iOS (which never
//   implements navigator.vibrate) can never reach the library's DOM/rAF fallback: that path injects a
//   hidden <label> and spins a click loop that does nothing on current iOS anyway.
// - Three traffic classes share one clock. Outcome patterns (hapticPattern) claim the actuator for their
//   full duration and queue one deep against each other. Presses (haptic) preempt a detent burst and
//   defer at most one slot behind a playing outcome, but never queue. Detents (hapticDetent) yield to
//   both and cap-and-drop past MAX_BURST.
// - In dev, editing this file mid-session can leave a stale setTimeout briefly pointed at the previous
//   module instance; it self-corrects within one flush window (well under 105ms). Not worth `import.meta.hot`.

import { WebHaptics } from 'web-haptics'

export type HapticPreset = 'tick' | 'tickSmall' | 'low' | 'mid' | 'high' | 'selection' | 'medium' | 'rigid' | 'heavy' | 'success' | 'warning' | 'error'

export type HapticPattern = 'win' | 'lose' | 'cashOut' | 'achievement'

interface Vibration {
  duration: number
  intensity: 1
  delay?: number
}

// AOSP's own picker detent / the bottom of the documented 10-20ms keyclick drive range. The knob.
export const DETENT_MS = 10
// The amount wheel, graded mid.
export const DETENT_SMALL_MS = 7
// Must clear the actuator's 20-50ms ring-down or two pulses fuse into one.
export const DETENT_GAP_MS = 25
// Bounds how far the buzz can trail the finger and keeps the emitted pattern at 5 entries, inside the
// W3C 10-entry max, and odd (Chromium strips a trailing pause).
export const MAX_BURST = 3

const SLOT_MS = DETENT_MS + DETENT_GAP_MS // 35, the derived per-pulse ceiling (~28.5/sec)
const PATTERN_DEDUPE_MS = 1000 // collapses a remount replay of the same outcome pattern into one

const LOW: Vibration[] = [{ duration: 10, intensity: 1 }]
const MID: Vibration[] = [{ duration: 15, intensity: 1 }]
const HIGH: Vibration[] = [{ duration: 20, intensity: 1 }]

// Every entry is full intensity: at intensity 1 web-haptics emits one array slot per pulse, so weight
// lives entirely in duration. Legacy names alias onto the graded levels so existing call sites keep
// working; hapticPattern() below is a deliberately separate type from this table.
const PRESET_PATTERNS: Record<HapticPreset, Vibration[]> = {
  tick: [{ duration: DETENT_MS, intensity: 1 }],
  tickSmall: [{ duration: DETENT_SMALL_MS, intensity: 1 }],
  low: LOW,
  mid: MID,
  high: HIGH,
  selection: LOW,
  medium: MID,
  rigid: HIGH,
  heavy: HIGH,
  success: [
    { duration: 30, intensity: 1 },
    { delay: 60, duration: 40, intensity: 1 },
  ],
  warning: [
    { duration: 40, intensity: 1 },
    { delay: 100, duration: 40, intensity: 1 },
  ],
  error: [
    { duration: 40, intensity: 1 },
    { delay: 40, duration: 40, intensity: 1 },
    { delay: 40, duration: 40, intensity: 1 },
  ],
}

// Shared skeleton, only the rhythm varies: a win escalates and resolves, a loss decays and does not,
// cashOut is two equal deliberate taps, achievement is the one pattern allowed to run long.
const PATTERN_VIBRATIONS: Record<HapticPattern, Vibration[]> = {
  win: [
    { duration: 20, intensity: 1 },
    { delay: 50, duration: 30, intensity: 1 },
    { delay: 50, duration: 70, intensity: 1 },
  ],
  lose: [
    { duration: 70, intensity: 1 },
    { delay: 40, duration: 25, intensity: 1 },
  ],
  cashOut: [
    { duration: 25, intensity: 1 },
    { delay: 45, duration: 25, intensity: 1 },
  ],
  achievement: [
    { duration: 20, intensity: 1 },
    { delay: 40, duration: 20, intensity: 1 },
    { delay: 40, duration: 20, intensity: 1 },
    { delay: 60, duration: 90, intensity: 1 },
  ],
}

let enabled = true
const enabledListeners = new Set<() => void>()
let instance: WebHaptics | null | undefined // undefined = not yet resolved for this module instance

type Mode = 'idle' | 'press' | 'detent' | 'outcome'
let mode: Mode = 'idle'
let clockTimer: ReturnType<typeof setTimeout> | null = null

let pendingCount = 0
let pendingMs = DETENT_MS

let queuedOutcome: HapticPattern | null = null
let queuedPress: HapticPreset | null = null
let lastPattern: { name: HapticPattern; at: number } | null = null

function getInstance(): WebHaptics | null {
  if (typeof window === 'undefined') return null
  if (instance === undefined) {
    // Never showSwitch/debug: both paint DOM or open a second AudioContext, and isSupported already
    // keeps this branch off iOS, so there is nothing for either option to do here.
    instance = WebHaptics.isSupported ? new WebHaptics({ debug: false, showSwitch: false }) : null
  }
  return instance
}

// Driven by the user's Haptics setting (synced from the auth user); when off, every call is a no-op so
// screens don't have to check.
export function setHapticsEnabled(value: boolean): void {
  enabled = value
  if (!value) cancelHaptics()
  for (const cb of enabledListeners) cb()
}

// Our own navigator.vibrate() calls all gate on `enabled` already, but iOS's native Taptic tick on a
// switch is WebKit's own response to the `switch` HTML attribute, entirely outside JS: the only way to
// suppress it is to not render that attribute at all (B14, ConsoleCanvas's button overlays). That needs a
// value that updates live while the console stays mounted under the Settings drawer, so this is a plain
// module-level pub-sub rather than React state: no React import here keeps this file usable from
// non-component callers, and `useSyncExternalStore` (in the one consumer that needs it) works whether or
// not an AuthProvider is even in the tree, unlike reading the auth user directly, which throws when
// ConsoleCanvas is mounted off-tree for the offscreen PnL-card shot (consoleShot.tsx).
export function isHapticsEnabled(): boolean {
  return enabled
}
export function subscribeHapticsEnabled(cb: () => void): () => void {
  enabledListeners.add(cb)
  return () => enabledListeners.delete(cb)
}

// The one sanctioned interrupt: clears every scheduler slot and stops the actuator. Used by the
// haptics-off toggle and as the test reset seam. Never called on route change, a queued detent tail is
// allowed to ring out.
export function cancelHaptics(): void {
  try {
    pendingCount = 0
    queuedOutcome = null
    queuedPress = null
    mode = 'idle'
    if (clockTimer) {
      clearTimeout(clockTimer)
      clockTimer = null
    }
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(0)
  } catch {
    // stopping is best effort, never worth throwing over
  }
}

function ready(): WebHaptics | null {
  if (!enabled) return null
  return getInstance()
}

function totalMs(vibs: Vibration[]): number {
  return vibs.reduce((sum, v) => sum + (v.delay ?? 0) + v.duration, 0)
}

function fireVibrations(inst: WebHaptics, vibs: Vibration[]): void {
  void inst.trigger(vibs).catch(() => {})
}

function scheduleModeClear(delayMs: number): void {
  if (clockTimer) clearTimeout(clockTimer)
  clockTimer = setTimeout(() => {
    clockTimer = null
    onActuatorFree()
  }, delayMs)
}

// Runs whenever the actuator finishes whatever it was playing. Priority order mirrors the three
// classes: a queued outcome pattern always wins, then a deferred press, then a banked detent burst.
function onActuatorFree(): void {
  try {
    mode = 'idle'
    const inst = ready()
    if (!inst) {
      pendingCount = 0
      queuedOutcome = null
      queuedPress = null
      return
    }
    if (queuedOutcome) {
      const name = queuedOutcome
      queuedOutcome = null
      firePattern(inst, name)
      return
    }
    if (queuedPress) {
      const preset = queuedPress
      queuedPress = null
      firePress(inst, preset)
      return
    }
    if (pendingCount > 0) flushDetent(inst)
  } catch {
    // a scheduler hiccup should never surface as an app error
  }
}

function firePress(inst: WebHaptics, preset: HapticPreset): void {
  const vibs = PRESET_PATTERNS[preset]
  mode = 'press'
  fireVibrations(inst, vibs)
  scheduleModeClear(totalMs(vibs))
}

function firePattern(inst: WebHaptics, name: HapticPattern): void {
  const vibs = PATTERN_VIBRATIONS[name]
  mode = 'outcome'
  fireVibrations(inst, vibs)
  scheduleModeClear(totalMs(vibs))
}

function flushDetent(inst: WebHaptics): void {
  const n = pendingCount
  if (n <= 0) return
  const ms = pendingMs
  pendingCount = 0

  const vibs: Vibration[] = []
  for (let i = 0; i < n; i++) {
    vibs.push(i === 0 ? { duration: ms, intensity: 1 } : { delay: DETENT_GAP_MS, duration: ms, intensity: 1 })
  }

  mode = 'detent'
  fireVibrations(inst, vibs)
  // Reserving a full slot per pulse (not just the last pulse's own width) is what keeps consecutive
  // flushes from butting pulse against pulse; see HAPTICS.md §6.5.
  scheduleModeClear(n * SLOT_MS)
}

// A plain button/toggle press. Preempts a detent burst outright (the finger on the glass now outranks
// the knob's trailing clicks); if an outcome pattern is playing, defers one slot behind it rather than
// queuing or interrupting. Called from rAF loops and raycast handlers, so it must never throw.
export function haptic(preset: HapticPreset = 'low'): void {
  try {
    const inst = ready()
    if (!inst) return

    if (mode === 'outcome') {
      queuedPress = preset
      return
    }

    pendingCount = 0
    queuedPress = null
    firePress(inst, preset)
  } catch {
    // a dropped press is never worth a broken frame loop
  }
}

// A game outcome: win, lose, cashOut, achievement. Claims the actuator for its full duration. A second
// outcome arriving while one plays queues one deep; a third is dropped. The same pattern name repeated
// inside ~1s (a remount replaying an effect) collapses to a single buzz.
export function hapticPattern(name: HapticPattern): void {
  try {
    const inst = ready()
    if (!inst) return

    const now = Date.now()
    if (lastPattern && lastPattern.name === name && now - lastPattern.at < PATTERN_DEDUPE_MS) return
    lastPattern = { name, at: now }

    if (mode === 'outcome') {
      if (!queuedOutcome) queuedOutcome = name
      return
    }

    pendingCount = 0
    queuedPress = null
    firePattern(inst, name)
  } catch {
    // a dropped outcome buzz is never worth a broken frame loop
  }
}

// The knob/wheel detent scheduler. Banks up to MAX_BURST crossings and coalesces them into one
// `vibrate()` call so a fast flick never machine-guns the actuator; excess past the cap is simply
// dropped, never queued. Yields to a press or an outcome pattern already playing. The first detent of an
// idle actuator flushes synchronously, in the same task, so it lands with the audio.
export function hapticDetent(count: number, ms: number = DETENT_MS): void {
  try {
    const inst = ready()
    if (!inst || count <= 0) return

    pendingCount = Math.min(pendingCount + count, MAX_BURST)
    pendingMs = ms

    if (mode !== 'idle') return
    flushDetent(inst)
  } catch {
    // a dropped detent is never worth a broken frame loop
  }
}
