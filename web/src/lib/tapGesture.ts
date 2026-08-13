// Shared tap-vs-scroll qualification rule for iOS Taptic overlays: a genuine tap is a single touch that
// stayed within TAP_SLOP_PX and finished within TAP_MAX_MS. Everything that turns a real `<input
// type="checkbox" switch>` gesture into an app action needs this same rule (HapticOverlay for the menu
// rows, RailTickSwitch for the Customize preset rail), because with the `switch` attribute present
// WebKit synthesizes a click from touchend AND touchcancel unconditionally (CheckboxInputType.cpp:225),
// so a scroll always produces a click and only this check tells a tap apart from one. Each call site
// still tracks its own gesture state and its own extra disqualifier (a menu row watches its scroll
// parent's scrollTop, the rail watches its own scrollLeft), only the thresholds and comparisons are
// shared, so the two surfaces can never quietly drift onto different definitions of "tap".
export const TAP_SLOP_PX = 10
export const TAP_MAX_MS = 700

export function iosNoVibrate(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate !== 'function'
}

export function exceedsSlop(dx: number, dy: number): boolean {
  return Math.abs(dx) > TAP_SLOP_PX || Math.abs(dy) > TAP_SLOP_PX
}

export function withinTapWindow(startedAt: number): boolean {
  return performance.now() - startedAt <= TAP_MAX_MS
}
