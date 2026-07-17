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
bun dev              # Start with file watcher on :3780
bun start            # Production start (no watch)
bun run typecheck    # tsc --noEmit (the build loop's gate)
bun test             # Run tests (*.test.ts: math, rng, achievements)
bun run lint         # ESLint
bun run db:push      # Push schema + regenerate client
bun run db:pull      # Pull schema from existing DB
bun run db:generate  # Regenerate Prisma client only
bun run db:migrate   # Create a new migration
bun run db:seed      # Seed the database (prisma/seed.ts)
```

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
├── scripts/                 # Diagnostics + benches: bench-lucky, bench-settle, bench-range, diag-pnl, diag-funding, verify-sponsor, gen-ops-wallets, wipe-history
├── src/
│   ├── config/main-config.ts    # Centralized env config (import from here, not process.env)
│   ├── routes/              # Fastify plugins, grouped by prefix
│   │   ├── authRoutes.ts    # /auth: dev login, privy/verify, me
│   │   ├── gameRoutes.ts    # /games/* play, /plays/* confirm + cashout
│   │   ├── menuRoutes.ts    # /stats, /achievements, /settings
│   │   ├── streamRoutes.ts  # SSE: /stream/prices (fallback), /stream/plays/:id, /stream/live
│   │   ├── wsRoutes.ts      # WS /ws: shared 10Hz displaySpot broadcast hub (the chart feed)
│   │   ├── walletRoutes.ts  # /wallet: balances, withdraw, request-dusdc faucet
│   │   └── exampleRoutes.ts # starter sample
│   ├── services/            # Business logic, called by routes
│   │   └── auth, games, plays, stats, achievements, rng, wallet (+ *.test.ts)
│   ├── workers/             # node-cron jobs (isRunning guard)
│   │   ├── market-sync.ts   # discovers the live 1m BTC markets from chain
│   │   ├── settle.ts        # settles expired plays (redeem_settled)
│   │   ├── price-warmer.ts  # keeps display-asset Pyth spot pre-warmed
│   │   └── errorLogCleanup.ts, depositCleanup.ts (mainnet)
│   ├── middlewares/authMiddleware.ts
│   ├── types/api.ts         # DTO contract (mirrors web/src/lib/api.ts)
│   ├── utils/               # errorHandler, validationUtils, miscUtils, timeUtils
│   └── lib/
│       ├── prisma.ts        # Database client (pg adapter, PIPS_DB_POOL_MAX pool ceiling)
│       ├── worker-registry.ts # Tracks every cron/interval worker for /health/ready + coordinated shutdown
│       ├── alert.ts         # Opt-in Discord/Slack webhook for unrecoverable events (no-op if PIPS_ALERT_WEBHOOK_URL unset)
│       ├── pyth.ts          # Pyth price reads
│       ├── price-cache.ts   # In-memory price cache
│       ├── game-price.ts    # gameSpot: eased on-chain market spot (the chart feed)
│       ├── binance-ws.ts    # Shared Binance aggTrade WS (chart MOTION, display-only, L-015)
│       ├── price-bus.ts     # displaySpot: Binance motion EMA-pinned to the on-chain market spot
│       └── sui/             # client, predict-real + config-real + deployed-real.testnet.json (Mysten's Predict), markets, math, signer, privy, dusdc, gas, sponsor, execute, config
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

Error logs are automatically capped at 10,000 records by the cleanup worker.

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

**Registration in `index.ts`:**
```ts
import { adminRoutes } from './src/routes/adminRoutes.ts';
import { userRoutes } from './src/routes/userRoutes.ts';

fastify.register(adminRoutes, { prefix: '/admin' });
fastify.register(userRoutes, { prefix: '/user' });
```

---

## Worker Pattern (`src/workers/`)

Workers use `node-cron` with an `isRunning` flag to prevent double execution:

```ts
import cron from 'node-cron';

let isRunning = false;

const myTask = async (): Promise<void> => {
  if (isRunning) {
    console.log('[MyWorker] Previous run still active, skipping...');
    return;
  }

  isRunning = true;
  try {
    // Do work
  } catch (error) {
    console.error('[MyWorker] Error:', error);
  } finally {
    isRunning = false;
  }
};

export const startMyWorker = (): void => {
  console.log('[MyWorker] Scheduled');
  cron.schedule('*/5 * * * *', myTask); // Every 5 minutes
  myTask(); // Optional: run immediately on startup
};
```

**Register in `index.ts`:**
```ts
import { startMyWorker } from './src/workers/myWorker.ts';

const start = async (): Promise<void> => {
  startMyWorker();
  // ...
};
```

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

External service integrations go in `src/lib/`:

```
src/lib/
├── prisma.ts       # Database
└── sui/            # Sui client, signature verify, DeepBook Predict reads
```

Example structure:
```ts
// src/lib/sui/verify.ts
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';

// Throws if the signature does not match `address`. Wrap in try/catch, a throw means auth failed.
export const verifyWalletSignature = async (message: string, signature: string, address: string) => {
  const bytes = new TextEncoder().encode(message);
  return verifyPersonalMessageSignature(bytes, signature, { address });
};
```

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
| Add new route group | Create file in `src/routes/`, register in `index.ts` |
| Add background job | Create file in `src/workers/`, use `isRunning` flag |
| Add external integration | Create folder in `src/lib/` |
| Protect route | Add `{ preHandler: [authMiddleware] }` |
| Lint | Run `bun run lint` |
