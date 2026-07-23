// Device skins. A theme is a whole-device color preset (body, buttons, nav pills, knob) applied live by
// ConsoleCanvas with no geometry rebuild. Colors are hex strings so they drop into THREE.Color.set() and CSS alike.
import { useLocalStorage } from '@/hooks/useLocalStorage'

export interface ConsoleTheme {
  id: string
  code: string // the little serial on the card (212, 713, …)
  name: string
  badge?: string // small corner tag, e.g. NEW
  // device materials
  body: string
  back?: string // defaults to body
  ambient?: string // the page/surround color the device floats on; defaults to a deep tint of `body`
  skin?: string // optional SVG wrapped across the front body (overlays `body`); back stays flat
  clear?: boolean // transparent case: both shells go translucent and the internals (board, coil, glyph) show
  metallic?: boolean // real PBR metal: shells + knob go metalness 1 with env reflections, skin tints the metal
  knob: string
  main: string // big PLAY button
  action: string // the two action buttons
  pills: string // MENU / GAMES nav pills
  wheel?: string // number-wheel drum (+ housing derived darker); absent = fixed dark hardware
  glow?: string // idle action-screen glow; absent = falls through to `action` (today's rule)
  label?: string // MENU / GAMES caption text under the pills (defaults to a muted grey)
  logo?: string // embossed back logo letters (defaults to the accent); picked per skin for contrast
  logoEyes?: string // the logo's eye marks (defaults to `logo`); Classic keeps the red/blue original
  // card preview (CSS colors — the studio renders these, not WebGL)
  cardBg: string
  cardInk: string
  cardSub: string
  cardImage?: string // optional art behind the card (e.g. a skin preview); text sits on a scrim
}

