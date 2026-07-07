# PIPS

**Makes trading simple, intuitive, and addictive, like a game.**

PIPS is a gamified trading platform on **Sui**, powered by **DeepBook Predict**. It is web based and mobile optimized, a collection of gamified trading games that make trading feel like play instead of work.

The thesis: trading terminals all look and feel the same, and traders are bored. Every terminal is a wall of candles, order books, and numbers that demands a 180 IQ to even start. PIPS is built from the ground up to be the simplest and most fun way to trade. No complexity, no jargon, just plays that are fun, social, and addictive. We want to change how people think about trading by making it feel like a game they want to come back to.

The twist that makes PIPS PIPS: the whole interface looks and behaves like a **physical handheld console**, a tactile 3D device with a screen, knobs, and buttons. Think the "Camera" app from Not Boring Software. The product is the device. See [`docs/DESIGN.md`](./docs/DESIGN.md) for the full design language.

---

## What an agent needs to know first

1. This is a **monorepo** with three pillars: `web/` (frontend), `backend/` (API), `contracts/` (Sui Move). Working in a pillar? Read its own `CLAUDE.md` too.
2. The chain is **our own Sui localnet**, deployed and live at `https://rpc.playpips.fun`. **Not Sui testnet.** We publish and run our own copy of **DeepBook Predict** (an on-chain prediction-market protocol) on it. Setup and redeploy are one command: `scripts/localnet.sh`. Read the "The chain" section below before touching anything Sui.
3. The frontend is **not a normal dashboard**. It is a persistent console shell with a swappable screen. Read [`docs/DESIGN.md`](./docs/DESIGN.md) (how it looks) and [`docs/FLOW.md`](./docs/FLOW.md) (how it moves: the surfaces, the Home screen, the navigation map) before touching UI. The UI has **two distinct visual languages**: the App Surface (the menu drawer, settings, landing, modals) is iOS clean with rounded cards, per DESIGN.md; **everything inside the device screen (Home + all games) is the Teenage Engineering instrument language in [`docs/SCREEN.md`](./docs/SCREEN.md), flat black with electric high-contrast ink, no rounded cards.** Read SCREEN.md before touching any `/games/*` screen.
4. Auth is **Privy (Google/email sign-in + a non-custodial embedded Sui wallet)** plus a **dev auto-login** for local and the build loop. `AUTH_MODE = dev | privy` (Enoki/zkLogin removed). Suiet wallet connect is not in v1. See the "Auth" section below and [`bigdev/plans/LUCKY.md`](./bigdev/plans/LUCKY.md) §6.
5. The Sui SDK surface moves fast. The package names and APIs in this file were verified mid 2026. When you write integration code, confirm the current API before coding, never guess from memory.

---

## Monorepo structure

```
pips/
├── web/                TanStack Start + React 19 frontend (the console UI)   :3200
├── backend/            Bun + Fastify API (auth, indexing, game state)        :3780
├── contracts/          Sui Move packages (game logic, Predict wrappers)
├── docs/
│   ├── DESIGN.md       App Surface design language + the physical device (read this)
│   ├── SCREEN.md       In-device screen language (Home + games): Teenage Engineering instrument style
│   ├── FLOW.md         App flow + navigation map (door, device, drawer)
│   └── references/     Visual references (Not Boring Camera, console layout)
├── scripts/
│   └── localnet.sh     Localnet + Predict deploy front door (setup/redeploy/doctor)
├── .claude/
│   └── progress.md     Living roadmap + build progress + quick reference
├── CLAUDE.md           This file (master context)
└── README.md           Public facing readme
```

Working in a pillar:
- `web/` → read [`web/CLAUDE.md`](./web/CLAUDE.md)
- `backend/` → read [`backend/CLAUDE.md`](./backend/CLAUDE.md)
- `contracts/` → read [`contracts/README.md`](./contracts/README.md)

---

## Tech stack

