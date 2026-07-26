# Backend Development Guidelines

## CRITICAL DATABASE WARNING

**NEVER EVER run any Prisma command that will reset/wipe the database.** If schema changes are needed, tell the user to run `bun run db:push` themselves. Commands like `prisma migrate reset`, `prisma db push --force-reset`, or any destructive database operations are strictly forbidden.

---

## PIPS context

This is the **PIPS** backend (gamified trading on Sui via DeepBook Predict). Read the root [`../CLAUDE.md`](../CLAUDE.md) for product and Sui stack context. Its job: auth (Privy + a dev auto-login), game engine, settlement, market discovery, and server-signing the user's plays (`@privy-io/node` `rawSign` under a session signer; dev = the testing wallet).

**The chain is Mysten's official DeepBook Predict**, on `testnet` (default) or `mainnet` via `SUI_NETWORK`. All Predict code lives in `src/lib/sui/predict-real.ts` + `config-real.ts`: per-owner `AccountWrapper`, internal-balance mint/redeem, discovery via direct chain reads, `redeem_settled` at expiry. The record is the committed `src/lib/sui/deployed-real.testnet.json` (read via `config-real.ts`, ids re-fetched from chain, never hand-copied). Binding rules are **L-005..L-012** in the root `CLAUDE.md ## Learnings`, read them before touching Predict. Never hardcode ids. (The vendored fork under `../contracts/` and the `../scripts/localnet.sh` deploy front door remain on disk for reference only, not the run path.)

**v1 build:** planned in [`../bigdev/plans/`](../bigdev/plans/). Read `05-SUI-PREDICT.md` (the Predict capability box + wrappers) and `cont/01-PREDICT-TESTNET.md` (the real-path spec), `02-API.md` (routes + SSE streams), `03-DATABASE.md` (schema + seed), `LUCKY.md` §6 (dev + Privy auth, the current source of truth; `04-AUTH.md` keeps the JWT plumbing + onboarding). All Sui ids come from config, never hardcode.

**Sui (verified mid 2026, reconfirm before coding):**
- Use `@mysten/sui` (v2.x, ESM only). Fullnode reads/writes go through `SuiGrpcClient` (`@mysten/sui/grpc`); historical queries (events, tx-history) through `SuiGraphQLClient` (`@mysten/sui/graphql`). JSON-RPC is removed, never re-add `@mysten/sui/jsonRpc`. Both clients live in `src/lib/sui/client.ts` (built with an explicit `baseUrl` from config).
- **Auth:** privy mode verifies the Privy access token with `@privy-io/node` `verifyAccessToken`, then mints the existing JWT. Plays are server-signed: the tx intent digest is signed via Privy `rawSign` (`blake2b256`) and wrapped with `toSerializedSignature` + `Ed25519PublicKey`. All Privy server calls funnel through `src/lib/sui/privy.ts`.
- All Sui code lives in `src/lib/sui/`. Read package IDs and addresses from config, never hardcode (DeepBook Predict IDs are unstable pre mainnet).

**Sui only:** the EVM (`ethers`) and Solana (`@solana/web3.js`, `bs58`) starter deps have been removed. If any `ethers` / `@solana/*` reference survives, it is dead, delete it, do not build on it.

---

## Commands

Runtime is **Bun**, not Node. Framework is **Fastify**. All scripts run via `bun`.

```bash
bun dev                     # Start with file watcher on :3780
bun start                   # Production start (no watch)
bun run typecheck           # tsc --noEmit (the build loop's gate)
bun run lint                # ESLint. This one IS a gate, keep it green (root L-017)
bun test                    # Bun's runner over colocated *.test.ts (math, rng, achievements, games, stats, play-bus, predict-real)
bun run pips:post-deploy-check   # Smoke a deploy: config, chain reads, wallets
bun run pips:proof          # Volume proof script
bun run test:logger:e2e     # On-chain logger integration test (PIPS_E2E=1, hits the network)
bun run db:push             # Push schema + regenerate client (USER runs this, never the loop)
bun run db:pull             # Pull schema from existing DB
bun run db:generate         # Regenerate Prisma client only
bun run db:migrate          # Create a new migration
bun run db:seed             # Seed the database (prisma/seed.ts)
```