// Each skin is one body + one accent (knob + PLAY) + a quiet neutral for the small buttons, tasteful
// not a toy-box rainbow. Classic is the brand default: matte charcoal with the PIPS yellow.
export const THEMES: ConsoleTheme[] = [
  {
    // The signature look, identical to the bare device on /console: cream body, red PLAY, blue actions, yellow knob, red/blue eyes on the back.
    id: 'classic',
    code: '001',
    name: 'Classic',
    body: '#e9dbbf',
    back: '#dccdb1',
    knob: '#f2c044',
    main: '#d63a2e',
    action: '#3568c9',
    pills: '#c1c1c1',
    label: '#7c7870',
    logo: '#d02323',
    logoEyes: '#4488ff',
    cardBg: '#e9dbbf',
    cardInk: '#981f14',
    cardSub: 'rgba(58,42,22,0.62)',
  },
  {
    id: 'overflow-2026',
    code: '2026',
    name: 'Overflow',
    badge: 'Hackathon Exclusive',
    body: '#f2eee4', // cream base under the skin (and the floor if the SVG ever fails to load)
    back: '#f2eee4',
    skin: '/assets/overflow-skin.svg',
    knob: '#f5c84b',
    main: '#ff6600',
    action: '#7a69fa',
    pills: '#000f1d',
    label: '#5b6573',
    logo: '#000f1d',
    cardBg: '#f2eee4',
    cardInk: '#000f1d',
    cardSub: 'rgba(0,15,29,0.72)',
    cardImage: '/assets/images/overflow-theme-card.png',
  },
  {
    id: 'suiblue',
    code: '009',
    name: 'Sui',
    body: '#4da2ff',
    back: '#4da2ff',
    skin: '/assets/sui-skin.svg',
    knob: '#f4f7ff',
    main: '#f4f7ff',
    action: '#4da2ff',
    pills: '#0a2c5e',
    label: '#0a2540',
    logo: '#f4f7ff',
    cardBg: '#4da2ff',
    cardInk: '#ffffff',
    cardSub: 'rgba(255,255,255,0.9)',
    cardImage: '/assets/images/sui-theme-card.png',
  },
  {
    id: 'deepbook',
    code: '042',
    name: 'DeepBlue',
    body: '#1f6feb',
    back: '#175ad6',
    knob: '#298DFF',
    main: '#f4f7ff',
    action: '#0838a0',
    pills: '#f4f7ff',
    label: '#e3edfd',
    logo: '#ced2dd',
    cardBg: '#1f6feb',
    cardInk: '#f4f7ff',
    cardSub: 'rgba(255,255,255,0.68)',
  },
  {
    id: 'pivy',
    code: '110',
    name: 'PIVY IT UP',
    badge: 'pivy.me',
    body: '#00ce2b', // the skin's green frame: under-skin fallback + the ambient surround
    back: '#6bcd83', // back panel isn't skinned; kept lighter so the embossed logo stays legible
    skin: '/assets/pivy-skin.png',
    knob: '#f4f7ff',
    main: '#7efe9f',
    action: '#00ce2b',
    pills: '#7efe9f', // mint nav pills
    label: '#373737', // white MENU / HOME caption reads clean on the green skin
    logo: '#098227',
    cardBg: '#29e655', // matches the card art's green frame so the load flash blends
    cardInk: '#098227',
    cardSub: 'rgba(20, 41, 21, 0.5)',
    cardImage: '/assets/pivy-theme-card.png',
  },
  {
    // The high-roller flex: 24-karat two-finish body (polished middle, sandblasted collar + foot), onyx dial hardware, champagne PLAY.
    id: 'aurum',
    code: '24K',
    name: 'Aurum',
    badge: 'High Roller',
    metallic: true,
    body: '#c9a227', // under-skin fallback while the SVG loads
    back: '#b8922a',
    ambient: '#0e0a03', // dark vault so the gold reads lit, not flat
    skin: '/assets/aurum-skin.svg',
    knob: '#191309', // onyx knob against the gold case, the black-dial contrast
    main: '#f0cf5c',
    action: '#221a0d',
    pills: '#241c0e',
    label: '#4a3708',
    logo: '#f6e185',
    cardBg: '#d4ab2f',
    cardInk: '#2d2104',
    cardSub: 'rgba(45,33,4,0.66)',
    cardImage: '/assets/aurum-skin.svg', // cover-crop lands on the hidden guilloche medallion
  },
  {
    // The Nothing-style see-through case: front shell goes frosted acrylic, guts show (PCB, coil, battery, RF shields, ribbon, glyph strips); back is white frosted.
    id: 'clear',
    code: '000',
    name: 'Clear',
    clear: true,
    body: '#d7dade', // smoke tint (the front shell rides its attenuation, not this, when clear)
    back: '#eef1f3', // solid white frosted back (the white edition); also the backplate behind the guts
    ambient: '#080a0e', // cool near-black so the internal glow reads
    knob: '#eef0f3', // frosted white knob
    main: '#e5322b', // the red record-dot play button
    action: '#171a20', // dark LCD idle
    pills: '#13151a',
    label: '#9aa0a8',
    logo: '#e5322b',
    cardBg: '#15171c',
    cardInk: '#eef0f3',
    cardSub: 'rgba(216,222,230,0.6)',
  },
  {
    id: 'tangerine',
    code: '2005',
    name: 'Teenager',
    body: '#b8bcc2',
    back: '#9ea2a8',
    knob: '#e05a20',
    main: '#e05a20',
    action: '#555a60',
    pills: '#e8ede0',
    label: '#7a3d12',
    logo: '#e8ede0',
    cardBg: '#b8bcc2',
    cardInk: '#e05a20',
    cardSub: 'rgba(38,40,44,0.6)',
  },
  {
    id: 'moonshot',
    code: '713',
    name: 'Moonshot',
    body: '#f2f2ee',
    back: '#e6e6e1',
    knob: '#c9c9c3',
    main: '#d63a2e',
    action: '#2b2b2b',
    pills: '#2b2b2b',
    label: '#8a8a86',
    logo: '#d63a2e',
    cardBg: '#f3f3ef',
    cardInk: '#d2382c',
    cardSub: 'rgba(40,44,52,0.5)',
  },
  {
    id: 'mint',
    code: '224',
    name: 'Wisteria',
    body: '#c2e9d3',
    back: '#a9dcc1',
    knob: '#8587ef',
    main: '#8587ef',
    action: '#5fbcee',
    pills: '#8bbaa2',
    label: '#4a7060',
    logo: '#0f5132',
    cardBg: '#c2e9d3',
    cardInk: '#6f72e8',
    cardSub: 'rgba(20,72,50,0.6)',
  },
  {
    id: 'carbon',
    code: '212',
    name: 'Carbon',
    body: '#16171b',
    back: '#101115',
    knob: '#f2c044',
    main: '#f2c044',
    action: '#2a2d34',
    pills: '#2a2d34',
    label: '#9296a0',
    logo: '#e6b740',
    cardBg: '#15161a',
    cardInk: '#e6b450',
    cardSub: 'rgba(228,200,140,0.55)',
  },
  {
    id: 'cyberpunk',
    code: '2077',
    name: 'Cyberpunk',
    body: '#cf42cf',
    back: '#b943b9',
    knob: '#efd53f',
    main: '#00e5cc',
    action: '#4c2399',
    pills: '#9e75f2',
    label: '#e8e8f0',
    logo: '#08cdb6',
    cardBg: '#cf42cf',
    cardInk: '#00e5cc',
    cardSub: 'rgba(255,255,255,0.72)',
  },
]

// The ambient the device floats on (root page, desktop surround, the strip framing the 3D handheld).
// Derived from the skin's body color so it feels themed instead of flat black; a theme can pin it with `ambient`.
export function themeBackdrop(theme: ConsoleTheme): string {
  if (theme.ambient) return theme.ambient
  const hex = theme.body.replace('#', '')
  if (hex.length !== 6) return '#0b0b0c'
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  // ~15% of the body hue over a near-black base: enough tint to feel themed, dark enough to frame.
  const ch = (c: number, base: number) =>
    Math.round(c * 0.15 + base * 0.85)
      .toString(16)
      .padStart(2, '0')
  return `#${ch(r, 11)}${ch(g, 11)}${ch(b, 12)}`
}

export const DEFAULT_THEME_ID = 'classic'
export const THEME_BY_ID: Record<string, ConsoleTheme> = Object.fromEntries(
  THEMES.map((t) => [t.id, t]),
)
export const DEFAULT_THEME = THEME_BY_ID[DEFAULT_THEME_ID]

const STORAGE_KEY = 'pips_console_theme'

// The one source of truth for the saved skin. _app feeds it to the live games device; the studio
// reads it to seed the initial selection and writes it on Done.
export function useConsoleTheme() {
  const [id, setId] = useLocalStorage<string>(STORAGE_KEY, DEFAULT_THEME_ID)
  const theme = THEME_BY_ID[id] ?? DEFAULT_THEME
  return { id: theme.id, theme, setId }
}