**Frontend (`web/`)** TanStack Start (React 19, SSR capable), TanStack Router (file based) + Query, Vite, Tailwind CSS 4, HeroUI v3, GSAP, Lenis, Motion. Package manager **bun**, runs on the **Bun** runtime.

**Backend (`backend/`)** Bun + Fastify 5, Prisma 7 (PostgreSQL, pg adapter), JWT auth, node-cron workers. Centralized config and error handling. Runs on the **Bun** runtime.

**Contracts (`contracts/`)** Sui Move. Game logic, leaderboards/scoring, and thin wrappers/PTB helpers that compose with DeepBook Predict.

---

## Sui integration stack (verified mid 2026, reconfirm before coding)

These are the packages and patterns we standardize on. The Mysten SDK had a 2.0 release that renamed and split several packages, so do not trust older tutorials.

| Concern | Use | Notes |
|---|---|---|
| Core TS SDK | `@mysten/sui` (v2.x) | Formerly `@mysten/sui.js` (deprecated). ESM only. |
| Transactions / PTBs | `Transaction` from `@mysten/sui/transactions` | Renamed from `TransactionBlock`. This is the PTB builder. |
| RPC client | `SuiGrpcClient` (`@mysten/sui/grpc`) is the client | JSON-RPC is removed. All fullnode reads/writes go through gRPC. Historical queries (events, tx-history) go through `SuiGraphQLClient` (`@mysten/sui/graphql`). Never re-add `@mysten/sui/jsonRpc`. |
| Wallet connect (phase 1) | `@suiet/wallet-kit` | `<WalletProvider>` + `<ConnectButton/>` + `useWallet`. Maintained, rides the Sui Wallet Standard. |
| Official dApp kit | `@mysten/dapp-kit-react` + `@mysten/dapp-kit-core` | The single `@mysten/dapp-kit` is now legacy. The split packages are the current standard (gRPC based). Both kits share the same Wallet Standard, so wallets are interchangeable. |
| Auth (login + wallet) | **Privy**: `@privy-io/react-auth` (client, + `/extended-chains`) and `@privy-io/node` (server) | Google/email login + a non-custodial embedded **ed25519 (Sui)** wallet (Tier 2). Server signs plays with Privy `rawSign` (`blake2b256`) under a session signer. Confirm the API live, the SDK moves fast. |
| Trading mechanic | Hand-built Predict PTBs via `@mysten/sui` | The `@mysten/deepbook-v3` SDK has no Predict support. See DeepBook Predict section below. |
| Sui signature assembly | `toSerializedSignature` + `Ed25519PublicKey` (`@mysten/sui`) | The raw ed25519 sig from Privy is wrapped into the Sui serialized format. The signing digest is `blake2b256(messageWithIntent('TransactionData', txBytes))`. |

**Runtime versions:** target Bun/Node >= 22 (the SDK 2.0 tooling requires it).

**Known Bun gotcha:** the Sui crypto stack pulls in WASM. `vite-plugin-wasm` has been reported to fail when the **Vite dev server runs through Bun** (`wasm is not a function`). Keep using bun as the package manager. If WASM fails to load in the frontend dev server, fall back to running the Vite dev server on Node, or wire up `vite-plugin-wasm` + `vite-plugin-top-level-await` carefully. Test this early.

---

## DeepBook Predict (the core mechanic)

DeepBook Predict is a real, official Sui primitive: an **expiry based on-chain prediction-market protocol**, the third composable layer of DeepBook v3 (alongside Spot, the CLOB, and Margin). Users mint and redeem binary or range positions against oracle driven prices. Liquidity providers supply quote assets into a shared vault and receive PLP vault-share tokens.

This is what every PIPS game settles against. The fun, game-like front layer translates into Predict positions underneath.