`bun --watch` does not reload on `.env` edits, restart the process by hand after changing one. A bare checkout cannot run `bun test` / typecheck / lint until you `bun run db:generate` and set `DATABASE_URL`, `JWT_SECRET`, and a throwaway `TESTING_WALLET_PK`, the boot fail-fast is deliberate (root L-019).

Env is loaded by `dotenv.ts`, which is imported at the top of `index.ts` before any other module. Copy `.env.example` to `.env`. Required: `DATABASE_URL`, `JWT_SECRET`. Optional: `APP_PORT` (default 3780), `ALLOWED_ORIGIN` (required in production for CORS).

This is part of a monorepo. Sibling `web/` is the TanStack Start frontend.

---

## Project Structure

```
/
├── index.ts                 # Thin bootstrapper: load env, then dynamic-import app.ts
├── app.ts                   # The app: builds Fastify, registers routes + workers, GET /health + /health/ready, graceful shutdown, crash handlers
├── dotenv.ts                # Environment loader (imported first, before any module)
├── prisma/
│   ├── schema.prisma        # Database schema
│   └── seed.ts              # Seed data (bun run db:seed)
├── scripts/                 # Ops, diagnostics, benches. Run with `bun scripts/<name>.ts`
│                            #   post-deploy-check, verify-sponsor, diag-pnl, diag-funding,
│                            #   bench-lucky, bench-settle, bench-range, airdrop-dusdc,
│                            #   migrate-achievements, backfill-emails, gen-ops-wallets, wipe-history
├── src/
│   ├── config/main-config.ts    # Centralized env config (import from here, not process.env)
│   ├── routes/              # Fastify plugins, registered in app.ts
│   │   ├── authRoutes.ts    # /auth: dev login, privy/verify, heal, me
│   │   ├── gameRoutes.ts    # /games/* play + quotes, /plays/* confirm + cashout, /markets, /prices/history
│   │   ├── menuRoutes.ts    # /stats, /achievements, /settings, minigame scores
│   │   ├── leaderboardRoutes.ts # /leaderboard
│   │   ├── walletRoutes.ts  # /wallet: balances, grant, withdraw, sync, request-dusdc faucet
│   │   ├── depositRoutes.ts # /deposit: LI.FI multichain deposit (mainnet-gated)
│   │   ├── referralRoutes.ts # /referral: codes, claims, revshare
│   │   ├── avatarRoutes.ts  # POST + DELETE /avatar (S3 upload, fail-soft)
│   │   ├── streamRoutes.ts  # SSE: /stream/prices (fallback), /stream/plays/:id, /stream/markets, /stream/live
│   │   ├── wsRoutes.ts      # WS /ws: shared 10Hz displaySpot broadcast hub (the chart feed)
│   │   └── exampleRoutes.ts # starter sample
│   ├── services/            # Business logic, called by routes
│   │   └── auth, games (+ games-base / games-real split), plays, stats, achievements,
│   │       rng, wallet, leaderboard, referral (+ colocated *.test.ts)
│   ├── workers/             # node-cron jobs (isRunning guard), tracked in worker-registry
│   │   ├── market-sync.ts   # discovers the live 1m BTC markets from chain
│   │   ├── settle.ts        # settles expired plays (redeem_settled)
│   │   ├── price-warmer.ts  # keeps display-asset Pyth spot pre-warmed
│   │   ├── wallet-indexer.ts # scans user addresses into the WalletTx ledger (presence-gated)
│   │   ├── token-worker.ts  # warms the TokenInfo metadata/price cache off the request path
│   │   ├── analytics.ts     # ops detectors, nightly digest, balance sweep, retention (the one analytics cron)
│   │   └── depositCleanup.ts (mainnet)
│   ├── middlewares/authMiddleware.ts
│   ├── types/api.ts         # DTO contract (mirrors web/src/lib/api.ts)
│   ├── utils/               # errorHandler, validationUtils, miscUtils, timeUtils
│   └── lib/
│       ├── prisma.ts        # Database client (pg adapter, PIPS_DB_POOL_MAX pool ceiling)
│       ├── worker-registry.ts # Tracks every cron/interval worker for /health/ready + coordinated shutdown
│       ├── alert.ts         # Opt-in Discord/Slack webhook for unrecoverable events (no-op if PIPS_ALERT_WEBHOOK_URL unset)
│       ├── pyth.ts          # Pyth price reads
│       ├── price-cache.ts   # In-memory price cache
│       ├── game-price.ts    # gameSpot: eased on-chain market spot
│       ├── binance-ws.ts    # Shared Binance aggTrade WS (chart MOTION, display-only, L-015)
│       ├── price-bus.ts     # displaySpot: Binance motion EMA-pinned to the on-chain market spot
│       ├── price-history.ts # Rolling ~60s displaySpot ring, so every device draws the same pre-roll
│       ├── markets-feed.ts  # ONE builder shared by GET /markets and /stream/markets
│       ├── play-bus.ts      # In-process play-status bus: SSE pushes on commit, not on poll
│       ├── lifi.ts          # The one LI.FI wrapper (routes never call li.quest directly)
│       ├── s3.ts            # Bun S3Client over the shared DO Spaces bucket (avatars)
│       └── sui/             # client, predict-real + config-real + deployed-real.testnet.json (Mysten's Predict),
│                            #   markets, math, signer, privy, dusdc, gas, sponsor, execute, config,
│                            #   play-safety (rate limit + sponsor floor, L-008), house (rake seam),
│                            #   logger (PIPS attribution appended to the mint PTB), tokens,
│                            #   walletAuth + custodial (wallet-connect login), wallet-ledger, wallet-history
```

