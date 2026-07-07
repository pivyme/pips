# CLAUDE.md

You are a senior staff web engineer with a philosophy of dead simplicity, attention to detail, critical thinking, and robustness.

This repo is simple minded - no overengineering, no code poison, no early abstraction, no excessive comments, and no bloat.

---

## Project Overview

This is the **PIPS** frontend: the gamified trading console. PIPS makes trading simple, intuitive, and addictive, like a game, on Sui via DeepBook Predict. Read the root [`../CLAUDE.md`](../CLAUDE.md) for product context and the Sui stack, [`../docs/DESIGN.md`](../docs/DESIGN.md) for the App Surface design language, [`../docs/SCREEN.md`](../docs/SCREEN.md) for the in-device screen language (the Teenage Engineering instrument style every `/games/*` screen follows), and [`../docs/FLOW.md`](../docs/FLOW.md) for the app flow (the surfaces, the on-device Home screen, the navigation map). This was forked from a React starter, so reframe anything still labeled "starter".

**v1 build:** frontend work is planned in [`../bigdev/plans/`](../bigdev/plans/). Read `06-GAMES.md` (the games + the 60fps chart, bound to the existing console controls), `07-DESIGN-SYSTEM.md` (screen states + verbatim copy; `../docs/DESIGN.md` is canonical), `05-SUI-PREDICT.md` (the thin client Predict wrapper), `LUCKY.md` §6 (dev + Privy auth, the current source of truth), `02-API.md` (the backend contract). The console shell, Knob, `useConsoleControls`, and `Illo` are already built, do not rebuild them.

**Predict capability box (read before inventing a game mechanic):** the on-chain vocabulary is exactly two expiry-settled instruments, **binary up/down** and **vertical range**, both with live-bid early cash-out. No barrier/touch, no path-dependent or crash-style payoff, no in-Predict leverage, no fixed odds. The games (Lucky, Range, Line Rider, Candle Hop) all compose from those two. Full source-cited box in `../bigdev/plans/05-SUI-PREDICT.md` and the root [`../CLAUDE.md`](../CLAUDE.md).

## PIPS frontend specifics

**The UI is a device, not a dashboard.** Everything renders inside a persistent console shell with a swappable **Screen**. The physical controls (Main Action Button, Action Buttons 1/2, Knob, Menu/Games tabs) belong to the shell, but each game binds their behavior via a controls registration (`useConsoleControls()`). The shell exists in two forms: the real 3D **WebGL handheld** `ConsoleCanvas` (Three.js) and a CSS/DOM `ConsoleShell` fallback. The whole `/games` subtree (the hub + Lucky, Range, Line Rider, Candle Hop) runs on the 3D device, laid out for the L-shaped aperture; `ConsoleShell` is the fallback behind the menu. Use `web-haptics` for tactile feedback. Full spec and layout in [`../docs/DESIGN.md`](../docs/DESIGN.md). If a screen could pass for any other trading app, it is wrong.

### Menu drawer page transitions

The `/menu/*` routes use a native-style push/pop transition inside the persistent drawer. Preserve this behavior:

- Forward navigation pushes the new page in from the right over the current page. The old page recedes left, dims, and scales down slightly.
- Back navigation reverses it: the current page slides right while the menu page is revealed underneath.
- The transition uses TanStack Router's `viewTransition` option and the browser View Transition API. The drawer's scroll surface is named `menu-page` in `MenuDrawer.tsx`; direction is set with `prepareMenuTransition('forward' | 'back')` before navigation; animation keyframes live in `styles.css`.
- Keep the full page, including its sticky header, inside the named transition surface. Do not animate separate route fragments.
- Do not implement this with two live `<Outlet>` instances or keyed wrappers around the same `<Outlet>`. TanStack resolves both to the new route, causing duplicated pages during the overlap. Browser snapshots are required to preserve the real outgoing page.
- Every menu-hub link to a sub-screen and every menu back link must enable `viewTransition` and set the correct direction first.
- Keep the 420ms fluid easing, dark overlap shadow, and reduced-motion fallback unless the user explicitly requests a different feel.

