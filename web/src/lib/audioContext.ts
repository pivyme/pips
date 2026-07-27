// The app's one AudioContext. Everything that makes sound shares it: the synth stings (sound.ts), the
// music player (audio.ts), and the UI one-shots (uiSfx.ts). iOS caps how many a page may hold and each
// one needs its own gesture unlock, so one is the only stable answer.
//
// It lives here rather than in sound.ts so a module can reach the context without dragging the whole
// synth in behind it (the admin dashboard imports the hardware kit, which plays UI sound).

let ctx: AudioContext | null = null

// Hands back a FRESH context after a backgrounded PWA drains the old one to 'closed'. Anything caching
// nodes should compare the returned context against the one its nodes were built on and rebuild on a
// mismatch, since the old graph went down with it.
export function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctx =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) return null
  if (ctx && ctx.state === 'closed') ctx = null
  if (!ctx) ctx = new Ctx()
  return ctx
}

// iOS Safari has a non-standard 'interrupted' state beyond the spec's suspended/running/closed enum;
// checking only for 'suspended' left it silently stuck. Anything but 'running' needs a resume.
export function ensureRunning(ac: AudioContext): void {
  if (ac.state !== 'running') ac.resume().catch(() => {})
}