---

## Configuration (`src/config/main-config.ts`)

**The single source of truth for env.** Every tunable is a named export here, read from `process.env` with a default. Import from config, never touch `process.env` directly:

```ts
import { JWT_SECRET, APP_PORT, AUTH_MODE, SUI_NETWORK } from '../config/main-config.ts';
```

It covers, grouped: **core** (`APP_PORT`, `NODE_ENV`, `IS_DEV`/`IS_PROD`, `DATABASE_URL`, `JWT_SECRET`, `ALLOWED_ORIGIN`), **auth** (`AUTH_MODE` dev|privy, the `PRIVY_*` keys, `TESTING_WALLET_PK`), **Sui** (`SUI_NETWORK`, `SUI_FULLNODE_URL`, `PYTH_HERMES_URL`), **economy** (`STARTING_BALANCE`, `MIN_STAKE`/`MAX_STAKE`, `GAME_DURATIONS`), **gas** (`PLAY_GAS_BUDGET`, `GAS_SPONSORSHIP_WALLET_PK` + the `SPONSOR_*` knobs), **workers** (`SETTLE_CRON` / `MARKET_SYNC_CRON`, the `LUCKY_ROUND_MS` / `RANGE_*_ORACLE_LIFE_MS` round durations), **real-mode sizing** (the `REAL_*` strike knobs + the sponsor safety layer), and **hardening** (`PIPS_SHUTDOWN_TIMEOUT_MS` graceful-drain budget default 8000ms, `PIPS_DB_POOL_MAX` pg pool ceiling default 10, `PIPS_ALERT_WEBHOOK_URL` opt-in Discord/Slack alerts empty default, the `PIPS_RATE_LIMIT_*` HTTP caps). Add a new tunable here, not inline.

---

## Error Handling (`src/utils/errorHandler.ts`)

Always use the centralized error handler for consistent responses and automatic database logging:

```ts
import { handleError, handleNotFoundError, handleUnauthorizedError } from '../utils/errorHandler.ts';

// Generic error
return handleError(reply, 401, 'User not authenticated', 'USER_NOT_AUTHENTICATED');

// With original error and context
return handleError(reply, 500, 'Failed to process', 'PROCESS_FAILED', originalError, { orderId });

// Convenience methods
return handleValidationError(reply, ['email', 'password']);
return handleNotFoundError(reply, 'User');
return handleUnauthorizedError(reply, 'Session expired');
return handleForbiddenError(reply, 'Admin access required');
return handleDatabaseError(reply, 'create user', originalError);
return handleServerError(reply, originalError);
```