**Sui (verified mid 2026, reconfirm before coding):**
- Core SDK `@mysten/sui` (v2.x, ESM only). PTBs use `Transaction` from `@mysten/sui/transactions` (renamed from `TransactionBlock`). Fullnode reads go through `SuiGrpcClient` (`@mysten/sui/grpc`, built with an explicit `baseUrl`); JSON-RPC is removed, never re-add `@mysten/sui/jsonRpc`. grpc-web runs over fetch (no extra WASM).
- Wallet connect phase 1: `@suiet/wallet-kit` (`<WalletProvider>`, `<ConnectButton/>`, `useWallet`). The official standard is now the split `@mysten/dapp-kit-react` + `@mysten/dapp-kit-core`, both ride the same Wallet Standard.
- Auth: **Privy** `@privy-io/react-auth` (+ `/extended-chains`). Google/email login + a non-custodial embedded ed25519 (Sui) wallet, driven by `src/lib/privy.tsx` (the provider + login -> wallet -> session-signer -> `/auth/privy/verify` bridge). Enoki/zkLogin is removed. Confirm the Privy API live, it moves fast.
- Predict is hand-built PTBs via `@mysten/sui` against our own published predict package (the `@mysten/deepbook-v3` SDK has no Predict support). **Runs on our own Sui localnet (`https://rpc.playpips.fun`), not testnet; ids are per-deployment, never hardcode.** All Predict calls go through `src/lib/sui/predict.ts`; ids come from `src/lib/sui/config.ts` (fed by `env.ts`), never inline. `VITE_SUI_NETWORK=localnet` + `VITE_SUI_FULLNODE_URL` point the browser at the live node; the localnet itself is set up via `scripts/localnet.sh` at the repo root.
- Env is typed/validated in `src/env.ts`. Add `VITE_SUI_NETWORK`, `VITE_PRIVY_APP_ID` etc there, import from `env.ts`, not `import.meta.env`.
- **Bun + WASM gotcha:** the Sui crypto stack pulls WASM and `vite-plugin-wasm` can fail when the Vite dev server runs through Bun. If you hit a WASM load error, run the dev server on Node (bun stays the package manager).

## The console screen (the L-shaped aperture)

**Visual language first:** everything that renders inside the screen (Home + all games) follows [`../docs/SCREEN.md`](../docs/SCREEN.md), the Teenage Engineering instrument style: flat true-black, electric high-contrast ink, hairline rules and full-bleed fills (no rounded cards, no `card-neo`, no domed surfaces, no blur, no emoji), mono uppercase micro-labels over big bold tabular numbers, one amber active accent, green/red for facts. **That is a different language from the App Surface / menu drawer.** The Home screen (`routes/_app/games/index.tsx`) is the reference. Read SCREEN.md before designing or redesigning any `/games/*` screen. This section below is the **layout mechanics** of the aperture; SCREEN.md is the look.

Game screens (`/games/*`) render as an HTML layer **behind** the 3D device and show through a cutout in the body. `ConsoleCanvas` projects that cutout on every resize and positions the layer onto it; the device body masks anything outside it. Treat the screen as a real, oddly shaped, **variable-height** display, not a plain rectangle. Three rules, always:

- **The bottom-right is not screen.** The aperture is an L: full width at the top, but the bottom-right corner is the device body, where the knob and the main PLAY button physically sit. The bottom row is **left-only**, keep its content to about 60% width. Never place anything in the bottom-right, it is occluded by the body.
- **Inset text off the rim with `var(--screen-rim)`, never a fixed px.** The beveled, rounded cutout edge overlaps the HTML layer, and it **scales with the device** (the screen is responsive), so any hardcoded pad (`p-4`, `p-6`) crops once the device grows. `ConsoleCanvas` publishes `--screen-rim` (a rim-safe inset in px, recomputed every resize) on the screen layer; pad text/readout zones with it (`p-[var(--screen-rim,24px)]`). The shared games layout (`components/game/screen.tsx` `GameStage`/`GameReadout`) already does this. Structural fills (the chart, hairline rules, a selected-row highlight) **bleed full width** and tuck under the rim, that is what reads edge-to-edge, terminal-style; only text insets.
- **Height is responsive, never fixed.** The device stretches the screen taller to fill frames taller than its natural ratio (`ConsoleCanvas` `screenExt`, the control deck stays put). So lay the screen out as a vertical flex stack that absorbs the extra height in the **chart**, and never assume a pixel height.

