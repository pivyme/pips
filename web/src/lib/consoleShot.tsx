// Renders the user's OWN customized console (preset + per-part overrides) to a transparent PNG for the
// PnL share card, using the same offscreen ConsoleCanvas path as /dev/export so the framing reproduces
// the card template's baked console shot. The screen shows the card's win/rekt art, painted onto the 3D
// screen mesh (real perspective) via ConsoleCanvas's screenTexture hook, so shots come in two variants.
// Shares never pay the WebGL cost twice: shots go through a two-tier cache (in-memory promise + one
// IndexedDB Blob row per variant keyed by rig + SHOT_VERSION) and get warmed in the background
// (customize commit, boot idle, history mount) so the render happens before anyone shares.
import { createRoot } from 'react-dom/client'
import ConsoleCanvas from '@/components/console/ConsoleCanvas'
import {
  hasOverrides,
  readStoredConsoleCustom,
  resolveTheme,
} from '@/components/console/customize'
import type { ConsoleCustom, PartId } from '@/components/console/customize'
import { PART_IDS } from '@/components/console/customize'
import { DEFAULT_THEME_ID } from '@/components/console/themes'
import { loadImage } from '@/lib/cardAssets'

// The device pose (deck pitch/yaw, radians), calibrated against the template's baked console (image3)
// by the dev-time overlay-diff script: pitch -14deg, yaw -18deg lands silhouette IoU 1.000 with an
// identical bbox, so the shot drops onto the template's console rect with no fit correction at all.
// The card's 6.55deg tilt is a 2D transform in playCard, not here.
export const CONSOLE_SHOT_POSE = { x: (-14 * Math.PI) / 180, y: (-18 * Math.PI) / 180 }

// The screen art per card tone, painted onto the screen mesh.
export type ShotScreen = 'win' | 'rekt'
const SCREEN_ART = (s: ShotScreen) => `/assets/pnl-card/pnl-${s}-screen.webp`
// Stock-classic rigs ship baked (same tool, same pose): the majority skips WebGL entirely, and the
// same asset is the WebGL-dead fallback in playCard.
const CLASSIC_SRC = (s: ShotScreen) => `/assets/pnl-card/console-classic-${s}.webp`
// ConsoleCanvas stretches the screen texture across the mesh bbox (SCREEN_PX, 1110x1650); cover-crop
// the art to that aspect first so it never distorts.
const SCREEN_AR = 1110 / 1650

// Shot buffer target: the template console's native 836x1492 (aspect 0.56, the device aspect, which is
// all the customize/export camera keys framing off). The card draws it at 571.74px wide, ~1.5x headroom.
const SHOT_W = 836
const SHOT_H = 1492
// Bump when the pose, screen art, box size, or ConsoleCanvas visuals change: stale IDB shots die on version.
const SHOT_VERSION = 3
// Skin/metallic textures load async after the scene's first paint; the fixed settle covers them
// (mirrors /dev/export's 900ms), the non-blank poll covers a slow first frame.
const SETTLE_MS = 1000
const SETTLE_SKIN_MS = 1700
const SETTLE_POLL_MS = 200
const SETTLE_MAX_MS = 5000
const SHOT_TIMEOUT_MS = 9000

// Canonical cache key: variant + preset + the defined overrides in PART_IDS order, so key equality == rig equality.
function rigKey(c: ConsoleCustom, screen: ShotScreen): string {
  const parts: Partial<Record<PartId, number>> = {}
  let any = false
  for (const p of PART_IDS) {
    const v = c.parts?.[p]
    if (v !== undefined) {
      parts[p] = v
      any = true
    }
  }
  return `v${SHOT_VERSION}:${screen}:` + JSON.stringify(any ? { preset: c.preset, parts } : { preset: c.preset })
}

// ── Tier 2: one persistent Blob row per variant in IndexedDB (localStorage is too tight for a retina
//    PNG). Fixed record id per variant, so a new rig's write naturally evicts the old shot. Best-effort.
const IDB_NAME = 'pips-cards'
const IDB_STORE = 'console-shot'

function idb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function idbRead(key: string, screen: ShotScreen): Promise<Blob | null> {
  const db = await idb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(`shot:${screen}`)
      req.onsuccess = () => {
        const row = req.result as { key?: string; blob?: Blob } | undefined
        resolve(row?.key === key && row.blob instanceof Blob ? row.blob : null)
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    } finally {
      db.close()
    }
  })
}

async function idbWrite(key: string, screen: ShotScreen, blob: Blob): Promise<void> {
  const db = await idb()
  if (!db) return
  try {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put({ key, blob }, `shot:${screen}`)
    tx.oncomplete = () => db.close()
    tx.onerror = () => db.close()
  } catch {
    db.close()
  }
}

