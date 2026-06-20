// Device skins. A theme is a whole-device color preset: it recolors the body, the buttons, the nav
// pills and the knob in one shot (no geometry rebuild). ConsoleCanvas applies it to the live
// materials; the Customize studio previews them and persists the pick here. Colors are hex strings
// so they drop straight into THREE.Color.set() and into CSS alike.
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
  knob: string
  main: string // big PLAY button
  action: string // the two action buttons
  pills: string // MENU / GAMES nav pills
  label?: string // MENU / GAMES caption text under the pills (defaults to a muted grey)
  logo?: string // embossed back logo letters (defaults to the accent); picked per skin for contrast
  logoEyes?: string // the logo's eye marks (defaults to `logo`); Classic keeps the red/blue original
  // card preview (CSS colors — the studio renders these, not WebGL)
  cardBg: string
  cardInk: string
  cardSub: string
  cardImage?: string // optional art behind the card (e.g. a skin preview); text sits on a scrim
}

// Each skin is one body + one accent (knob + PLAY) + a quiet neutral for the small buttons. Keeps it
// tasteful, not a toy-box rainbow. Classic is the brand: matte charcoal with the Pips yellow, so the
// default device reads like the logo.
export const THEMES: ConsoleTheme[] = [
  {
    // The signature look, identical to the bare device on /console: cream body, red PLAY, blue
    // actions, yellow knob, red/blue eyes on the back.
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
    name: 'PIVY IT UP!',
    badge: 'pivy.me',
    body: '#7EFE9F',
    back: '#6bcd83',
    knob: '#f2c044',
    main: '#f4f7ff',
    action: '#098227',
    pills: '#2b2b2b',
    label: '#098227',
    logo: '#098227',
    cardBg: '#7EFE9F',
    cardInk: '#098227',
    cardSub: 'rgba(20, 41, 21, 0.5)',
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
]

// The ambient the device floats on: the root page, the desktop surround, and the strip framing the
// 3D handheld. Derived from the skin's body color so the backdrop feels part of the theme instead of
// flat black, but kept deep so the device still reads as the hero. A theme can pin it with `ambient`.
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
