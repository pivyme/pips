// Per-part console customization on top of the preset themes. A ConsoleCustom is a preset id plus
// palette-index overrides; resolveTheme() folds it into a plain ConsoleTheme the canvas repaints from.
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { DEFAULT_THEME, DEFAULT_THEME_ID, THEME_BY_ID } from './themes'
import type { ConsoleTheme } from './themes'

export type PartId = 'body' | 'play' | 'buttons' | 'knob' | 'wheel' | 'glow'
export const PART_IDS: PartId[] = ['body', 'play', 'buttons', 'knob', 'wheel', 'glow']

export interface ConsoleCustom {
  preset: string
  parts?: Partial<Record<PartId, number>> // PALETTE index; absent = inherit the preset
}

// APPEND-ONLY: the server stores indices, reordering repaints every saved rig. 9 chromatic + 3 mono.
// Hexes are the starting point, tune against the scene lighting at QA (values may need a slight lift).
export const PALETTE = [
  { name: 'Cream', hex: '#e9dbbf' }, // 0, classic body
  { name: 'Red', hex: '#d63a2e' }, // 1, classic PLAY
  { name: 'Orange', hex: '#ff7a1a' }, // 2
  { name: 'Gold', hex: '#f2c044' }, // 3, classic knob
  { name: 'Green', hex: '#2fbf62' }, // 4, calmer than the up-verdict green
  { name: 'Teal', hex: '#2ec5c9' }, // 5
  { name: 'Blue', hex: '#3568c9' }, // 6, classic action
  { name: 'Purple', hex: '#7a5cff' }, // 7
  { name: 'Pink', hex: '#ff7ba9' }, // 8
  { name: 'White', hex: '#f2f2ee' }, // 9
  { name: 'Grey', hex: '#8a8d93' }, // 10
  { name: 'Black', hex: '#1a1b1e' }, // 11, not pure black so form still reads
] as const

// Same perceived-luminance rule as the canvas's actionInk (ConsoleCanvas ~784), CSS-side.
export function contrastInk(hex: string, dark = '#373737', light = '#e8e6df'): string {
  const h = hex.replace('#', '')
  if (h.length !== 6) return light
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.58 ? dark : light
}

export function hasOverrides(c: ConsoleCustom): boolean {
  return !!c.parts && Object.values(c.parts).some((v) => v !== undefined)
}

// Shape guard for anything coming off the wire (server themeConfig). Mirrors the backend validator.
export function isValidConsoleCustom(v: unknown): v is ConsoleCustom {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  if (typeof o.preset !== 'string' || !Object.prototype.hasOwnProperty.call(THEME_BY_ID, o.preset)) return false
  if (Object.keys(o).some((k) => k !== 'preset' && k !== 'parts')) return false
  if (o.parts === undefined) return true
  if (typeof o.parts !== 'object' || o.parts === null || Array.isArray(o.parts)) return false
  return Object.entries(o.parts).every(
    ([k, val]) => (PART_IDS as string[]).includes(k) && Number.isInteger(val) && (val as number) >= 0 && (val as number) < PALETTE.length,
  )
}

// Fold the overrides into a plain ConsoleTheme. No overrides returns the preset object UNTOUCHED
// (referential equality, presets render pixel-identical to today).
export function resolveTheme(custom: ConsoleCustom): ConsoleTheme {
  const base = THEME_BY_ID[custom.preset] ?? DEFAULT_THEME
  const p = custom.parts
  if (!p || !hasOverrides(custom)) return base
  const hex = (i?: number) => (i === undefined ? undefined : PALETTE[i]?.hex)
  const t: ConsoleTheme = { ...base }

  const body = hex(p.body)
  if (body) {
    // Finish lives on Body (decision 2): a body pick strips skin/metal/clear back to molded plastic.
    t.body = body
    t.back = body
    delete t.skin
    delete t.metallic
    delete t.clear
    delete t.ambient // themeBackdrop() re-derives the surround from the new body
    delete t.cardImage
    // The preset picked these against ITS body; re-derive against the new one.
    t.label = contrastInk(body, '#4a463c', '#e8e6df')
    t.logo = contrastInk(body, '#2a2a2e', '#f0efe8')
  }
  const play = hex(p.play)
  if (play) t.main = play
  const buttons = hex(p.buttons)
  if (buttons) {
    t.action = buttons
    t.pills = buttons
  }
  const knob = hex(p.knob)
  if (knob) t.knob = knob
  const wheel = hex(p.wheel)
  if (wheel) t.wheel = wheel
  const glow = hex(p.glow)
  if (glow) t.glow = glow

  // Card fields feed the "Custom" chip in the presets rail.
  t.cardBg = t.body
  t.cardInk = contrastInk(t.body, '#26221a', '#f4f3ee')
  t.cardSub = contrastInk(t.body, 'rgba(38,34,26,0.6)', 'rgba(244,243,238,0.6)')
  return t
}

const CUSTOM_KEY = 'pips_console_custom'
const LEGACY_KEY = 'pips_console_theme' // pre-customizer installs carry only this; keep mirroring it

function readLegacyPreset(): string {
  if (typeof window === 'undefined') return DEFAULT_THEME_ID
  try {
    const raw = window.localStorage.getItem(LEGACY_KEY)
    const id = raw != null ? (JSON.parse(raw) as string) : DEFAULT_THEME_ID
    return Object.prototype.hasOwnProperty.call(THEME_BY_ID, id) ? id : DEFAULT_THEME_ID
  } catch {
    return DEFAULT_THEME_ID
  }
}

// Replaces useConsoleTheme() as _app's source of truth. Mirrors the preset back into the legacy key so
// the pre-React status-bar bootstrap chain (backdrop cache) and any straggler readers stay correct.
export function useConsoleCustom() {
  const [raw, setRaw] = useLocalStorage<ConsoleCustom | null>(CUSTOM_KEY, null)
  const custom: ConsoleCustom = raw && isValidConsoleCustom(raw) ? raw : { preset: readLegacyPreset() }
  const resolved = resolveTheme(custom)
  const set = (next: ConsoleCustom) => {
    setRaw(next)
    try {
      window.localStorage.setItem(LEGACY_KEY, JSON.stringify(next.preset))
    } catch {
      /* private mode, the state copy still works this session */
    }
  }
  return { custom, resolved, set }
}
