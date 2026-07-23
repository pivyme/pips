# PIPS

**Makes trading simple, intuitive, and addictive, like a game.**

PIPS is a gamified trading platform on **Sui**, powered by **DeepBook Predict**. It is web based and mobile optimized, a collection of gamified trading games that make trading feel like play instead of work.

The thesis: trading terminals all look and feel the same, and traders are bored. Every terminal is a wall of candles, order books, and numbers that demands a 180 IQ to even start. PIPS is built from the ground up to be the simplest and most fun way to trade. No complexity, no jargon, just plays that are fun, social, and addictive. We want to change how people think about trading by making it feel like a game they want to come back to.

The twist that makes PIPS PIPS: the whole interface looks and behaves like a **physical handheld console**, a tactile 3D device with a screen, knobs, and buttons. Think the "Camera" app from Not Boring Software. The product is the device. See [`docs/DESIGN.md`](./docs/DESIGN.md) for the full design language.

---

## What an agent needs to know first

1. This is a **monorepo** with three pillars: `web/` (frontend), `backend/` (API), `contracts/` (Sui Move). Working in a pillar? Read its own `CLAUDE.md` too.
2. The chain is **Mysten's official DeepBook Predict**, on `testnet` (default) or `mainnet`, selected by `SUI_NETWORK`. There is no fork mode: PIPS never publishes or operates its own Predict. The one real path lives in `backend/src/lib/sui/predict-real.ts` + `config-real.ts`, discovery via direct chain reads, ids from config never hardcoded. The vendored Predict copy under `contracts/` and the `scripts/localnet.sh` deploy front door remain on disk for reference only, not part of the run or deploy path. Read "The chain" and "DeepBook Predict" below, plus `bigdev/plans/cont/01-PREDICT-TESTNET.md`, before touching anything Sui.
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
├── scripts/            Vendored-fork deploy scripts (localnet.sh etc), reference-only, not the run path
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

**Frontend (`web/`)** TanStack Start (React 19, SSR capable), TanStack Router (file based) + Query, Vite, Tailwind CSS 4, HeroUI v3, GSAP, Motion. Package manager **bun**, runs on the **Bun** runtime.

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
- **One real path (Mysten's official DeepBook Predict).** PIPS trades `testnet` (default) or `mainnet`, a protocol we do not operate: no fork publish, discovery via direct chain reads, DUSDC not mintable (manual treasury funding), finite testnet SUI behind a sponsor safety layer, and real continuous leverage. The path lives in `predict-real.ts` + `config-real.ts`; full spec in `bigdev/plans/cont/01-PREDICT-TESTNET.md`. Mainnet is a clean re-point of the same code.
- **Package IDs and object layouts come from the live deployment.** **Never hardcode them.** Read them from config (`config-real.ts` + the committed `deployed-real.testnet.json`, ids re-fetched from chain), behind one abstraction layer.
- The published `@mysten/deepbook-v3` SDK has **no Predict support** (verified against source). We hand-build raw PTBs against the predict modules with `@mysten/sui`, against Mysten's markets, vault, and oracles. Full verified recipe in [`bigdev/plans/05-SUI-PREDICT.md`](./bigdev/plans/05-SUI-PREDICT.md). Everything stays behind the one wrapper.

**Capability box (design games INSIDE this, never outside it).** Verified against `contracts/predict/sources/predict.move`. The entire on-chain vocabulary is two **European, expiry-settled** instruments:
1. **Binary up/down** at a grid-aligned strike. Pays `$1·qty` if the settlement price at expiry is on the chosen side, else 0.
2. **Vertical range** `(lower, higher]`. Pays `$1·qty` if the settlement price at expiry lands in the band, else 0.

Both support **hold + early cash-out**: pre-expiry `redeem` pays the live bid (mark-to-market), post-expiry `redeem` pays `$1·qty` or 0. You mint at `ask = fair + spread` and cash out at `bid = fair − spread` (round-trip costs the spread); a settled win is spread-free. Multipliers are market-priced (`1/ask`) and clamped by on-chain ask bounds, not fixed buckets. Real Predict has a true `leverage: u64` param on top of the strike distance (multiplier `M ≈ L / entry_probability`), so a play's multiple = strike distance × leverage.

**Predict CANNOT do (do not design a game around these):** no touch/no-touch/barrier (settlement reads only the price AT expiry, never the path), no path-dependent or time-climbing payoff (no native crash/Aviator curve), no fixed-odds book (it is a vault-priced AMM with a spread). **Leverage:** real continuous `leverage: u64` bounded by `max_admission_leverage` (3.0× on BTC) and probability-gated per strike, so a position is knocked out for 0 if liquidated mid-round (L-009/L-011/L-012); the margin-loop details are in `bigdev/plans/10-LEVERAGE.md`. If a mechanic needs any of the first three it cannot ship on Predict at all. The ONLY sanctioned sim is demo mode. Full source-cited box in [`bigdev/plans/05-SUI-PREDICT.md`](./bigdev/plans/05-SUI-PREDICT.md).

**Architecture rule:** all Predict interaction goes through one wrapper module (`web/src/lib/sui/predict.*` on the client, `backend/src/lib/sui/*` on the server). Games call that wrapper. When mainnet lands or IDs change, we touch one place.

---

## The chain: Mysten's real Predict (testnet/mainnet)

Every play settles against **Mysten's official DeepBook Predict**, selected by `SUI_NETWORK` (`testnet` default, `mainnet` a clean re-point). PIPS never publishes or operates its own Predict: no vault to seed, no oracles to run, no deploy step in the run path. Discovery is direct on-chain reads (`predict-real.ts` + `config-real.ts`); ids come from the committed `deployed-real.testnet.json` (re-fetched from chain), never hardcoded.

**What the backend does per play:** derive/create the user's `AccountWrapper`, deposit the shortfall, mint through the real protocol, and read the minted order id + multiplier off the `OrderMinted` event. Settlement is permissionless `redeem_settled` (Mysten/Pyth settle the market at expiry). There is **no operator, price-pusher, or oracle ladder**. The market set is discovered by `market-sync` (the live 1m BTC markets from chain), gas is paid by a sponsor wallet (finite testnet SUI, behind the `play-safety` reserve floor), and chips come from a hand-funded treasury (DUSDC is not mintable on a deployment we don't own, so top it up manually; the boot log prints the addresses).

