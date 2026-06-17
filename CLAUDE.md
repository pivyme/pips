# Pips

**Makes trading simple, intuitive, and addictive, like a game.**

Pips is a gamified trading platform on **Sui**, powered by **DeepBook Predict**. It is web based and mobile optimized, a collection of gamified trading games that make trading feel like play instead of work.

The thesis: trading terminals all look and feel the same, and traders are bored. Every terminal is a wall of candles, order books, and numbers that demands a 180 IQ to even start. Pips is built from the ground up to be the simplest and most fun way to trade. No complexity, no jargon, just plays that are fun, social, and addictive. We want to change how people think about trading by making it feel like a game they want to come back to.

The twist that makes Pips Pips: the whole interface looks and behaves like a **physical handheld console**, a tactile 3D device with a screen, knobs, and buttons. Think the "Camera" app from Not Boring Software. The product is the device. See [`docs/DESIGN.md`](./docs/DESIGN.md) for the full design language.

---

## What an agent needs to know first

1. This is a **monorepo** with three pillars: `web/` (frontend), `backend/` (API), `contracts/` (Sui Move). Working in a pillar? Read its own `CLAUDE.md` too.
2. The chain is **Sui**. The trading mechanic is **DeepBook Predict** (an on-chain prediction-market protocol, currently testnet only, see below).
3. The frontend is **not a normal dashboard**. It is a persistent console shell with a swappable screen. Read [`docs/DESIGN.md`](./docs/DESIGN.md) before touching UI.
4. Auth is **Sui zkLogin via Enoki (Google sign-in)** plus a **dev auto-login** for local and the build loop. Suiet wallet connect is not in v1. See [`bigdev/plans/04-AUTH.md`](./bigdev/plans/04-AUTH.md).
5. The Sui SDK surface moves fast. The package names and APIs in this file were verified mid 2026. When you write integration code, confirm the current API before coding, never guess from memory.

---

## Monorepo structure