**Critical constraints:**
- **We run our own deployment on our own localnet.** Mysten's Predict is testnet only as of mid 2026 (launched ~May 2026), but we never depend on it. We publish our **own** copy of `packages/predict` (plus DUSDC, token, deepbook) onto our localnet (live at `rpc.playpips.fun`), seed the vault with free DUSDC, and run the oracles ourselves. Gas is effectively infinite there, which is why we moved off the gas-starved testnet. Mainnet is a clean re-point later.
- **Package IDs and object layouts are per-deployment and change every redeploy.** **Never hardcode them.** Read them from config (the bootstrap writes them to `deployed.localnet.json` + the `.env`s), behind one abstraction layer.
- The published `@mysten/deepbook-v3` SDK has **no Predict support** (verified against source). We hand-build raw PTBs against the predict modules with `@mysten/sui`, and for fast short-expiry games we **publish our own copy of `packages/predict`** to our localnet and operate our own markets, vault, and oracles (seeded with free DUSDC). Full verified recipe in [`bigdev/plans/05-SUI-PREDICT.md`](./bigdev/plans/05-SUI-PREDICT.md). Everything stays behind the one wrapper.

**Capability box (design games INSIDE this, never outside it).** Verified against `contracts/predict/sources/predict.move`. The entire on-chain vocabulary is two **European, expiry-settled** instruments:
1. **Binary up/down** at a grid-aligned strike. Pays `$1·qty` if the settlement price at expiry is on the chosen side, else 0.
2. **Vertical range** `(lower, higher]`. Pays `$1·qty` if the settlement price at expiry lands in the band, else 0.

Both support **hold + early cash-out**: pre-expiry `redeem` pays the live bid (mark-to-market), post-expiry `redeem` pays `$1·qty` or 0. You mint at `ask = fair + spread` and cash out at `bid = fair − spread` (round-trip costs the spread); a settled win is spread-free. Multipliers are market-priced (`1/ask`) and clamped by on-chain ask bounds, not fixed buckets. "Leverage" here just means how far OTM the strike sits.

**Predict CANNOT do (do not design a game around these):** no touch/no-touch/barrier (settlement reads only the price AT expiry, never the path), no path-dependent or time-climbing payoff (no native crash/Aviator curve), no leverage/margin inside Predict (positions are fully prepaid, max loss = premium; leverage is the separate margin loop), no fixed-odds book (it is a vault-priced AMM with a spread). If a mechanic needs any of these it cannot ship on real Predict. The ONLY sanctioned sim is demo mode. Full source-cited box in [`bigdev/plans/05-SUI-PREDICT.md`](./bigdev/plans/05-SUI-PREDICT.md).

**Architecture rule:** all Predict interaction goes through one wrapper module (`web/src/lib/sui/predict.*` on the client, `backend/src/lib/sui/*` on the server). Games call that wrapper. When mainnet lands or IDs change, we touch one place.

---

## The chain: our own Sui localnet

PIPS does **not** run on Sui testnet. It runs on **our own Sui localnet**, deployed and live at `https://rpc.playpips.fun` (Cloudflare in front, valid cert, chain `325c13db`). The whole Predict stack (our copy of `predict` + DUSDC + token + deepbook) is published there, the vault is seeded with free DUSDC, and we run the oracles. This is the chain every play settles against now.

**One command drives it: `scripts/localnet.sh`.**
- `setup` — one shot: import the operator key into the sui CLI, publish the Predict stack, wire both `.env`s. Run once.
- `redeploy` — **after any `contracts/` (Move) change**: republish all packages, reseed, rewire the ids. This is the loop for Move work.
- `doctor` / `status` — diagnose what is live (node, cert, gRPC deploy path, Predict package, operator funding).
- `apply-ids <file>` — wire ids from a deploy done on another machine.
- `up` — start a throwaway local node + faucet (the fully-local flow, instead of the deployed box).

**Editing a game, the UI, or the backend needs NO redeploy.** The games just compose the two on-chain Predict instruments, so a plain `bun dev` restart is enough. Only `contracts/` (Move) changes need `redeploy`.