**Editing a game, the UI, or the backend needs no deploy step.** The games just compose the two on-chain Predict instruments, so a plain `bun dev` restart is enough.

**Kept for reference only (not wired):** the vendored Predict fork under `contracts/` (our copy of `predict` + DUSDC + token + deepbook) and the repo-root `scripts/` deploy front door (`localnet.sh`, `devnet-refresh.sh`) stay on disk as history. They are no longer published, run, or part of any deploy path.

---

## Auth

Two modes behind one JWT plumbing, selected by `AUTH_MODE` = `dev | privy` (Enoki/zkLogin is removed). Source of truth for the swap is [`bigdev/plans/LUCKY.md`](./bigdev/plans/LUCKY.md) §6; the JWT plumbing, `authMiddleware`, and onboarding in [`bigdev/plans/04-AUTH.md`](./bigdev/plans/04-AUTH.md) still stand.

- **`privy` (product + demo):** Google/email sign-in via **Privy**, which mints a non-custodial embedded **ed25519 (Sui)** wallet, so users get a real Sui address with no seed phrase. The client (`web/src/lib/privy.tsx`) creates the wallet, grants a **session signer** to the app, and posts the Privy access token + Sui address/public key/walletId to `POST /auth/privy/verify`. The backend verifies the token (`@privy-io/node` `verifyAccessToken`), upserts the user keyed by the Sui address, runs onboarding, mints our JWT. Plays are **server-signed**: `executeForUser` signs the tx intent digest with the user's wallet via Privy `rawSign` (`hash_function: 'blake2b256'`) under the session signer, so there is no per-spin popup and no client sponsor envelope.
- **`dev` (local + build loop):** auto-login the testing wallet (`TESTING_WALLET_PK`); the backend signs txs directly with that wallet. No OAuth. Trades Mysten's real Predict, same as privy mode.

Demo mode (`VITE_DEMO_MODE`) stays the one sanctioned no-backend sim. Suiet wallet connect is not in v1 (`@suiet/wallet-kit` stays available but unused).

---

## Cross cutting rules

