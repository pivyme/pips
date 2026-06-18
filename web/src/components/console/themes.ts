// Device skins. A theme is a whole-device color preset: it recolors the body, the buttons, the nav
// pills and the knob in one shot (no geometry rebuild). ConsoleCanvas applies it to the live
// materials; the Customize studio previews them and persists the pick here. Colors are hex numbers
// so they drop straight into THREE.Color.set().
import { useLocalStorage } from '@/hooks/useLocalStorage'

export interface ConsoleTheme {
  id: string
  code: string // the little serial on the card (212, 713, …)
  name: string
  badge?: string // small corner tag, e.g. NEW
  // device materials
  body: number
  back?: number // defaults to body
  knob: number
  main: number // big PLAY button
  action: number // the two action buttons
  pills: number // MENU / GAMES nav pills
  logo?: number // embossed back logo letters (defaults to the accent); picked per skin for contrast
  logoEyes?: number // the logo's eye marks (defaults to `logo`); Classic keeps the red/blue original
  // card preview (CSS colors — the studio renders these, not WebGL)
  cardBg: string
  cardInk: string
  cardSub: string
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
    body: 0xe9dbbf,
    back: 0xe9dbbf,
    knob: 0xefc03b,
    main: 0xd63a2e,
    action: 0x3568c9,
    pills: 0xe9dbbf,
    logo: 0xff4444,
    logoEyes: 0x4488ff,
    cardBg: '#e9dbbf',
    cardInk: '#c8372b',
    cardSub: 'rgba(54,40,24,0.55)',
  },
  {
    // The logo skin: matte graphite with the Pips yellow.
    id: 'graphite',
    code: '024',
    name: 'Graphite',
    body: 0x3a3a3a,
    back: 0x323232,
    knob: 0xf2c044,
    main: 0xf2c044,
    action: 0x545454,
    pills: 0x545454,
    logo: 0xf2c044,
    cardBg: '#343434',
    cardInk: '#f2c044',
    cardSub: 'rgba(242,192,68,0.5)',
  },
  {
    id: 'carbon',
    code: '212',
    name: 'Carbon',
    body: 0x16171b,
    back: 0x101115,
    knob: 0xe6b450,
    main: 0xe6b450,
    action: 0x2a2d34,
    pills: 0x2a2d34,
    logo: 0xe6b450,
    cardBg: '#15161a',
    cardInk: '#e6b450',
    cardSub: 'rgba(230,180,80,0.5)',
  },
  {
    id: 'moonshot',
    code: '713',
    name: 'Moonshot',
    body: 0xf2f2ee,
    back: 0xe6e6e1,
    knob: 0xc9c9c3,
    main: 0xd63a2e,
    action: 0x2b2b2b,
    pills: 0x2b2b2b,
    logo: 0xd63a2e,
    cardBg: '#f3f3ef',
    cardInk: '#d2382c',
    cardSub: 'rgba(40,40,40,0.42)',
  },
  {
    id: 'nye',
    code: '2026',
    name: 'NYE',
    badge: 'NEW',
    body: 0xd24fd2,
    back: 0xb943b9,
    knob: 0xffd24a,
    main: 0x1d1330,
    action: 0x1d1330,
    pills: 0xefbfef,
    logo: 0xffd24a,
    cardBg: '#d24fd2',
    cardInk: '#241030',
    cardSub: 'rgba(36,16,48,0.6)',
  },
  {
    id: 'mint',
    code: '349',
    name: 'Spearmint',
    body: 0xc2e9d3,
    back: 0xa9dcc1,
    knob: 0x17a05f,
    main: 0x17a05f,
    action: 0x2e4a40,
    pills: 0xdcf3e7,
    logo: 0x0f5132,
    cardBg: '#c2e9d3',
    cardInk: '#0f5132',
    cardSub: 'rgba(15,81,50,0.55)',
  },
  {
    id: 'dusk',
    code: '904',
    name: 'Dusk',
    body: 0x2b2440,
    back: 0x221d33,
    knob: 0xf7b955,
    main: 0xf7b955,
    action: 0x3a3354,
    pills: 0x3a3354,
    logo: 0xf7b955,
    cardBg: '#2b2440',
    cardInk: '#f7b955',
    cardSub: 'rgba(247,185,85,0.5)',
  },
  {
    id: 'tangerine',
    code: '088',
    name: 'Tangerine',
    body: 0xff7a2e,
    back: 0xe86a22,
    knob: 0x1a1a1a,
    main: 0x1a1a1a,
    action: 0xd85f1f,
    pills: 0xffd0a8,
    logo: 0x1a1a1a,
    cardBg: '#ff7a2e',
    cardInk: '#241000',
    cardSub: 'rgba(36,16,0,0.55)',
  },
]

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