**The deploy gotcha (already solved, do not relearn):** the sui CLI 1.71 publishes over **gRPC**, and Cloudflare 403s gRPC while passing JSON-RPC. So the apps (JSON-RPC) run fine through `rpc.playpips.fun`, but the CLI cannot publish there. The fix: publish through the node's **origin** (`http://95.111.237.44:9000`, where gRPC is unblocked), run through the proxied url. The origin is recorded as `PIPS_DEPLOY_RPC` in `backend/.env`; `scripts/localnet.sh` uses it automatically and resets the apps back to the proxied url after each deploy.

**IDs are never hardcoded.** The bootstrap writes them to `backend/src/lib/sui/deployed.localnet.json` (gitignored) and the headline ids into both `.env`s. Read from config, always. Current deployment (chain `325c13db`): Predict package `0xded84f0b…43a3`, vault `0xf31457a2…ad69`.

**`/tools/wallet`** is a standalone browser wallet for this private node (no extension speaks to it): editable RPC, import/generate/watch a key, all coin balances, send any coin, faucet. No auth/backend/Predict wrapper.

Runtime node resolves as `PIPS_LOCALNET_RPC` > `backend/.env` `SUI_FULLNODE_URL` > `127.0.0.1:9000`. Deploy node resolves as `PIPS_DEPLOY_RPC` > auto-origin > runtime.

---

## Auth

Two modes behind one JWT plumbing, selected by `AUTH_MODE` = `dev | privy` (Enoki/zkLogin is removed). Source of truth for the swap is [`bigdev/plans/LUCKY.md`](./bigdev/plans/LUCKY.md) §6; the JWT plumbing, `authMiddleware`, and onboarding in [`bigdev/plans/04-AUTH.md`](./bigdev/plans/04-AUTH.md) still stand.

- **`privy` (product + demo):** Google/email sign-in via **Privy**, which mints a non-custodial embedded **ed25519 (Sui)** wallet, so users get a real Sui address with no seed phrase. The client (`web/src/lib/privy.tsx`) creates the wallet, grants a **session signer** to the app, and posts the Privy access token + Sui address/public key/walletId to `POST /auth/privy/verify`. The backend verifies the token (`@privy-io/node` `verifyAccessToken`), upserts the user keyed by the Sui address, runs onboarding, mints our JWT. Plays are **server-signed**: `executeForUser` signs the tx intent digest with the user's wallet via Privy `rawSign` (`hash_function: 'blake2b256'`) under the session signer, so there is no per-spin popup and no client sponsor envelope.
- **`dev` (local + build loop):** auto-login the testing wallet (`TESTING_WALLET_PK`); the backend signs txs directly as the operator. No OAuth, real Predict on our localnet.

Demo mode (`VITE_DEMO_MODE`) stays the one sanctioned no-backend sim. Suiet wallet connect is not in v1 (`@suiet/wallet-kit` stays available but unused).

---

## Cross cutting rules

- **Never run destructive Prisma commands.** No `migrate reset`, no `--force-reset`. If the schema changed, ask the user to run `bun run db:push` from `backend/` themselves.
- **Package manager is `bun`** for every pillar. Do not introduce npm, yarn, or pnpm. Lockfiles (`bun.lock`, `bun.lockb`) are committed.
- Both JS apps run on the **Bun runtime**. Verify Bun compatibility before suggesting Node specific APIs.
- **Ports:** backend `:3780`, web `:3200`.
- Frontend talks to backend via `VITE_API_URL` (validated in `web/src/env.ts`). Backend CORS is locked to `ALLOWED_ORIGIN` in production.
- **Sui IDs and package addresses live in config, never inline.** This applies to DeepBook Predict, our own published Move packages, and any pool/object IDs.
- **Sui only:** PIPS is Sui only. The EVM (`ethers`) and Solana (`@solana/web3.js`, `bs58`) starter deps have been removed from the backend. If any `ethers` / `@solana/*` reference survives, it is dead, do not build on it.

---

## Style

- Write like a senior engineer: dead simple, no overengineering, no early abstraction, no bloat. Minimize file count.
- Comments are concise and direct, only where they earn their place.
- No em-dashes in prose, code comments, or copy. Use commas or periods.
- Reads like the surrounding code: match existing naming and idioms.