// ── The WebGL render: an imperative offscreen ConsoleCanvas mount, captured and torn down immediately
//    (never leave a second live WebGL canvas around). Serialized so two cold variants can't mount two scenes.
function canvasHasInk(c: HTMLCanvasElement): boolean {
  const probe = document.createElement('canvas')
  probe.width = 16
  probe.height = 16
  const ctx = probe.getContext('2d', { willReadFrequently: true })
  if (!ctx) return true
  try {
    ctx.drawImage(c, 0, 0, 16, 16)
    const d = ctx.getImageData(0, 0, 16, 16).data
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true
  } catch {
    return true // an unreadable canvas shouldn't stall the settle loop
  }
  return false
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The screen art as a mesh-ready data URL: cover-cropped to the screen mesh's bbox aspect.
async function screenArtTexture(screen: ShotScreen): Promise<string | null> {
  const img = await loadImage(SCREEN_ART(screen))
  if (!img) return null
  const w = img.naturalWidth
  const h = img.naturalHeight
  if (!w || !h) return null
  let cw = w
  let ch = h
  if (w / h > SCREEN_AR) cw = h * SCREEN_AR
  else ch = w / SCREEN_AR
  const c = document.createElement('canvas')
  c.width = Math.round(cw)
  c.height = Math.round(ch)
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', 0.92)
}

async function renderShot(
  custom: ConsoleCustom,
  pose: { x: number; y: number },
  screenTexture: string | null,
): Promise<Blob | null> {
  if (typeof document === 'undefined') return null
  const theme = resolveTheme(custom)
  const dpr = Math.min(window.devicePixelRatio || 1, 2) // ConsoleCanvas caps its pixelRatio at 2
  const host = document.createElement('div')
  host.style.cssText = `position:fixed;left:-9999px;top:0;width:${SHOT_W / dpr}px;height:${SHOT_H / dpr}px;pointer-events:none;`
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    root.render(<ConsoleCanvas customize exportMode theme={theme} exportRot={pose} screenTexture={screenTexture} />)
    const skinned = !!(theme.skin || theme.metallic || theme.clear)
    await sleep(skinned ? SETTLE_SKIN_MS : SETTLE_MS)
    const started = Date.now()
    let canvas = host.querySelector('canvas')
    while (!canvas || !canvasHasInk(canvas)) {
      if (Date.now() - started > SETTLE_MAX_MS) return null
      await sleep(SETTLE_POLL_MS)
      canvas = host.querySelector('canvas')
    }
    return await new Promise<Blob | null>((resolve) => canvas!.toBlob(resolve, 'image/png'))
  } catch {
    return null
  } finally {
    const canvas = host.querySelector('canvas')
    root.unmount()
    host.remove()
    // renderer.dispose() alone leaves the GL context alive until GC; enough strays and Chrome evicts
    // the OLDEST context, which is the app's live device canvas. Release it deterministically.
    try {
      const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl')
      ;(gl as WebGLRenderingContext | null)?.getExtension('WEBGL_LOSE_CONTEXT')?.loseContext()
    } catch {
      /* best effort */
    }
  }
}

let renderChain: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const p = renderChain.then(fn, fn)
  renderChain = p.catch(() => {})
  return p
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))])
}

// Object URLs stay alive for the session: one shot per rig+variant, and revoking would leave the
// cached HTMLImageElement unable to re-decode under memory pressure.
async function blobToImage(blob: Blob): Promise<HTMLImageElement | null> {
  const url = URL.createObjectURL(blob)
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => img.decode().then(() => resolve(img), () => resolve(img))
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}

// ── Tier 1: in-memory, instant for the showPnl toggle and repeat shares in a session.
const memCache = new Map<string, Promise<HTMLImageElement | null>>()

async function buildShot(custom: ConsoleCustom, key: string, screen: ShotScreen): Promise<HTMLImageElement | null> {
  // Stock classic (the default-rig majority) ships as a baked asset from the same tool: no WebGL at all.
  if (custom.preset === DEFAULT_THEME_ID && !hasOverrides(custom)) {
    const img = await loadImage(CLASSIC_SRC(screen))
    if (img) return img
  }
  const cached = await idbRead(key, screen)
  if (cached) {
    const img = await blobToImage(cached)
    if (img) return img
  }
  // Cache miss is the ONLY path that mounts WebGL. A missing screen art tolerates down to a bare
  // powered-off screen rather than failing the whole shot.
  const blob = await withTimeout(
    serialized(async () => renderShot(custom, CONSOLE_SHOT_POSE, await screenArtTexture(screen))),
    SHOT_TIMEOUT_MS,
  )
  if (!blob) return null
  void idbWrite(key, screen, blob)
  return blobToImage(blob)
}

// The user's console with the tone's screen art, ready to draw on the card. Null = WebGL dead/timed
// out; the caller falls back to the baked classic console for the same tone.
export function getConsoleShot(screen: ShotScreen): Promise<HTMLImageElement | null> {
  if (typeof window === 'undefined') return Promise.resolve(null)
  const custom = readStoredConsoleCustom()
  const key = rigKey(custom, screen)
  let p = memCache.get(key)
  if (!p) {
    p = buildShot(custom, key, screen)
    // A failed build must not poison the session cache; drop it so a later call can heal.
    void p.then((img) => {
      if (!img) memCache.delete(key)
    })
    memCache.set(key, p)
  }
  return p
}

// Background warm: kick both variants (renders are serialized) once the UI is idle. The delay clears
// whatever animation is in flight (studio outro, drawer push) before any WebGL work can stall a frame.
// Callers gate on surface: never during live gameplay (a second canvas competes with the game's 60fps).
export function warmConsoleShot(delayMs = 800): void {
  if (typeof window === 'undefined') return
  const kick = () => {
    void getConsoleShot('win')
    void getConsoleShot('rekt')
  }
  window.setTimeout(() => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }
    if (w.requestIdleCallback) w.requestIdleCallback(kick, { timeout: 4000 })
    else kick()
  }, delayMs)
}

// Dev-time hook (the pnl calibration/bake scripts drive this via vite): render a rig at an explicit
// pose, no cache, returned as a PNG data URL. Also produces the shipped classic webps.
export async function renderConsoleShotDev(
  custom: ConsoleCustom,
  pose: { x: number; y: number },
  screen?: ShotScreen,
): Promise<string | null> {
  const blob = await serialized(async () => renderShot(custom, pose, screen ? await screenArtTexture(screen) : null))
  if (!blob) return null
  return new Promise((resolve) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result as string)
    fr.onerror = () => resolve(null)
    fr.readAsDataURL(blob)
  })
}
