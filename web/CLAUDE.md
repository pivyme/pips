# CLAUDE.md

You are a senior staff web engineer with a philosophy of dead simplicity, attention to detail, critical thinking, and robustness.

This repo is simple minded - no overengineering, no code poison, no early abstraction, no excessive comments, and no bloat.

---

## Project Overview

This is the **Pips** frontend: the gamified trading console. Pips makes trading simple, intuitive, and addictive, like a game, on Sui via DeepBook Predict. Read the root [`../CLAUDE.md`](../CLAUDE.md) for product context and the Sui stack, and [`../docs/DESIGN.md`](../docs/DESIGN.md) for the design language. This was forked from a React starter, so reframe anything still labeled "starter".

**v1 build:** frontend work is planned in [`../bigdev/plans/`](../bigdev/plans/). Read `06-GAMES.md` (the three games + the 60fps chart, bound to the existing console controls), `07-DESIGN-SYSTEM.md` (screen states + verbatim copy; `../docs/DESIGN.md` is canonical), `05-SUI-PREDICT.md` (the thin client Predict wrapper), `04-AUTH.md` (dev + Enoki zkLogin), `02-API.md` (the backend contract). The console shell, Knob, `useConsoleControls`, and `Illo` are already built, do not rebuild them.

**Predict capability box (read before inventing a game mechanic):** the on-chain vocabulary is exactly two expiry-settled instruments, **binary up/down** and **vertical range**, both with live-bid early cash-out. No barrier/touch, no path-dependent or crash-style payoff, no in-Predict leverage, no fixed odds. The three games (Lucky, Range, Moonshot) all compose from those two. Full source-cited box in `../bigdev/plans/05-SUI-PREDICT.md` and the root [`../CLAUDE.md`](../CLAUDE.md).

## Pips frontend specifics

**The UI is a device, not a dashboard.** Everything renders inside a persistent console shell with a swappable **Screen**. The physical controls (Main Action Button, Action Buttons 1/2, Knob, Menu/Games tabs) belong to the shell, but each game binds their behavior via a controls registration (`useConsoleControls()`). The shell exists in two forms today: a CSS/DOM `ConsoleShell`, and the real 3D **WebGL handheld** `ConsoleCanvas` (Three.js). Range runs on the 3D device; the other routes are still on the CSS shell until their screens are laid out for the L-shaped aperture. Use `web-haptics` for tactile feedback. Full spec and layout in [`../docs/DESIGN.md`](../docs/DESIGN.md). If a screen could pass for any other trading app, it is wrong.

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
- Core SDK `@mysten/sui` (v2.x, ESM only). PTBs use `Transaction` from `@mysten/sui/transactions` (renamed from `TransactionBlock`).
- Wallet connect phase 1: `@suiet/wallet-kit` (`<WalletProvider>`, `<ConnectButton/>`, `useWallet`). The official standard is now the split `@mysten/dapp-kit-react` + `@mysten/dapp-kit-core`, both ride the same Wallet Standard.
- zkLogin phase 2: Enoki `@mysten/enoki` (`/react`), registered into the wallet layer so Google login shows up as a connectable wallet.
- Predict is hand-built PTBs via `@mysten/sui` against our own published predict package (the `@mysten/deepbook-v3` SDK has no Predict support). **Testnet only, ids unstable.** All Predict calls go through `src/lib/sui/predict.ts`; ids come from `src/lib/sui/config.ts` (fed by `env.ts`), never inline.
- Env is typed/validated in `src/env.ts`. Add `VITE_SUI_NETWORK`, `VITE_ENOKI_API_KEY` etc there, import from `env.ts`, not `import.meta.env`.
- **Bun + WASM gotcha:** the Sui crypto stack pulls WASM and `vite-plugin-wasm` can fail when the Vite dev server runs through Bun. If you hit a WASM load error, run the dev server on Node (bun stays the package manager).

## The console screen (the L-shaped aperture)

Game screens (`/games/*`) render as an HTML layer **behind** the 3D device and show through a cutout in the body. `ConsoleCanvas` projects that cutout on every resize and positions the layer onto it; the device body masks anything outside it. Treat the screen as a real, oddly shaped, **variable-height** display, not a plain rectangle. Three rules, always:

- **The bottom-right is not screen.** The aperture is an L: full width at the top, but the bottom-right corner is the device body, where the knob and the main PLAY button physically sit. The bottom row is **left-only**, keep its content to about 60% width. Never place anything in the bottom-right, it is occluded by the body.
- **Pad everything off the rim.** The beveled rim frames the screen, so content touching the edge reads as broken. Inset the screen content (at least `p-4`) on the top, the sides, and the notch-safe bottom-left. The chart may bleed full width, but text and readouts never touch an edge.
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
│   └── _app/                 # Pathless layout: everything "inside the device"
│       ├── games/            # index, lucky, range, tap
│       └── menu/             # index, stats, achievements, customize, settings
├── components/
│   ├── console/              # The device shell (the heart of the app)
│   │   ├── ConsoleCanvas.tsx # 3D WebGL handheld (Three.js) + screen-cutout projection
│   │   ├── ConsoleShell.tsx  # CSS/DOM shell (routes not yet on the 3D aperture)
│   │   ├── AppFrame.tsx      # Phone-sized frame wrapper
│   │   ├── MenuDrawer.tsx    # Menu as a drawer over the device
│   │   ├── Knob.tsx          # The physical knob
│   │   ├── controls.tsx      # useConsoleControls + provider (the binding registry)
│   │   ├── consoleGeo.ts     # Three.js geometry for the device body
│   │   ├── consoleGui.ts     # lil-gui tuning panel (dev)
│   │   └── consoleAudio.ts   # Console SFX
│   ├── game/                 # Chart.tsx (live chart), screen.tsx, instruments.tsx
│   ├── menu/                 # StatsCard.tsx, shared.tsx
│   └── elements/             # AnimateComponent (starter residue, currently unused)
├── ui/                       # HeroUI v3 wrappers + Illo (Button, Card, Modal, TextField, Tooltip, Switch)
├── lib/                      # Integrations + app logic
│   ├── api.ts                # Typed backend client + SSE; the demo seam lives here
│   ├── auth.tsx              # Auth context (dev auto-login / Enoki zkLogin)
│   ├── demo.ts               # The ONE sanctioned in-memory sim (demo mode)
│   ├── achievements.ts, haptics.ts, sound.ts, shareCard.ts, errors.ts, polyfills.ts
│   └── sui/                  # predict.ts (the one Predict wrapper), config.ts (ids from env), enoki.ts
├── hooks/                    # useLocalStorage, useReducedMotion
├── utils/                    # style.ts (cnm), format.ts, motion.ts
├── integrations/             # tanstack-query root provider
├── providers/                # LenisSmoothScrollProvider
└── config.ts, env.ts, router.tsx, styles.css
```

## Key Files

| File | Purpose |
|------|---------|
| `src/routes/_app.tsx` | Pathless layout: mounts the persistent shell (3D `ConsoleCanvas` for Range, CSS `ConsoleShell` otherwise), the menu drawer, and the auth gate |
| `src/components/console/controls.tsx` | `useConsoleControls()` (a screen registers Main / Action 1·2 / Knob / status) + provider. The console binding contract |
| `src/components/console/ConsoleCanvas.tsx` | The 3D WebGL handheld (Three.js): device body + screen-cutout projection (`screenExt`) behind the HTML screen layer |
| `src/components/console/ConsoleShell.tsx` | The CSS/DOM console shell |
| `src/components/game/Chart.tsx` | The live price chart on the screen |
| `src/lib/api.ts` | Typed backend client + SSE streams; the demo-mode seam |
| `src/lib/auth.tsx` | Auth context (dev auto-login + Enoki zkLogin) |
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
- Games: `/games/{lucky,range,tap}`. Menu: `/menu/*` renders as a **drawer over** the device, not a screen inside it.
- Two shells today: **Range** runs on the 3D WebGL handheld (`ConsoleCanvas`), the others on the CSS `ConsoleShell` until their screens are migrated to the L-shaped aperture. One `ConsoleCanvas` stays mounted across range↔menu so the WebGL scene builds once.

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

- **Vercel**: This is a monorepo, so set the project **Root Directory to `web`** in Vercel settings. Framework preset: Vite. Build command: `bun run build`. Output: `.output`.
- **Other platforms**: Run `bun run build` and deploy `.output/` directory.

## Important Notes

- This uses **TanStack Start** (SSR-capable), not plain Vite React
- HeroUI v3 requires no provider wrapper, CSS handled via `@import "@heroui/styles"` in styles.css
- GSAP is the free version (not Shockingly) - all features available
- Lenis smooth scroll is initialized globally in root layout
- Part of a monorepo. Sibling `backend/` is a Bun + Fastify API on :3700. Wire calls via `VITE_API_URL` from `src/env.ts`. Backend CORS is locked to `ALLOWED_ORIGIN` in production.
- Animation lib `motion` is Motion One (rebranded successor to Framer Motion). Existing Framer Motion docs mostly apply.
