// Menu perf bisect + tap latency readout, unlocked by `?perf` on any URL (or five taps on the drawer
// title). Each flag strips one suspect so a real phone can name the thing that costs frames instead of us
// guessing from a desktop. Fully dormant until unlocked: no rAF, no listeners, no cost for anyone else.

const KEY = 'pips_perf'
const SLIDE_KEY = 'pips_perf_slide'
const NAV_WINDOW_MS = 520

// The shipped slide length. Everything else here strips a feature; this one is a feel call, so it gets
// a real value rather than a switch. Read live by runMenuSlide.
export const SLIDE_DEFAULT_MS = 420
export const SLIDE_OPTIONS = [420, 340, 260, 180] as const

export type PerfFlag = 'noBlur' | 'hideDevice' | 'noWillChange' | 'noSticky' | 'noPark'

// The switch in the panel reads as the FEATURE (on = shipped behaviour), so flipping one off strips it.
// The old View Transition switches (page slide, dim+scale, edge shadow, group clip) are gone with the
// API itself: it cost one 713-840ms blocking frame per nav on iOS and none of those tuned it.
export const PERF_ROWS: { flag: PerfFlag; label: string; hint: string }[] = [
  { flag: 'noBlur', label: 'Drawer blur', hint: 'Full-screen backdrop-filter over the 3D device' },
  { flag: 'hideDevice', label: '3D console', hint: 'Kept visible behind the drawer' },
  { flag: 'noWillChange', label: 'Layer hints', hint: 'will-change pins the sheet + scrim as GPU layers' },
  { flag: 'noSticky', label: 'Sticky header', hint: 'Page title sticks to the top while scrolling' },
  { flag: 'noPark', label: 'Park render loops', hint: 'Freezes the device + chart during a nav' },
]

// Flipped together by "Fast mode": everything I'd bet on that still LOOKS right, so a smooth result is
// something we could actually ship.
export const FAST_MODE: PerfFlag[] = ['noBlur', 'hideDevice']

let flags = new Set<PerfFlag>()
let slideMs = SLIDE_DEFAULT_MS
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
  // Rapid-tapping a plain <h1> gets eaten by iOS double-tap-zoom, so the gesture unlock cannot be the
  // only way in. `?perf` on any URL arms it, and persists below so the next nav (which drops the query)
  // keeps it.
  if (raw == null && /(^|[?&#])perf\b/.test(window.location.search + window.location.hash)) raw = ''
  if (raw == null) return
  unlocked = true
  flags = new Set(raw.split(' ').filter(Boolean) as PerfFlag[])
  persist()
  const stored = Number(window.localStorage.getItem(SLIDE_KEY))
  if (SLIDE_OPTIONS.includes(stored as (typeof SLIDE_OPTIONS)[number])) slideMs = stored
  apply()
  startMeter()
}

export function perfSlideMs(): number {
  boot()
  return slideMs
}

export function setPerfSlideMs(ms: number): void {
  boot()
  slideMs = ms
  try {
    window.localStorage.setItem(SLIDE_KEY, String(ms))
  } catch {
    // see boot()
  }
  apply()
  emit()
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
  flags = new Set(next)
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
  watchTaps()
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
      meterTap(t, dt)
    }
    prevT = t
  }
  raf = window.requestAnimationFrame(tick)
}

// --- tap latency -------------------------------------------------------------------------------------
// The nav meter above can only start once a handler runs, so it is blind to the part that actually reads
// as "stuck": the wait between the finger and any JS at all. `input` measures that off the event's own
// hardware timestamp, which is what separates "the slide is slow" from "the main thread was already
// blocked when you tapped". Those two have completely different fixes, so never guess between them.

const TAP_WINDOW_MS = 1200
const IDLE_WINDOW_MS = 3000

export type TapStat = {
  what: string
  input: number // finger -> first JS
  click: number // pointerdown -> click
  dom: number // click -> the route actually changed, -1 if it never did
  worst: number // worst frame inside the window
  fps: number
}

const tap = { downAt: 0, input: 0, click: 0, what: '', at: 0, frames: 0, worst: 0, dom: -1, path: '' }
const idle = { at: 0, frames: 0, worst: 0 }
let tapStat: TapStat | null = null
let idleStat: { worst: number; fps: number } | null = null

// The tapped control is usually an invisible HapticOverlay with no text of its own, so fall back to
// whatever visible thing it covers.
function tapLabel(target: EventTarget | null): string {
  const el = target instanceof Element ? target : null
  if (!el) return 'tap'
  const node = el.closest('button, a, [role="button"]') ?? el
  const text =
    node.getAttribute('aria-label') ||
    (node as HTMLElement).innerText ||
    (node.previousElementSibling as HTMLElement | null)?.innerText ||
    (node.parentElement as HTMLElement | null)?.innerText ||
    node.tagName
  return text.trim().replace(/\s+/g, ' ').slice(0, 20) || 'tap'
}

function watchTaps() {
  window.addEventListener(
    'pointerdown',
    (e) => {
      tap.downAt = performance.now()
      // e.timeStamp is when the OS created the event; the gap to now is how long a busy main thread
      // made the finger wait. Clamped: a synthetic event can carry a timestamp from the future.
      tap.input = Math.max(0, tap.downAt - e.timeStamp)
      tap.what = tapLabel(e.target)
    },
    true,
  )
  window.addEventListener(
    'click',
    (e) => {
      const now = performance.now()
      // A keyboard/synthetic click has no pointerdown, so read its own delay instead of a stale one.
      if (!tap.downAt) {
        tap.input = Math.max(0, now - e.timeStamp)
        tap.what = tapLabel(e.target)
      }
      tap.click = tap.downAt ? Math.max(0, now - tap.downAt) : 0
      tap.downAt = 0
      tap.at = now
      tap.frames = 0
      tap.worst = 0
      tap.dom = -1
      tap.path = window.location.pathname
    },
    true,
  )
}

function meterTap(t: number, dt: number) {
  if (tap.at) {
    tap.frames += 1
    if (dt > tap.worst) tap.worst = dt
    if (tap.dom < 0 && window.location.pathname !== tap.path) tap.dom = Math.round(t - tap.at)
    const span = t - tap.at
    if (span > TAP_WINDOW_MS) {
      tapStat = {
        what: tap.what,
        input: Math.round(tap.input),
        click: Math.round(tap.click),
        dom: tap.dom,
        worst: Math.round(tap.worst),
        fps: Math.round((tap.frames / span) * 1000),
      }
      tap.at = 0
      idle.at = t
      idle.frames = 0
      idle.worst = 0
      emit()
    }
    return
  }
  // Health with nobody touching anything: if this is already bad, no transition work can save it.
  if (!idle.at) idle.at = t
  idle.frames += 1
  if (dt > idle.worst) idle.worst = dt
  const span = t - idle.at
  if (span > IDLE_WINDOW_MS) {
    idleStat = { worst: Math.round(idle.worst), fps: Math.round((idle.frames / span) * 1000) }
    idle.at = t
    idle.frames = 0
    idle.worst = 0
    emit()
  }
}

export function perfLastTap(): TapStat | null {
  return tapStat
}

export function perfIdle(): { worst: number; fps: number } | null {
  return idleStat
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