- **Never run destructive Prisma commands.** No `migrate reset`, no `--force-reset`. If the schema changed, ask the user to run `bun run db:push` from `backend/` themselves.
- **Package manager is `bun`** for every pillar. Do not introduce npm, yarn, or pnpm. Lockfiles (`bun.lock`, `bun.lockb`) are committed.
- Both JS apps run on the **Bun runtime**. Verify Bun compatibility before suggesting Node specific APIs.
- **Ports:** backend `:3780`, web `:3200`.
- Frontend talks to backend via `VITE_API_URL` (validated in `web/src/env.ts`). Backend CORS is locked to `ALLOWED_ORIGIN` in production.
- **Sui IDs and package addresses live in config, never inline.** This applies to DeepBook Predict and any pool/object IDs.
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

**The spine (decided):** every play is a real `mint`/`redeem` against Mysten's **official** DeepBook Predict on `testnet` (default) / `mainnet`. We do not publish or run oracles; discovery is direct chain reads via `predict-real.ts`. No sim. Plays are server-signed (privy mode = the user's embedded wallet via Privy `rawSign` under a session signer; dev mode = the testing wallet), gas is paid by the sponsor wallet. Fast paced is the priority. The why and how: `bigdev/plans/01-ARCHITECTURE.md` and `05-SUI-PREDICT.md`; the runtime shape lives in "The chain" above.

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
| `bigdev/plans/LUCKY.md` | LUCKY game rebuild: slot-weighted reel, tier->strike solver, Privy auth swap, USDC chips + free SUI gas. Its testnet-real leverage redesign lives in `cont/01` |
| `bigdev/plans/cont/01-PREDICT-TESTNET.md` | **Testnet-real Predict (dual-mode real path).** Per-owner account wrapper, internal-balance mint/redeem, chain-read discovery, tiny-amount economy, sponsor safety layer, LUCKY leverage solver. Read for anything `SUI_NETWORK=testnet` |
| `bigdev/plans/cont/02-BACKEND-HARDENING.md` | **Backend production hardening (shipped).** Worker registry + health/readiness endpoints, graceful shutdown + crash handlers, rate limiting, helmet, structured logging, Postgres advisory leader lock, opt-in alert webhook, DB pool sizing, fail-fast prod config, minimal CI. Read for backend process-resilience/ops work |

`docs/DESIGN.md` remains the canonical visual system. Demo-grade quality bar: `bigdev/plans/07-DESIGN-SYSTEM.md` + `bigdev/plans/08-DEMO-FLOW.md`.

**Build + run commands:**

