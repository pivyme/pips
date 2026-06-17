# Pips

**Makes trading simple, intuitive, and addictive, like a game.**

Pips is a gamified trading platform on **Sui**, powered by **DeepBook Predict**. Web based, mobile optimized, and built as a collection of trading games that make trading feel like play.

Trading terminals all look and feel the same, and traders are bored. Pips throws out the wall of candles and order books. No complexity, no jargon, no 180 IQ required. Just plays that are fun, social, and addictive. The twist: the whole interface is a tactile 3D **handheld console**, a real device with a screen, knobs, and buttons, inspired by the "Camera" app from Not Boring Software.

## Status

Early bootstrap. The monorepo scaffolding and docs are in place, app build is in progress. See [`.claude/progress.md`](./.claude/progress.md) for the roadmap.

## Stack

- **Frontend** (`web/`, port `3200`) — TanStack Start (React 19), TanStack Router + Query, Vite, Tailwind CSS 4, HeroUI v3, GSAP, Lenis, Motion. The console UI.
- **Backend** (`backend/`, port `3700`) — Bun + Fastify 5, Prisma 7 (PostgreSQL), JWT auth, node-cron.
- **Contracts** (`contracts/`) — Sui Move. Game logic and DeepBook Predict composition.
- **Chain** — Sui. Trading mechanic via DeepBook Predict (testnet for now).
- **Auth** — Suiet wallet connect first, Sui zkLogin (via Enoki) second.
- **Runtime / package manager** — Bun everywhere (target Bun >= 22).

## Structure

```
pips/
├── web/          Frontend (the console UI)
├── backend/      API server
├── contracts/    Sui Move packages
├── docs/         DESIGN.md (console design language) + visual references
└── .claude/      progress.md (live roadmap)
```

## Quick start

Prereqs: [Bun](https://bun.sh) (>= 22) and PostgreSQL.

```bash
# Backend
cd backend
cp .env.example .env        # fill in your values
bun install
bun run db:push             # push schema + generate Prisma client
bun dev                     # http://localhost:3700

# Frontend (new terminal)
cd web
cp .env.example .env        # fill in your values
bun install
bun dev                     # http://localhost:3200
```

> Bun + Sui note: the Sui crypto stack uses WASM, and `vite-plugin-wasm` can fail when the Vite dev server runs through Bun. If the frontend dev server throws a WASM load error, run the Vite dev server on Node (bun stays the package manager). Details in [`CLAUDE.md`](./CLAUDE.md).

## Environment

### Backend (`backend/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `APP_PORT` | No | `3700` | Server port |
| `NODE_ENV` | No | `development` | `development` or `production` |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `JWT_SECRET` | Yes | — | JWT signing secret |
| `JWT_EXPIRES_IN` | No | `7d` | JWT expiration |
| `ALLOWED_ORIGIN` | Yes (prod) | — | Frontend URL for CORS in production |
| `SUI_NETWORK` | No | `testnet` | `testnet` or `mainnet` |
| `SUI_FULLNODE_URL` | No | — | Override the default fullnode RPC |
| `ENOKI_PRIVATE_API_KEY` | No | — | Server side Enoki key (sponsored tx). Phase 2. |

### Frontend (`web/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `VITE_APP_NAME` | No | `Pips` | App name |
| `VITE_APP_URL` | No | — | App URL |
| `VITE_API_URL` | No | — | Backend API base URL |
| `VITE_SUI_NETWORK` | No | `testnet` | `testnet` or `mainnet` |
| `VITE_ENOKI_API_KEY` | No | — | Public Enoki key (zkLogin). Phase 2. |

## Database

Prisma 7 with the `pg` driver adapter. Schema at `backend/prisma/schema.prisma`.

```bash
cd backend
bun run db:push       # push schema to DB + generate client
bun run db:generate   # generate client only
```

Never run destructive Prisma commands (no `migrate reset`, no `--force-reset`).

## Deployment

- **Frontend (Vercel):** set Root Directory to `web`, framework preset Vite, build `bun run build`, output `.output`.
- **Backend (Docker + Dokploy):** build path `./backend`, exposed port `3700`, health check `GET /`. Set all required backend env vars.

## License

TBD.
