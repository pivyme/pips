// Menu perf bisect, unlocked by tapping the drawer title 5 times. Each flag strips one suspect off the
// page slide so a real phone can point at the one that actually costs frames, instead of us guessing from
// a simulator. Fully dormant until unlocked: no rAF, no attributes, no cost for anyone who never opens it.

const KEY = 'pips_perf'
const NAV_WINDOW_MS = 520

export type PerfFlag =
  | 'noVt'
  | 'flatSlide'
  | 'noShadow'
  | 'noClip'
  | 'noBlur'
  | 'hideDevice'
  | 'noWillChange'
  | 'noSticky'
  | 'noPark'
  | 'hud'

// Ordered by how much I expect each to matter on iOS, most suspicious first. The switch in the panel
// reads as the FEATURE (on = shipped behaviour), so flipping one off is what strips it.
export const PERF_ROWS: { flag: PerfFlag; label: string; hint: string }[] = [
  { flag: 'noBlur', label: 'Drawer blur', hint: 'Full-screen backdrop-filter over the 3D device' },
  { flag: 'flatSlide', label: 'Dim + scale', hint: 'Receding page fades and shrinks, not just slides' },
  { flag: 'noShadow', label: 'Edge shadow', hint: '42px shadow on the moving page edge' },
  { flag: 'noClip', label: 'Group clip', hint: 'overflow:clip on the transition group' },
  { flag: 'hideDevice', label: '3D console', hint: 'Kept visible behind the drawer' },
  { flag: 'noVt', label: 'Page slide', hint: 'Off = instant swap, no snapshot at all' },
  { flag: 'noWillChange', label: 'Layer hints', hint: 'will-change pins the sheet + scrim as GPU layers' },
  { flag: 'noSticky', label: 'Sticky header', hint: 'Page title sticks to the top while scrolling' },
  { flag: 'noPark', label: 'Park render loops', hint: 'Freezes the device + chart during a nav' },
]

// Flipped together by "Fast mode": everything I'd bet on, so one tap says whether the cause is in here.
export const FAST_MODE: PerfFlag[] = ['noBlur', 'flatSlide', 'noShadow', 'noClip', 'hideDevice']

let flags = new Set<PerfFlag>()
let unlocked = false
let panelOpen = false
let booted = false
let version = 0
const subs = new Set<() => void>()

function emit() {
  version += 1
  subs.forEach((fn) => fn())
}

function boot() {
  if (booted || typeof window === 'undefined') return
  booted = true
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(KEY)
  } catch {
    // private mode: the panel still works, it just won't survive a reload
  }
  if (raw == null) return
  unlocked = true
  flags = new Set(raw.split(' ').filter(Boolean) as PerfFlag[])
  apply()
  startMeter()
}

function persist() {
  try {
    window.localStorage.setItem(KEY, [...flags].join(' '))
  } catch {
    // see boot()
  }
}

// One space-separated attribute so CSS matches with [data-perf~='noBlur'], no per-flag attribute churn.
function apply() {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (flags.size) root.dataset.perf = [...flags].join(' ')
  else delete root.dataset.perf
  syncVtPatch()
}

export function perfOn(flag: PerfFlag): boolean {
  boot()
  return flags.has(flag)
}

export function setPerfFlag(flag: PerfFlag, on: boolean): void {
  boot()
  if (on) flags.add(flag)
  else flags.delete(flag)
  persist()
  apply()
  emit()
}

export function setPerfFlags(next: PerfFlag[]): void {
  boot()
  const hud = flags.has('hud')
  flags = new Set(next)
  if (hud) flags.add('hud')
  persist()
  apply()
  emit()
}

export function isPerfUnlocked(): boolean {
  boot()
  return unlocked
}

export function isPerfPanelOpen(): boolean {
  return panelOpen
}

export function setPerfPanelOpen(open: boolean): void {
  boot()
  if (open && !unlocked) {
    unlocked = true
    persist()
    startMeter()
  }
  panelOpen = open
  emit()
}

export function subscribePerf(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

export function perfVersion(): number {
  return version
}

// --- the no-transition escape hatch -----------------------------------------------------------------
// Patched at the source rather than at ~20 `viewTransition` call sites, so the flag covers every nav path.

// Typed loosely on purpose: the spec grew an options-object overload and a `types` set, and this stub only
// has to satisfy the caller (TanStack awaits ready/finished), not the full interface.
type VtHost = { startViewTransition?: (arg?: unknown) => unknown }

let realStartVt: ((arg?: unknown) => unknown) | null = null

function syncVtPatch() {
  if (typeof document === 'undefined') return
  const doc = document as unknown as VtHost
  if (flags.has('noVt')) {
    if (realStartVt || !doc.startViewTransition) return
    realStartVt = doc.startViewTransition.bind(doc) as (arg?: unknown) => unknown
    doc.startViewTransition = (arg?: unknown) => {
      const update = typeof arg === 'function' ? arg : (arg as { update?: () => unknown } | undefined)?.update
      const done = Promise.resolve(update?.()).then(() => undefined)
      return {
        ready: done,
        finished: done,
        updateCallbackDone: done,
        skipTransition: () => {},
        types: new Set<string>(),
      }
    }
  } else if (realStartVt) {
    doc.startViewTransition = realStartVt
    realStartVt = null
  }
}

// --- frame meter -------------------------------------------------------------------------------------
// A nav is the only window worth measuring, so the rolling fps is just for the HUD and the real number is
// the worst frame between the tap and the end of the slide.

export type NavStat = { frames: number; worst: number; fps: number }

let raf = 0
let prevT = 0
let smoothFps = 0
let navAt = 0
let navFrames = 0
let navWorst = 0
let navStat: NavStat | null = null

function startMeter() {
  if (raf || typeof window === 'undefined') return
  const tick = (t: number) => {
    raf = window.requestAnimationFrame(tick)
    if (prevT) {
      const dt = t - prevT
      const inst = 1000 / Math.max(dt, 1)
      smoothFps = smoothFps ? smoothFps * 0.85 + inst * 0.15 : inst
      if (navAt) {
        navFrames += 1
        if (dt > navWorst) navWorst = dt
        const span = t - navAt
        if (span > NAV_WINDOW_MS) {
          navStat = {
            frames: navFrames,
            worst: Math.round(navWorst),
            fps: Math.round((navFrames / span) * 1000),
          }
          navAt = 0
          emit()
        }
      }
    }
    prevT = t
  }
  raf = window.requestAnimationFrame(tick)
}

// Called from prepareMenuTransition, so every menu nav is sampled once the panel has been unlocked.
export function perfMarkNav(): void {
  boot()
  if (!unlocked || typeof performance === 'undefined') return
  navAt = performance.now()
  navFrames = 0
  navWorst = 0
}

export function perfFps(): number {
  return Math.round(smoothFps)
}

export function perfLastNav(): NavStat | null {
  return navStat
}