```bash
cd web && bunx tsc --noEmit        # fast typecheck gate (the loop's baseline check)
cd backend && bun run typecheck    # backend typecheck gate
cd backend && bun dev              # API on :3780
cd web && bun dev                  # console on :3200
cd backend && bun run db:push      # USER runs this after schema changes (never the loop)
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
- `SUI_NETWORK=testnet` means Mysten's OFFICIAL DeepBook Predict deployment, never our vendored fork. The fork is `localnet`/`devnet` only; testnet selects the real-protocol path (ids/module/discovery). No third mode/flag. The old fork-on-testnet `deployed.json` is dead once the real path ships. (L-005)
- There is no working discovery HTTP API for real Predict testnet: `predict-server.testnet.mystenlabs.com` indexes a dead third deployment (`0xf5ea2b37…`), not our target (`0xdb3ef5a5…6446e`). Discover markets/oracles via direct gRPC chain reads (`plp::active_expiry_markets` + `registry::expiry_market_id`, expiries from `market_manager::cadence_period_ms`). Never wire discovery to that server. (L-006)
- Real Predict's Move interface is structurally different from the fork: one `AccountWrapper` per owner via `derived_object` + a fresh `Auth` every tx; a 3-step internal-balance dance (`deposit_funds` a Coin in, mint draws the internal `Balance`, redeem deposits back, `withdraw_funds` a Coin out); unified `lower_tick`/`higher_tick` (0=-inf, `pos_inf_tick`=+inf, tick=raw/tick_size); a `Pricer` (`load_live_pricer`) built fresh per PTB from 4 Propbook feed objects via `OracleRegistry`; `redeem_settled` permissionless/full-close, `redeem_live` owner-authed/partial. Real builders live in a NEW `predict-real.ts`; never bend the fork's `predict.ts` to reach it. (L-007)
- Against a deployment we don't own, DUSDC is NOT mintable (`DUSDC_MINTABLE` stays false): chips come from a manually funded treasury wallet, not a mint. Real testnet SUI is finite, so the gas sponsor needs a safety layer: per-user play-rate limit, a testnet-sane `PLAY_GAS_BUDGET`, a balance-floor pause with a clear user message (never silent-fail), burn-rate monitoring. (L-008)
- Real Predict has real continuous `leverage: u64` (any `L >= 1`, `expiry_market.move:232`); plumb it through the real builder, do not clamp to 1. The capability box above now states the dual-mode truth: the fork (localnet/devnet) has no leverage, testnet-real has real continuous leverage bounded by `max_admission_leverage` and probability-gated per strike. (L-009)
- On `testnet` (real Predict) use the smallest stakes the PROTOCOL allows and QA does the MINIMUM real plays (one mint + one cash-out + one settled), never a loop. Free-localnet spending habits do not carry over. (L-010)
- Real Predict hard-floors a mint at `net_premium >= $1` (`min_net_premium = 1_000_000` 6dp; `net_premium = entry_value / leverage`), so testnet-real `MIN_STAKE`/default stake floors at ~$1 (budget ~$1-2 for premium + fees), NOT the intake's $0.01. Verified fixed constants (read from config-real / the market, never hardcode): prices/strikes/probability/leverage 1e9-scaled, quantity/premium/payout 6dp; `position_lot_size=10_000`; `pos_inf_tick=(1<<30)-1`, neg_inf lower tick=0, `tick = price1e9 / tick_size`; BTC `tick_size=1e7` ($0.01), `admission_tick_size=1e9` ($1), `max_admission_leverage=3e9` (3.0x), `liquidation_ltv=0.85e9`. The minted order id encodes an on-chain sequence, so it is NOT client-derivable: read it from the `OrderMinted` event. (L-011)
- Real Predict exposes NO read-only per-band ask (`pricing::up_price`/`range_price` are `public(package)`, only `current_nav` is public), so LUCKY/RANGE price by **decompose -> mint -> snap**: pick `(strike_tick, higher_tick, leverage, budget)`, mint, read the REAL multiplier/leverage/quantity from the `OrderMinted` event (RANGE `/games/range/quotes` returns `[]` in real mode, the client shows a labelled estimate that snaps on mint). Leverage is probability-gated by `admitted_leverage_cap(p)` (near-ATM up to `max_admission_leverage`, far-OTM ~1x) and `p` is unreadable pre-mint, so clamp the leverage request to the market cap and, on an admission abort (`ELeverageAboveAdmission` / `EEntryProbabilityOutOfBounds` / `ENetPremiumBelowMinimum` / `EOrderBelowLiquidationThreshold`), drop leverage to 1x and retry the SAME strike (closest-achievable fallback, chips safe), never a fabricated number. (L-012)
- Real-mode (testnet) binary/range strikes must be sized by a TARGET WIN PROBABILITY, not a fixed percentage. Binary: `offsetFrac = probit(1−p)·sigma`, `sigma = REAL_BTC_ANNUAL_VOL·sqrt(T_seconds/yr)`, `p = clamp(1/strikeTier, REAL_STRIKE_MIN_PROB, 1−REAL_STRIKE_MIN_PROB)`, guard-capped at `REAL_STRIKE_MAX_OFFSET_FRAC` (a low leveraged tier gives `offsetFrac<0`, an ITM strike); range: cap the half-width under `REAL_RANGE_MAX_PROB`. A short 20-60s BTC round's 1-sigma move is only ~0.04-0.08% of spot, so the fork's fixed 0.15%+ strike lands multiple sigma OTM and every real mint aborts on `min_entry_probability` (a wide band mirrors it, tripping the max). The admission band is unreadable pre-mint (L-012), so keep `p` conservative and lean on the abort fallback; knobs in `main-config.ts`, calibrated at QA. Fork mode keeps the fixed-percentage map. (L-013)
- Never run an all-shared-input tx whose wallet may hold SUI as an address balance through the coin-caching `SerialTransactionExecutor`. On testnet the gRPC resolver pays gas from the address balance (empty payment + a resolver-added expiration), and the executor's post-exec gas-coin cache then throws `Gas object not found in effects` AFTER the tx already landed, discarding the result and looping settlement. Use a direct build-sign-submit path (`executeRealSettle`, mirroring `executeAsTreasury`: `toExecResult` reads `effects.status`, never the gas coin, so it survives both gas modes and finalizes on the first tick). Fork settle keeps the serial executor (operator holds owned faucet coins, always coin gas). (L-014)
- External market feeds (Binance, any off-chain price source) are DISPLAY-ONLY: they drive the chart's MOTION, never a recorded/settled number. The line level is continuously pinned to the on-chain oracle (`displaySpot = binanceSpot + EMA(oracleSpot − binanceSpot)`; slew-limit the OFFSET not the price; converge near the buzzer), but `entrySpot`, the recorded cash-out exit (`assetSpot`/`readBtcSpot`, NEVER `displaySpot`), `lockPrice`, and `settlePrice` all keep reading the chain, and the result reveal snaps to the true on-chain `settlePrice`. Keep it strictly additive: a fallback ladder degrades to today's eased on-chain feed (`gameSpot`) with hysteresis when the external feed is stale/unreachable and never crashes or freezes the chart. Real mode (`SUI_NETWORK=testnet`) + mainnet only; fork (localnet/devnet) keeps its own synthetic-walk oracle, never pin it to an external feed. (L-015)
- `@fastify/rate-limit@11`'s `errorResponseBuilder` return value is THROWN, and Fastify defaults a thrown plain object with no `statusCode` to 500. A custom builder MUST carry the plugin's `context.statusCode` (429, or 403 on ban); attach it non-enumerable (`Object.defineProperty(body, 'statusCode', { value: context.statusCode, enumerable: false })`) so the HTTP code is right while `JSON.stringify` still emits the clean `{ success, error, data }` envelope. (L-016)
- Backend lint runs through `backend/eslint.config.js` (typescript-eslint FLAT config: `typescript-eslint@8` + `@eslint/js@10`, peer-compatible with `eslint@10`), deliberately conservative (mostly warnings, `.js/.cjs/.mjs` ignored, source is all `.ts`) so `bun run lint` (part of the build gate + CI) stays green on existing code. `bun run lint` had effectively never gated before Wave 004. Never re-add `.eslintrc.*` (eslint 10 dropped it) or expect the default parser to handle `.ts`. (L-017)
- `node-cron` is v4.2.1 (its bundled types win over the stale `@types/node-cron@3`); `schedule(expr, fn)` returns a `ScheduledTask` whose `start()/stop()/destroy()/getStatus()` are `void | Promise<void>`. Capture the task for coordinated shutdown and type a stop handle structurally as `{ stop: () => void | Promise<void> }` so a cron task, a `setInterval` wrapper, and a socket closer all satisfy it. Workers keep their own `isRunning` guard, so node-cron's `noOverlap` is not needed. (L-018)
- The backend is NOT hermetic at import: `main-config.ts` `process.exit(1)`s when `DATABASE_URL`/`JWT_SECRET` are absent and `signer.ts` throws when `TESTING_WALLET_PK` is empty (a deliberate boot fail-fast; that throw mid-init cascades into `Cannot access 'eventString' before initialization` TDZ across the predict modules), and `prisma/generated` is gitignored. So any bare-checkout / CI run of `bun test` (or typecheck/lint) needs all three: `bun run db:generate` first, `DATABASE_URL` + `JWT_SECRET` present (placeholders fine, nothing connects), and a throwaway `TESTING_WALLET_PK` (`openssl rand -base64 32`). Do NOT make `signer.ts` lazy to "fix" it, the eager throw is the wanted prod fail-fast; `.github/workflows/backend-ci.yml` wires all three. (L-019)

## Continuation mode

/bigdev-cont setup. Run `./bigdev/autocont` to build the current wave autonomously.
- `./bigdev/autocont` start (or attach to) the loop; `status | kill | logs | watch`
- `./bigdev/autocont say "rule"` durable steering; `fix "msg"` one-shot
- `./bigdev/autocont learn "never do X"` log a lesson; it lands in bigdev/claude/lessons.md and gets promoted into ## Learnings
- `./bigdev/autocont lessons` view the ledger; `log` view durable rules
- `MAX=20 ./bigdev/autocont` cap iterations; `VALIDATE=1 ./bigdev/autocont` pre-flight

Current wave: `bigdev/CONT-TODO.md`. Wave specs + archive: `bigdev/plans/cont/`. Lessons: `bigdev/claude/lessons.md`.
