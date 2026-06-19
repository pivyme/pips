# Pips

**Trading, but a game.**

Pips is a gamified trading console on **Sui**, powered by **DeepBook Predict**. No charts to read, no jargon, no 180 IQ required. Just plays that are fun, fast, and addictive. The whole interface behaves like a tactile handheld console with a screen, two action buttons, a main button, and a knob. Every play is a real on-chain prediction-market position, minted and redeemed in seconds, with cash-out anytime.

![hero](docs/screenshots/hero.png)

## The 2-minute story

Sign in with Google (no wallet, no seed phrase), get a stack of free testnet chips, and play. Hit "I Feel Lucky": the reels spin to a random asset, leverage, and side, the price chart goes live and buttery-smooth, your payout climbs in real time, and you cash out a green win, all on real DeepBook Predict. Then Range (call a price zone, tighter pays more) and Tap (tap the chart to bet). Your record builds into a shareable stats card. Full arc in [`bigdev/claude/demo-script.md`](bigdev/claude/demo-script.md).

![game](docs/screenshots/lucky.png)
![stats](docs/screenshots/stats.png)

## How the chain part works

Pips runs its **own** DeepBook Predict deployment on Sui testnet: we publish Mysten's `packages/predict`, seed the vault with free test-USDC, and run short-expiry markets via a backend price feed. So the games are genuinely fast (10s/30s/60s rounds) and every play is a real `mint`/`redeem` on the real Predict contract, with native early cash-out. You never provide real liquidity. On mainnet later, the same app re-points to Predict's shared liquidity (one config change). Details in [`bigdev/plans/05-SUI-PREDICT.md`](bigdev/plans/05-SUI-PREDICT.md).

## Stack

- **Frontend** (`web/`, :3200) — TanStack Start (React 19), TanStack Router + Query, Tailwind 4, HeroUI v3, GSAP, Lenis, Motion. The console UI. A 60fps canvas chart.
- **Backend** (`backend/`, :3780) — Bun + Fastify 5, Prisma 7 (PostgreSQL). Game engine, the Predict operator (price-pusher, oracle ladder, settle), indexer, SSE streams.
- **Contracts** (`contracts/`) — Mysten's `packages/predict`, vendored and published as our own instance.
- **Auth** — Sui zkLogin via Enoki (Google), plus a dev auto-login. Gasless plays via Enoki sponsorship.
- **Runtime / package manager** — Bun everywhere (target Bun >= 22).

## Structure

```
pips/
├── web/          Frontend (the console UI)
├── backend/      API, game engine, Predict operator, indexer
├── contracts/    Vendored DeepBook Predict package (we publish our own instance)
├── docs/         DESIGN.md (canonical visual system) + references + screenshots
└── bigdev/       v1 build plan + autonomous build loop (see below)
```

## Quickstart

Prereqs: [Bun](https://bun.sh) >= 22, PostgreSQL, the [Sui CLI](https://docs.sui.io) (testnet), and a funded testnet wallet key. See [`.env.example`](.env.example) for every variable.

```bash
# backend
cd backend
cp ../.env.local-stub .env     # dev defaults (AUTH_MODE=dev, no OAuth needed)
bun install
bun run db:push                # push schema + generate client
bun run prisma/seed.ts          # seed achievements + demo data
bun run scripts/bootstrap.ts    # publish our Predict instance + seed vault + oracles (one time)
bun dev                         # :3780

# frontend (new terminal)
cd web
cp ../.env.local-stub .env
bun install
bun dev                         # :3200
```

In dev mode the landing shows "Enter" and drops you straight into the console with a funded dev wallet, every play hitting real Predict on testnet. For the Google sign-in flow, set `AUTH_MODE=enoki` and the Enoki keys (see `.env.example`).

The local config ships with `PIPS_OPERATOR_ENABLED=true`: the backend runs the live markets (price-pusher, oracle ladder, settle). On a multi-instance deploy, set it `true` on exactly one backend (the leader) and `false` on the rest so oracles are not double-pushed. Before recording a demo, run `cd backend && bun run scripts/preflight.ts --play` to rehearse a real round end to end and confirm the explorer links resolve.

> Bun + Sui note: the Sui crypto stack uses WASM, and `vite-plugin-wasm` can fail when the Vite dev server runs through Bun. If the frontend throws a WASM load error, run the Vite dev server on Node (bun stays the package manager).

## Build it (autonomous loop)

v1 is planned phase by phase under [`bigdev/`](bigdev/). To build it:

```bash
./bigdev/autobuild
```

It runs a fresh-session loop that works through [`bigdev/TODO.md`](bigdev/TODO.md), commits at each phase, and pauses when it needs you (publish, fund a wallet, `db:push`, paste a key). Steer it with `./bigdev/autobuild say "rule"`.

## Deployment

- **Frontend (Vercel):** Root Directory `web`, preset Vite, build `bun run build`, output `.output`.
- **Backend (Docker + Dokploy):** build `./backend`, port `3780`, health `GET /`. Run the Predict operator workers on a single leader instance.

Details and the mainnet re-point in [`bigdev/plans/09-DEPLOYMENT.md`](bigdev/plans/09-DEPLOYMENT.md).

## License

TBD.