**The layout contract, three zones top to bottom:**

1. **Top bar** (full width, fixed height): balance, live price, asset and status. The persistent context.
2. **Chart** (`min-h-0 flex-1`): takes all the slack height and absorbs the responsive stretch. It lives **above** zone 3, it must not run under it.
3. **Bottom info** (notch-safe, left-only, content-height): a clean grid of the play's numbers, payout, stake, multiplier, PnL. The dedicated readout zone.

```tsx
<div className="relative flex h-full flex-col bg-black">
  <div className="relative min-h-0 flex-1">        {/* zones 1+2: chart fills, top bar floats over it */}
    <Chart className="absolute inset-0" />
    <TopBar className="absolute inset-x-0 top-0 p-4" />   {/* balance · price, padded */}
  </div>
  <BottomInfo className="max-w-[60%] p-4" />         {/* zone 3: notch-safe readout grid */}
</div>
```

**The mistake to prevent:** a full-bleed chart (`absolute inset-0` over the whole screen) with the readouts floating on top of it. On a tall frame the chart then eats the entire height and the numbers sit over the line. The chart must **stop above the bottom info zone**, with the readouts in their own band below it, not overlapping.

## Demo mode (intentional, user-requested)

`VITE_DEMO_MODE=true` (or the landing-page toggle, stored under localStorage `pips_demo`) runs the **entire app on an in-memory mock**: no backend, no Sui, play money. It exists so anyone can play the full UI with zero setup. This is the ONE sanctioned exception to the "no sim, Predict is the engine" rule, and it is fully isolated: `src/lib/demo.ts` is the only sim, and the real product is always real Predict.

- One seam: `src/lib/api.ts` routes the `api` client + `streamPrices`/`streamPlay` through `demo.ts` when `isDemo()`, and `src/lib/auth.tsx` drops straight into a mock authed session. Games, screens, and `predict.ts` are untouched, they never know.
- It is always clearly badged (the `Demo` chip in the status strip, the landing chip + toggle, a reset in Settings). Keep it that way.
- Do NOT wire demo state into the real backend or chain, and do NOT leak it into the real path. If you add a new `api` method or stream, add its demo twin in `demo.ts` so demo stays complete.

## Game audio

All game sound is **hand-built WebAudio, zero asset files**. Two files, two jobs:

- **`src/lib/sound.ts`** is the per-game musical layer: the looping beds and the one-shot stings (spin, lock, win, lose, cash-out). This is where new game audio goes.
- **`src/components/console/consoleAudio.ts`** is the physical device SFX (button/knob/roller), sample-based, owned by the shell. Leave it alone unless you are changing a control's feel.

**The quality bar (this is the whole point, keep it).** The house sound is "clean, warm, not 8-bit, never intrusive." It comes from a few hard rules:

- **No raw square/blip waves for anything melodic.** Melodic content uses `bell()` (the soft mallet/marimba voice: filtered triangle + an octave shimmer) or a plain filtered `triangle`/`sine`. `sawtooth`/`square` are texture only (bass, a tense arp) and always go through a lowpass. A bare square tone is the 8-bit smell, avoid it.
- **Soft attack, exponential decay, always.** ~6-12ms ramp on, exponential ramp off, never an instant on/off (that clicks). Use `setValueAtTime(0.0001, ...)` then `exponentialRampToValueAtTime`, the pattern every voice already uses.
- **Percussion is filtered noise, not bright noise.** Shakers, detents, whooshes are short bursts of the shared `noise()` buffer through a band/low/high-pass at a tamed cutoff. Bright unfiltered noise reads cheap.
- **Beds stay beds.** A loop runs at low bus gain (~0.2-0.26), fades in and out, and **only rides the active round** (wire start/stop to the playing phase, never play at idle). Silence at rest is what keeps it non-annoying. The resolve sting always lands over silence, so **stop the bed first**, then play win/lose.
- **Every game gets its own identity, do NOT reuse a bed.** Same quality bar, different music. Pick a distinct key, tempo, progression, and timbre per game so they never blur together. The two references: **Lucky** is bright/playful (major C-G-Am-F, ~104bpm, mallet arp + soft kick + shaker), **Range** is dark/tense (minor i-VI-VII-V, ~122bpm, resonant saw arp + four-on-the-floor). A new game should sound like neither.