Error logs are pruned by age by `services/retention.ts` (run hourly from the analytics worker), off the `retention.error_days` setting in `src/config/admin-settings.ts` (a DB-backed knob, not an env var). Retention is the only code here that deletes rows: chunked at 5k with a 50k per-run cap, hard floors clamped on read, and a typed confirm the server recomputes. There is deliberately no path to truncate a table, purge every group, wipe a user, or reset the DB.

---

## Analytics and error capture (`src/lib/analytics.ts`)

The ADMIN-only dashboard at `/admin` is fed from here. Spec: [`../bigdev/plans/cont/03-ADMIN-DASHBOARD.md`](../bigdev/plans/cont/03-ADMIN-DASHBOARD.md).

**Errors need zero work.** `handleError()` (every HTTP path), `recordRun()` (every registered worker), and `handleFatal()` (process-level) already call `captureError()`, so a new route or worker is instrumented the moment it exists. Errors are fingerprinted and grouped, so 400 occurrences of one bug are one row with a count, never 400 rows.

Only two cases need a line of your own:

```ts
captureError(e, { playId, fingerprint: 'chain.something' });   // a new Sui/chain call site
track(userId, 'money.deposit_done', { props: { chain } });     // an event only the server can observe
```

Both are fire-and-forget, both are impossible to throw, and neither is ever awaited on a request or play path. If a feature touches chain or money, also add a detector to the array in `services/insights.ts` with a **one-line runbook**: an alert without a runbook is a notification, not a tool. Expected aborts (admission failures, benign 409s) stay at `warn` and never page.

Never dedupe, group, or alert on an interpolated message string: our messages carry play ids, amounts, and object ids, so every occurrence is unique and the dedupe silently never fires. Key off the fingerprint or the detector key (root L-021).

**No route may ever write `specialRoles`.** Every user write uses an explicit field allowlist, forever. Roles are read fresh per request (never baked into the JWT, or a revoke waits for token expiry), and ADMIN is granted only by `bun scripts/grant-role.ts <userIdOrUsername> ADMIN`, script-only forever, so a compromised admin session cannot mint more admins. A non-admin hitting `/admin/*` gets **404, not 403**: do not confirm the surface exists.

Non-secret tunables are DB-backed settings in `src/config/admin-settings.ts` (declared once with a default and bounds, clamped on read, cached ~30s), not new entries in `main-config.ts` (root L-022). Secrets and boot-critical values stay in env forever.

---

## Request Validation (`src/utils/validationUtils.ts`)

Use `validateRequiredFields` for request body validation:

```ts
import { validateRequiredFields } from '../utils/validationUtils.ts';

app.post('/register', async (request, reply) => {
  const validation = await validateRequiredFields(request.body as Record<string, unknown>, ['email', 'password'], reply);
  if (validation !== true) return;

  // Proceed with validated data
});
```

---

## Route Registration Pattern

Routes are grouped by prefix. Each route file exports a Fastify plugin:

**Route file (`src/routes/adminRoutes.ts`):**
```ts
import type { FastifyInstance, FastifyPluginCallback, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../middlewares/authMiddleware.ts';

export const adminRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.post('/login', async (request: FastifyRequest, reply: FastifyReply) => {
    // Handler for POST /admin/login
  });

  app.get('/users', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    // Protected route: GET /admin/users
  });

  done();
};
```

**Registration lives in `app.ts`, not `index.ts`.** `index.ts` is a 4-line bootstrapper that loads env then dynamic-imports `app.ts`; every `fastify.register(...)` is in `app.ts`:

```ts
// app.ts
import { adminRoutes } from './src/routes/adminRoutes.ts';

fastify.register(adminRoutes, { prefix: '/admin' });
```

---

## Worker Pattern (`src/workers/`)

Workers use `node-cron` with an `isRunning` flag to prevent double execution, and report to the worker registry so `/health/ready` and graceful shutdown can see them. `settle.ts` is the reference:

```ts
import cron from 'node-cron';
import { cronIntervalMs, recordRun, registerWorker } from '../lib/worker-registry.ts';

let isRunning = false;

const myTask = async (): Promise<void> => {
  if (isRunning) return;                 // previous run still active

  isRunning = true;
  const startedAt = Date.now();
  let runErr: unknown = null;
  try {
    // Do work
  } catch (err) {
    runErr = err;
    console.error('[MyWorker] tick error:', err instanceof Error ? err.message : err);
  } finally {
    isRunning = false;
    recordRun('myWorker', !runErr, Date.now() - startedAt, runErr);
  }
};

export const startMyWorker = (): void => {
  const task = cron.schedule('*/5 * * * *', myTask);
  registerWorker('myWorker', task, cronIntervalMs('*/5 * * * *'));
  myTask();                              // optional: run immediately on startup
};
```

A worker that skips `registerWorker` is invisible to readiness and never drains on shutdown. Never swallow a tick error silently, `recordRun` is what surfaces it.

**Register in `app.ts`** (same file as the routes), and hand the task to the worker registry so `/health/ready` sees it and shutdown can drain it:

```ts
// app.ts
import { startMyWorker } from './src/workers/myWorker.ts';

startMyWorker();
```

A worker's stop handle is structural (`{ stop: () => void | Promise<void> }`), so a cron task, a `setInterval` wrapper, and a socket closer all satisfy it (root L-018).

---

## Authentication Middleware

Protected routes use `authMiddleware` as a preHandler:

```ts
import { authMiddleware } from '../middlewares/authMiddleware.ts';

app.get('/profile', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
  const user = request.user; // Available after auth (typed via module augmentation)
});
```

---

## External Integrations (`src/lib/`)

Every external service gets **one wrapper module in `src/lib/`, and routes and services call only that**. Predict goes through `sui/predict-real.ts`, LI.FI through `lifi.ts`, Spaces through `s3.ts`, Privy through `sui/privy.ts`, Pyth through `pyth.ts`. When a catalog moves, ids rotate, or mainnet lands, we touch one file. A route that reaches a vendor SDK directly is the thing this rule exists to prevent.

---

## Database Usage

Import the Prisma client from lib:

```ts
import { prismaQuery } from '../lib/prisma.ts';

const user = await prismaQuery.user.findUnique({ where: { id } });
```

---

## Standard Response Format

All responses should follow this structure:

```ts
// Success
reply.code(200).send({
  success: true,
  error: null,
  data: { /* response data */ },
});

// Error (handled automatically by errorHandler)
{
  success: false,
  error: {
    code: 'ERROR_CODE',
    message: 'Human readable message'
  },
  data: null,
  timestamp: '2024-01-01T00:00:00.000Z'
}
```

---

## Common Utilities (`src/utils/`)

**miscUtils.ts:**
- `sleep(ms: number): Promise<void>` - Promise-based delay
- `getAlphanumericId(length?: number): string` - Generate random alphanumeric ID
- `shortenAddress(address: string, startLength?: number, endLength?: number): string` - Truncate wallet addresses

**timeUtils.ts:**
- `getCurrentTime(): string` - ISO timestamp
- `getCurrentTimeUnix(): number` - Unix timestamp
- `convertDateToUnix(date: Date): number` - Date to Unix
- `manyMinutesAgoUnix(minutes: number): number` - Timestamp X minutes ago

---

## Quick Reference

| Task | Solution |
|------|----------|
| Add env variable | Add to `main-config.ts` |
| Handle errors | Use `handleError()` from errorHandler |
| Validate request body | Use `validateRequiredFields()` |
| Add new route group | Create file in `src/routes/`, register in `app.ts` (not `index.ts`) |
| Add background job | Create file in `src/workers/`, `isRunning` flag + `registerWorker`, start it in `app.ts` |
| Add external integration | One wrapper module in `src/lib/`, callers never touch the vendor SDK |
| Protect route | Add `{ preHandler: [authMiddleware] }` |
| Lint | Run `bun run lint` |