```
pips/
├── web/                TanStack Start + React 19 frontend (the console UI)   :3200
├── backend/            Bun + Fastify API (auth, indexing, game state)        :3700
├── contracts/          Sui Move packages (game logic, Predict wrappers)
├── docs/
│   ├── DESIGN.md       Console design language + layout spec (read this)
│   └── references/     Visual references (Not Boring Camera, console layout)
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
| RPC client | `SuiGrpcClient` (`@mysten/sui/grpc`) preferred | `SuiClient` (JSON-RPC) still works but is legacy. `SuiGraphQLClient` for complex queries. |
| Wallet connect (phase 1) | `@suiet/wallet-kit` | `<WalletProvider>` + `<ConnectButton/>` + `useWallet`. Maintained, rides the Sui Wallet Standard. |
| Official dApp kit | `@mysten/dapp-kit-react` + `@mysten/dapp-kit-core` | The single `@mysten/dapp-kit` is now legacy. The split packages are the current standard (gRPC based). Both kits share the same Wallet Standard, so wallets are interchangeable. |
| zkLogin (phase 2) | **Enoki**: `@mysten/enoki` (+ `@mysten/enoki/react`) | Managed zkLogin. `registerEnokiWallets({ apiKey, providers: ['google'] })` surfaces Google login as a connectable wallet. Non custodial, ephemeral key stays in the browser. Avoid hand rolling a prover. |
| Trading mechanic | DeepBook Predict via `@mysten/deepbook-v3` | See DeepBook Predict section below. |
| Backend signature verify | `verifyPersonalMessageSignature` from `@mysten/sui/verify` | Pass `{ address }` so it throws on mismatch. For zkLogin sigs on testnet, pass a testnet `SuiGraphQLClient`. |

**Runtime versions:** target Bun/Node >= 22 (the SDK 2.0 tooling requires it).

**Known Bun gotcha:** the Sui crypto stack pulls in WASM. `vite-plugin-wasm` has been reported to fail when the **Vite dev server runs through Bun** (`wasm is not a function`). Keep using bun as the package manager. If WASM fails to load in the frontend dev server, fall back to running the Vite dev server on Node, or wire up `vite-plugin-wasm` + `vite-plugin-top-level-await` carefully. Test this early.

---

## DeepBook Predict (the core mechanic)

DeepBook Predict is a real, official Sui primitive: an **expiry based on-chain prediction-market protocol**, the third composable layer of DeepBook v3 (alongside Spot, the CLOB, and Margin). Users mint and redeem binary or range positions against oracle driven prices. Liquidity providers supply quote assets into a shared vault and receive PLP vault-share tokens.

This is what every Pips game settles against. The fun, game-like front layer translates into Predict positions underneath.

**Critical constraints:**
- **Testnet only** as of mid 2026 (launched ~May 2026). Mainnet is expected later. Build for testnet now, plan a clean mainnet re-point.
- **Package IDs and object layouts are explicitly unstable** and will change before mainnet. **Never hardcode them.** Read them from config or from the SDK's constants, behind one abstraction layer.
- The published `@mysten/deepbook-v3` SDK has **no Predict support** (verified against source). We hand-build raw PTBs against the predict modules with `@mysten/sui`, and for fast short-expiry games we **publish our own copy of `packages/predict`** to testnet and operate our own markets, vault, and oracles (seeded with free DUSDC). Full verified recipe in [`bigdev/plans/05-SUI-PREDICT.md`](./bigdev/plans/05-SUI-PREDICT.md). Everything stays behind the one wrapper.

**Architecture rule:** all Predict interaction goes through one wrapper module (`web/src/lib/sui/predict.*` on the client, `backend/src/lib/sui/*` on the server). Games call that wrapper. When mainnet lands or IDs change, we touch one place.

---

## Auth (v1)

Two modes behind one JWT plumbing, selected by `AUTH_MODE`. Full spec in [`bigdev/plans/04-AUTH.md`](./bigdev/plans/04-AUTH.md).

- **`enoki` (product + demo):** Google sign-in via **Sui zkLogin (Enoki)**, so users get a real Sui address with no wallet or seed phrase. The client signs its own plays; the backend sponsors gas (Enoki server key) so plays are gasless. To auth our backend: nonce, client signs a personal message, server verifies (`verifyPersonalMessageSignature({ address })`, and zkLogin sigs on testnet need a testnet `SuiGraphQLClient`), mints the JWT.
- **`dev` (local + build loop):** auto-login the testing wallet (`TESTING_WALLET_PK`); the backend signs txs directly. No OAuth, real Predict on testnet.

Suiet wallet connect is not in v1 (`@suiet/wallet-kit` stays available but unused).

---

## Cross cutting rules

- **Never run destructive Prisma commands.** No `migrate reset`, no `--force-reset`. If the schema changed, ask the user to run `bun run db:push` from `backend/` themselves.
- **Package manager is `bun`** for every pillar. Do not introduce npm, yarn, or pnpm. Lockfiles (`bun.lock`, `bun.lockb`) are committed.
- Both JS apps run on the **Bun runtime**. Verify Bun compatibility before suggesting Node specific APIs.
- **Ports:** backend `:3700`, web `:3200`.
- Frontend talks to backend via `VITE_API_URL` (validated in `web/src/env.ts`). Backend CORS is locked to `ALLOWED_ORIGIN` in production.
- **Sui IDs and package addresses live in config, never inline.** This applies to DeepBook Predict, our own published Move packages, and any pool/object IDs.
- **Legacy starter cleanup:** the backend was forked from a generic starter and still carries EVM (`ethers`) and Solana (`@solana/web3.js`, `bs58`) dependencies. Pips is Sui only. These are slated for removal as the Sui stack lands. Do not build new features on them.

---

## Style

- Write like a senior engineer: dead simple, no overengineering, no early abstraction, no bloat. Minimize file count.
- Comments are concise and direct, only where they earn their place.
- No em-dashes in prose, code comments, or copy. Use commas or periods.
- Reads like the surrounding code: match existing naming and idioms.

---

## v1 build (BigDev)

The full v1 build (auth, the three games, menu, backend, indexer, the Predict integration) is planned under [`bigdev/`](./bigdev/) and built by an autonomous loop (`./bigdev/autobuild`). Durable steering lives in [`bigdev/claude/requirements-log.md`](./bigdev/claude/requirements-log.md) (committed, read every iteration); one-shot corrections go to `bigdev/claude/inject.md` (gitignored). Use `./bigdev/autobuild say "rule"` for durable, `./bigdev/autobuild fix "msg"` for transient.

**The spine (decided):** Pips runs its **own** DeepBook Predict deployment on testnet (we publish `packages/predict` ourselves, seed the vault with free DUSDC, run short-expiry oracles via a backend price-pusher). Every play is a real `mint`/`redeem`. No sim. Gasless via Enoki, dev mode backend-signs. Fast paced is the priority. The why and how: `bigdev/plans/01-ARCHITECTURE.md` and `05-SUI-PREDICT.md`.

**Plans (source of truth, read the relevant one before each phase):**

| File | Covers |
|---|---|
| `bigdev/plans/01-ARCHITECTURE.md` | System overview, the settlement spine, modes, data flow, risks |
| `bigdev/plans/02-API.md` | Backend routes, DTOs, SSE streams, error codes |
| `bigdev/plans/03-DATABASE.md` | Prisma schema, queries, seed |
| `bigdev/plans/04-AUTH.md` | dev + Enoki zkLogin, JWT, sponsorship, onboarding |
| `bigdev/plans/05-SUI-PREDICT.md` | The verified Predict recipe, wrappers, operator workers, gotchas |
| `bigdev/plans/06-GAMES.md` | The three games, console bindings, the 60fps chart |
| `bigdev/plans/07-DESIGN-SYSTEM.md` | Screen states + verbatim copy (defers to `docs/DESIGN.md`) |
| `bigdev/plans/08-DEMO-FLOW.md` | The 2-min arc, seed data, achievements, fallbacks |
| `bigdev/plans/09-DEPLOYMENT.md` | Local run, the Predict bootstrap, deploy, mainnet re-point |
| `bigdev/plans/10-LEVERAGE.md` | Real margin-loop leverage: verified testnet ids, the atomic PTB, LTV/liquidation/repay, the open product decision (Phase L) |

`docs/DESIGN.md` remains the canonical visual system. Demo-grade quality bar: `bigdev/plans/07-DESIGN-SYSTEM.md` + `bigdev/plans/08-DEMO-FLOW.md`.

**Build + run commands:**

```bash
cd web && bunx tsc --noEmit        # fast typecheck gate (the loop's baseline check)
cd backend && bun run typecheck    # backend typecheck gate
cd backend && bun dev              # API on :3700
cd web && bun dev                  # console on :3200
cd backend && bun run db:push      # USER runs this after schema changes (never the loop)
```

## Working on something big?

Track it in [`.claude/progress.md`](./.claude/progress.md). That file holds the live roadmap, the build phases, and the quick reference values (network, package IDs once known, env keys) so context is not lost between sessions.