---

## v1 build (BigDev)

The full v1 build (auth, the games, menu, backend, indexer, the Predict integration) is planned under [`bigdev/`](./bigdev/) and built by an autonomous loop (`./bigdev/autobuild`). Durable steering lives in [`bigdev/claude/requirements-log.md`](./bigdev/claude/requirements-log.md) (committed, read every iteration); one-shot corrections go to `bigdev/claude/inject.md` (gitignored). Use `./bigdev/autobuild say "rule"` for durable, `./bigdev/autobuild fix "msg"` for transient.

**The spine (decided):** PIPS runs its **own** DeepBook Predict deployment on its **own Sui localnet** (live at `rpc.playpips.fun`, no longer testnet: we publish `packages/predict` ourselves, seed the vault with free DUSDC, run short-expiry oracles via a backend price-pusher). Every play is a real `mint`/`redeem`. No sim. Plays are server-signed (privy mode = the user's embedded wallet via Privy `rawSign` under a session signer; dev mode = the operator key), gas is free localnet SUI. Fast paced is the priority. The why and how: `bigdev/plans/01-ARCHITECTURE.md` and `05-SUI-PREDICT.md`; the deploy mechanics live in "The chain" above.

**Plans (source of truth, read the relevant one before each phase):**

| File | Covers |
|---|---|
| `bigdev/plans/01-ARCHITECTURE.md` | System overview, the settlement spine, modes, data flow, risks |
| `bigdev/plans/02-API.md` | Backend routes, DTOs, SSE streams, error codes |
| `bigdev/plans/03-DATABASE.md` | Prisma schema, queries, seed |
| `bigdev/plans/04-AUTH.md` | JWT plumbing, `authMiddleware`, onboarding (the Enoki design is superseded by LUCKY.md §6, Privy) |
| `bigdev/plans/05-SUI-PREDICT.md` | The verified Predict recipe, wrappers, operator workers, gotchas |
| `bigdev/plans/06-GAMES.md` | The games, console bindings, the 60fps chart |
| `bigdev/plans/07-DESIGN-SYSTEM.md` | Screen states + verbatim copy (defers to `docs/DESIGN.md`) |
| `bigdev/plans/08-DEMO-FLOW.md` | The 2-min arc, seed data, achievements, fallbacks |
| `bigdev/plans/09-DEPLOYMENT.md` | Local run, the Predict bootstrap, deploy, mainnet re-point |
| `bigdev/plans/10-LEVERAGE.md` | Real margin-loop leverage: verified testnet ids, the atomic PTB, LTV/liquidation/repay, the open product decision (Phase L) |
| `bigdev/plans/LUCKY.md` | **Active build, the current `bigdev/TODO.md`.** LUCKY game rebuild: slot-weighted reel, tier→strike solver, Enoki→Privy auth swap, USDC chips + free SUI gas |

`docs/DESIGN.md` remains the canonical visual system. Demo-grade quality bar: `bigdev/plans/07-DESIGN-SYSTEM.md` + `bigdev/plans/08-DEMO-FLOW.md`.

**Build + run commands:**

```bash
cd web && bunx tsc --noEmit        # fast typecheck gate (the loop's baseline check)
cd backend && bun run typecheck    # backend typecheck gate
cd backend && bun dev              # API on :3780
cd web && bun dev                  # console on :3200
cd backend && bun run db:push      # USER runs this after schema changes (never the loop)
scripts/localnet.sh setup          # deploy our Predict stack + wire both .envs (run once)
scripts/localnet.sh redeploy       # re-publish after any contracts/ (Move) change
scripts/localnet.sh doctor         # diagnose the localnet (node, cert, gRPC, ids, funding)
```

## Working on something big?

Track it in [`.claude/progress.md`](./.claude/progress.md). That file holds the live roadmap, the build phases, and the quick reference values (network, package IDs once known, env keys) so context is not lost between sessions.

## Review mode

/bigdev-review setup. Run `./bigdev/autoreview` to start the autonomous review loop (games-first: chart + the games are the priority, web3 is test-if-reachable, security runs last).
- `./bigdev/autoreview` full pass with state.json skip-on-pass
- `./bigdev/autoreview --diff` re-audit only items whose deps changed
- `./bigdev/autoreview --phase 2` run a single phase (2 = games)
- `BUDGET=15 ./bigdev/autoreview` stop at cumulative cost
- `./bigdev/autoreview say "rule"` durable steering, `fix "msg"` one-shot
- `./bigdev/autoreview status | kill | logs | watch`

Spec in `bigdev/plans/review/`. Tasks in `bigdev/REVIEW-TODO.md`. State in `bigdev/claude/review-state.json`. The loop drives the UI in demo mode (`VITE_DEMO_MODE=true`), no backend or wallet needed.

## Learnings (do not repeat)

Durable rules distilled from the user's corrections and hard-won gotchas. Every session (any bigdev loop or a plain chat) reads these first and must not repeat the mistakes below. Terse imperative bullets, each citing its lesson id in `bigdev/claude/lessons.md`.

- Sui fullnode reads/writes go through `SuiGrpcClient` (`@mysten/sui/grpc`). Never import `@mysten/sui/jsonRpc`, `SuiJsonRpcClient`, or `getJsonRpcFullnodeUrl`, and never re-add them as a fallback. Construct with an explicit `baseUrl` (fullnode url from config); `new SuiGrpcClient({network})` alone throws `base.endsWith`. (L-001)
- Historical queries (events, tx-history) go through `SuiGraphQLClient` (`@mysten/sui/graphql`), not gRPC. Fullnode gRPC v2 has no `queryEvents` / `queryTransactionBlocks`; any scan-by-filter is GraphQL. (L-002)
- gRPC `getObject({objectId, include:{json:true}})` INLINES nested Move structs (no `.fields` wrapper): read `f.prices.spot`, `f.authorized_caps.contents`, NOT `.fields.*`. It THROWS "<id> not found" on a missing object (JSON-RPC returned empty data), so any "gone -> null" read must catch not-found. Dynamic-field values return as BCS from `getDynamicField`; to read json, getObject the returned `dynamicField.fieldId`. devInspect -> `simulateTransaction({transaction, include:{commandResults:true[,events:true]}, checksEnabled:false})` with the sender set; return values are `commandResults[i].returnValues[j].bcs`, events are `Transaction.events[].{eventType,json}`. (L-003)
- Sui GraphQL URL needs the `/graphql` suffix (`https://graphql.devnet.sui.io/graphql`). Live schema: `events(filter:{type})` and `transactions(filter:{affectedObject})` (NOT `transactionBlocks`/`eventType`/`inputObject`). Newest-first = `last:N` + `before:startCursor`, but nodes come back oldest-first within a page, so iterate reversed. Read payloads from `nodes[].contents.json` + `nodes[].contents.type.repr`; tx events under `nodes[].effects.events.nodes[]`. Pass the query as a plain string and annotate the result `{ data?: unknown }` to dodge `TS7022`. (L-004)

## Continuation mode

/bigdev-cont setup. Run `./bigdev/autocont` to build the current wave autonomously.
- `./bigdev/autocont` start (or attach to) the loop; `status | kill | logs | watch`
- `./bigdev/autocont say "rule"` durable steering; `fix "msg"` one-shot
- `./bigdev/autocont learn "never do X"` log a lesson; it lands in bigdev/claude/lessons.md and gets promoted into ## Learnings
- `./bigdev/autocont lessons` view the ledger; `log` view durable rules
- `MAX=20 ./bigdev/autocont` cap iterations; `VALIDATE=1 ./bigdev/autocont` pre-flight

Current wave: `bigdev/CONT-TODO.md`. Wave specs + archive: `bigdev/plans/cont/`. Lessons: `bigdev/claude/lessons.md`.