**Plumbing (reuse it, don't reinvent).** Every voice: no-ops when sound is off (`enabled`), resumes a suspended `AudioContext`, and fires after a user gesture so autoplay policy is never hit. Everything routes through the shared synth bus `out(ac)` (master `SYNTH_LEVEL`) so it balances against the device SFX (`SFX_LEVEL` in consoleAudio.ts). A bed gets its own sub-gain that fades, then connects to `out(ac)`. The shared helpers are `blip()` (quick percussive ping), `bell()` (the warm mallet, the default for melody), and `noise()` (the lazy noise buffer).

**Recipe for a new game's audio:**
1. In `sound.ts`, add a section mirroring the Range/Lucky blocks: `start<Game>Bgm()`/`stop<Game>Bgm()` (copy the lookahead scheduler verbatim, it keeps note timing tight through timer jitter) plus the one-shot stings the game needs.
2. Reuse `bell()`/`blip()`/`noise()`; write per-game `kick`/`bass`/`arp`/`shaker` helpers that take a `dest` bus so they fade with the bed.
3. Wire it in the game screen like Lucky does: a `bedPlaying` boolean (`reelsCycling || roundActive`) effect that starts on the active round and `stopXBgm()` in the cleanup, and route the result to win/lose/cash-out in `finishResult` after stopping the bed.
4. If sound can be toggled off mid-round, add your `stop<Game>Bgm()` to `setSoundEnabled()`.
5. The one balance knob per game is the bed's fade-in target gain in `start<Game>Bgm()` (Lucky `0.2`, Range `0.26`). Master is `SYNTH_LEVEL`.

## Tech Stack

- **Framework**: TanStack Start (React 19 meta-framework, SSR-capable)
- **Routing**: TanStack Router (file-based, see Routing below)
- **State/Data**: TanStack Query for server state
- **Styling**: Tailwind CSS 4 + HeroUI v3 component library
- **3D console**: Three.js (the WebGL handheld, `components/console/ConsoleCanvas.tsx`)
- **Animation**: Motion (Motion One, the `motion` package) + GSAP; Lenis smooth scroll on the landing page
- **Icons / toasts**: lucide-react, react-hot-toast
- **Build**: Vite 8 + Nitro
- **Language**: TypeScript (strict mode)
- **Package Manager**: bun

## Project Structure

```
src/
├── routes/                   # File-based routes (TanStack Router)
│   ├── __root.tsx            # Root providers, meta, query client
│   ├── index.tsx             # Landing / sign-in door (outside the console shell)
│   ├── console.tsx           # Standalone 3D console route
│   ├── design-system.tsx     # Living UI-kit reference (/design-system)
│   ├── pitch.tsx             # Standalone pitch deck (/pitch), outside the shell
│   ├── export.tsx            # Dev-only PNG dump of the device per skin (personal tooling)
│   ├── tools/wallet.tsx      # Standalone node wallet (/tools/wallet)
│   └── _app/                 # Pathless layout: everything "inside the device"
│       ├── games/            # index, lucky, range, line-rider, candle-hop
│       └── menu/             # index, stats, achievements, customize, settings
├── components/
│   ├── console/              # The device shell (the heart of the app)
│   │   ├── ConsoleCanvas.tsx # 3D WebGL handheld (Three.js) + screen-cutout projection
│   │   ├── ConsoleShell.tsx  # CSS/DOM shell (fallback behind the menu)
│   │   ├── CustomizeStudio.tsx # Skin/theme workshop (/menu/customize)
│   │   ├── AppFrame.tsx      # Phone-sized frame wrapper
│   │   ├── MenuDrawer.tsx    # Menu as a drawer over the device
│   │   ├── Knob.tsx          # The physical knob
│   │   ├── controls.tsx      # useConsoleControls + provider (the binding registry)
│   │   ├── consoleGeo.ts     # Three.js geometry for the device body
│   │   ├── consoleElements.ts # Geometry/mesh factories for the physical controls
│   │   ├── themes.ts         # Console skins/themes
│   │   ├── consoleGui.ts / customizeGui.ts # lil-gui tuning panels (dev)
│   │   └── consoleAudio.ts   # Console SFX
│   ├── game/                 # Chart.tsx (live chart), screen.tsx, instruments.tsx, CoinCRT.tsx, flapEngine.ts (candle-hop), rideEngine.ts (line-rider)
│   ├── menu/                 # StatsCard.tsx, shared.tsx
│   └── elements/             # AnimateComponent (starter residue, currently unused)
├── ui/                       # HeroUI v3 wrappers + Illo (Button, Card, Modal, TextField, Tooltip, Switch, LoadingIcon)
├── lib/                      # Integrations + app logic
│   ├── api.ts                # Typed backend client + SSE; the demo seam lives here
│   ├── auth.tsx              # Auth context (dev auto-login / Privy login)
│   ├── privy.tsx             # Privy provider + login->wallet->verify bridge (privy mode)
│   ├── demo.ts               # The ONE sanctioned in-memory sim (demo mode)
│   ├── achievements.ts, haptics.ts, sound.ts, shareCard.ts, errors.ts, polyfills.ts
│   └── sui/                  # predict.ts (the one Predict wrapper), config.ts (ids from env), devwallet.ts (/tools/wallet helper)
├── hooks/                    # useLocalStorage, useReducedMotion
├── utils/                    # style.ts (cnm), format.ts, motion.ts
├── integrations/             # tanstack-query root provider
├── providers/                # LenisSmoothScrollProvider
└── config.ts, env.ts, router.tsx, styles.css
```

## Key Files

| File | Purpose |
|------|---------|
| `src/routes/_app.tsx` | Pathless layout: mounts the persistent shell (3D `ConsoleCanvas` for the whole `/games` subtree, CSS `ConsoleShell` fallback), the menu drawer, and the auth gate |
| `src/components/console/controls.tsx` | `useConsoleControls()` (a screen registers Main / Action 1·2 / Knob / status) + provider. The console binding contract |
| `src/components/console/ConsoleCanvas.tsx` | The 3D WebGL handheld (Three.js): device body + screen-cutout projection (`screenExt`) behind the HTML screen layer |
| `src/components/console/ConsoleShell.tsx` | The CSS/DOM console shell |
| `src/components/game/Chart.tsx` | The live price chart on the screen |
| `src/lib/api.ts` | Typed backend client + SSE streams; the demo-mode seam |
| `src/lib/auth.tsx` | Auth context (dev auto-login + Privy login) |
| `src/lib/privy.tsx` | Privy provider + login->embedded-Sui-wallet->session-signer->verify bridge (privy mode) |
| `src/lib/demo.ts` | The in-memory mock for demo mode (the only sim) |
| `src/lib/sui/predict.ts` | The one client-side Predict wrapper. All Predict calls route here |
| `src/lib/sui/config.ts` | Predict / package ids, read from `env.ts` (never inline) |
| `src/ui/Illo.tsx` | The illustration set (game + achievement art). Already built, do not rebuild |
| `src/env.ts` | Typed/validated env via `@t3-oss/env-core` + zod. Import from here, not `import.meta.env` |
| `src/utils/style.ts` | `cnm()` utility for className merging |
| `src/utils/format.ts` | Number/currency/date formatting |

## Commands

```bash
bunx tsc --noEmit   # Typecheck gate (the build loop's baseline check)
bun dev        # Start dev server on port 3200
bun build      # Production build
bun preview    # Preview production build
bun lint       # Run ESLint
bun format     # Run Prettier
bun check      # Format + lint fix
bun test       # Run Vitest tests
```

## Development Guidelines

### Component Organization

1. **A game screen registers the console controls when it mounts** (`src/components/console/controls.tsx`). The core pattern: the screen declares what Main / Action 1·2 / Knob / status do, the shell renders them.
   ```tsx
   import { useConsoleControls } from '@/components/console/controls'

   useConsoleControls({
     main:    { label: 'PLAY',  onPress: play, loading: isPending },
     action1: { label: 'LONG',  color: 'up',   onPress: () => setSide('up') },
     action2: { label: 'SHORT', color: 'down', onPress: () => setSide('down') },
     knob:    { min: 1, max: 100, step: 1, value: bet, onChange: setBet, label: 'BET' },
   })
   ```

2. **Use cnm() for conditional classes**
   ```tsx
   import { cnm } from '@/utils/style'

   <div className={cnm(
     'base-classes',
     isActive && 'active-classes',
     variant === 'primary' && 'primary-classes'
   )} />
   ```

3. **HeroUI v3 components — always go through `@/ui/*` wrappers**

   **MANDATORY**: Before writing or modifying any HeroUI v3 code, fetch the current v3 API. v2 patterns (HeroUIProvider, framer-motion, flat props on Card/Modal/TextField, etc.) DO NOT work in v3. Never guess the API from memory.

   - If the `heroui-react` skill is installed, invoke it (it gives you scripts to dump component docs/source/styles).
   - Otherwise, fetch the MDX docs directly: `https://heroui.com/docs/react/components/<component>.mdx` (e.g. `modal.mdx`, `card.mdx`, `text-field.mdx`).

   **Pattern**: We wrap compound HeroUI components in `src/ui/` with flat, single-component APIs so styling changes happen in one place. Use the wrappers for anything we have one, import HeroUI directly only for components without a wrapper yet (Button, Switch, Checkbox, Chip, Slider, Avatar, ProgressBar, Tabs, Popover, etc.).

   **Available wrappers in `src/ui/`:**

   ```tsx
   // Modal — flat, no Backdrop/Container/Dialog/Header/Heading chain
   import { Modal, useOverlayState } from '@/ui/Modal'
   const state = useOverlayState()
   <Modal
     isOpen={state.isOpen}
     onOpenChange={state.setOpen}
     title="Confirm action"
     description="This cannot be undone."
     footer={<Button onPress={state.close}>Close</Button>}
     size="md"            // xs | sm | md | lg | cover | full
     placement="center"   // auto | center | top | bottom
     backdrop="opaque"    // opaque | blur | transparent
     isDismissable
   >
     Body content
   </Modal>

   // Card — title/description/footer flattened
   import { Card } from '@/ui/Card'
   <Card title="Product" description="A great product" footer={<Button>Buy</Button>}>
     content
   </Card>

   // TextField — label/input/description/error flattened, multiline switches to TextArea
   import { TextField } from '@/ui/TextField'
   <TextField
     label="Email"
     description="We never share it."
     error={validationError}        // when truthy, renders as FieldError
     placeholder="you@example.com"
     value={email}
     onChange={setEmail}
     type="email"
     isRequired
   />

   // Tooltip — content as prop, single child as trigger
   import { Tooltip } from '@/ui/Tooltip'
   <Tooltip content="Helpful info" placement="top" showArrow delay={0}>
     <Button>Hover</Button>
   </Tooltip>
   ```

   **Direct HeroUI imports** (no wrapper yet, OK to import from `@heroui/react`):

   ```tsx
   import { Button } from '@heroui/react'
   // v3 variants: primary, secondary, tertiary, outline, ghost, danger
   // No radius prop — use Tailwind classes (e.g. rounded-none)
   // No startContent/endContent — place icons as children
   // Use onPress, not onClick
   ```

   **Adding a new wrapper**: create `src/ui/<Name>.tsx`, flatten the compound API into props, expose every prop the consumer realistically needs. If you find yourself writing the same nested HeroUI structure twice, wrap it.

### Routing (TanStack Router)

- Routes are file-based in `src/routes/`; use `createFileRoute`. Root layout is `__root.tsx`.
- `_app.tsx` is a **pathless layout route**: everything "inside the device" (games + menu) renders through one persistent console shell. The landing `/` lives outside it and owns the full viewport.
- Games: `/games/{lucky,range,line-rider,candle-hop}`. Menu: `/menu/*` renders as a **drawer over** the device, not a screen inside it.
- Two shells: the whole `/games` subtree runs on the 3D WebGL handheld (`ConsoleCanvas`); the CSS `ConsoleShell` is the fallback. One `ConsoleCanvas` stays mounted across games↔menu so the WebGL scene builds once.

### Styling

- **Tailwind CSS 4** - use `@import "tailwindcss"` syntax
- **Dark theme by default** - neutral color palette
- **Inter Variable font** - imported globally
- Custom scrollbar and selection styles in `styles.css`

### Data Fetching

- Use **TanStack Query** for server state
- Query client is set up in `src/integrations/tanstack-query/`
- Access via `useQuery`, `useMutation` hooks

### Animations

- **Motion** (Motion One, the `motion` package) for component animations
- **GSAP** for complex/timeline animations where needed
- **Lenis** smooth scrolling on the landing page
- `AnimateComponent` (in `components/elements/`) is leftover starter and currently unused, it is not the house pattern

## Code Style

- **TypeScript strict mode** enabled
- **ESLint + Prettier** for formatting
- Import aliases: `@/` maps to `src/`
- No barrel files - import directly from source files
- Keep components focused - extract when reused 2+ times

## Adding New Features

1. **New route**: Create file in `src/routes/` (e.g., `about.tsx` for `/about`)
2. **New component**: Add to `src/components/` (or `elements/` if generic)
3. **New utility**: Add to `src/utils/`
4. **New hook**: Add to `src/hooks/`
5. **API integration**: Add to `src/lib/`

## Common Patterns

### A game screen (binds the device, renders on the screen)
```tsx
import { createFileRoute } from '@tanstack/react-router'
import { useConsoleControls } from '@/components/console/controls'

export const Route = createFileRoute('/_app/games/lucky')({ component: LuckyScreen })

function LuckyScreen() {
  const [bet, setBet] = useState(10)
  useConsoleControls({
    main: { label: 'PLAY', onPress: play },
    knob: { min: 1, max: 100, step: 1, value: bet, onChange: setBet, label: 'BET' },
  })
  // Render the screen content only. The shell draws the buttons / knob / status.
  return <div className="relative flex h-full flex-col">{/* top bar · chart · readouts */}</div>
}
```

### Data fetching
```tsx
import { useQuery } from '@tanstack/react-query'

function MyComponent() {
  const { data, isLoading } = useQuery({
    queryKey: ['items'],
    queryFn: () => fetch('/api/items').then(r => r.json()),
  })

  if (isLoading) return <div>Loading...</div>
  return <div>{data.map(...)}</div>
}
```

## Deployment

- **Vercel**: This is a monorepo, so set the project **Root Directory to `web`** in Vercel settings. The rest is pinned in [`web/vercel.json`](./vercel.json): **Framework preset `tanstack-start`** (NOT Vite, or Vercel serves a static dir and every SSR route 404s), build `bun run build`, install `bun install`. This is a TanStack Start (SSR) app: the build runs Nitro, which on Vercel emits `.vercel/output` (the Build Output API) with the server as a Vercel Function. Do **not** set an Output Directory override, the Build Output API is the artifact. Leave the dashboard Framework Preset to match (or let `vercel.json` win).
- **Other platforms**: Run `bun run build`; the default Nitro node-server preset writes `.output/` (server + `public/`). Serve `.output/server/index.mjs`.

## Important Notes

- This uses **TanStack Start** (SSR-capable), not plain Vite React
- HeroUI v3 requires no provider wrapper, CSS handled via `@import "@heroui/styles"` in styles.css
- GSAP is the free version (not Shockingly) - all features available
- Lenis smooth scroll is initialized globally in root layout
- Part of a monorepo. Sibling `backend/` is a Bun + Fastify API on :3780. Wire calls via `VITE_API_URL` from `src/env.ts`. Backend CORS is locked to `ALLOWED_ORIGIN` in production.
- Animation lib `motion` is Motion One (rebranded successor to Framer Motion). Existing Framer Motion docs mostly apply.
