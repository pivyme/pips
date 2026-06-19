# Backend Development Guidelines

## CRITICAL DATABASE WARNING

**NEVER EVER run any Prisma command that will reset/wipe the database.** If schema changes are needed, tell the user to run `bun run db:push` themselves. Commands like `prisma migrate reset`, `prisma db push --force-reset`, or any destructive database operations are strictly forbidden.

---

## Pips context

This is the **Pips** backend (gamified trading on Sui via DeepBook Predict). Read the root [`../CLAUDE.md`](../CLAUDE.md) for product and Sui stack context. Its job: auth (Privy + a dev auto-login), game engine, the Predict operator (price-pusher, oracle ladder, settle), indexing, and server-signing the user's plays (`@privy-io/node` `rawSign` under a session signer; dev = the operator key).

**The chain is our own Sui localnet, not testnet.** It is deployed and live at `https://rpc.playpips.fun`. `scripts/bootstrap.ts` is network-aware via `SUI_NETWORK` and is driven by the repo-root `scripts/localnet.sh` (`setup` once, `redeploy` after any `contracts/` change). It writes the deployed ids into `src/lib/sui/deployed.localnet.json` (gitignored, read via `src/lib/sui/config.ts`) and the headline ids into `.env`. Runtime RPC is `SUI_FULLNODE_URL` (the proxied url); `PIPS_DEPLOY_RPC` is the gRPC origin the CLI publishes through. See "The chain" in the root CLAUDE.md for the gRPC-origin gotcha. Never hardcode ids.

**v1 build:** planned in [`../bigdev/plans/`](../bigdev/plans/). Read `05-SUI-PREDICT.md` (we publish + operate our own Predict instance: the verified bootstrap recipe, the wrappers, and the price-pusher / oracle-roll / settle workers), `02-API.md` (routes + SSE streams), `03-DATABASE.md` (schema + seed), `LUCKY.md` §6 (dev + Privy auth, the current source of truth; `04-AUTH.md` keeps the JWT plumbing + onboarding). All Sui ids come from config, never hardcode.

**Sui (verified mid 2026, reconfirm before coding):**
- Use `@mysten/sui` (v2.x, ESM only). RPC via `SuiGrpcClient` (`@mysten/sui/grpc`) preferred, `SuiClient` is legacy.
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
bun run bootstrap    # Publish + seed our Predict deployment, writes deployed.json
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
├── index.ts                 # Entry point - registers all routes & workers
├── dotenv.ts                # Environment loader (imported first, before any module)
├── prisma/
│   ├── schema.prisma        # Database schema
│   └── seed.ts              # Seed data (bun run db:seed)
├── scripts/
│   └── bootstrap.ts         # Publishes + seeds our Predict deployment (bun run bootstrap)
├── src/
│   ├── config/main-config.ts    # Centralized env config (import from here, not process.env)
│   ├── routes/              # Fastify plugins, grouped by prefix
│   │   ├── authRoutes.ts    # /auth: dev login, privy/verify, me
│   │   ├── gameRoutes.ts    # /games/* play, /plays/* confirm + cashout
│   │   ├── menuRoutes.ts    # /stats, /achievements, /settings
│   │   ├── streamRoutes.ts  # SSE: /stream/prices, /stream/plays/:id
│   │   └── exampleRoutes.ts # starter sample
│   ├── services/            # Business logic, called by routes
│   │   └── auth, games, plays, stats, achievements, rng (+ *.test.ts)
│   ├── workers/             # node-cron jobs (isRunning guard)
│   │   ├── price-pusher.ts  # pushes oracle prices for short-expiry markets
│   │   ├── oracle-roll.ts   # rolls the oracle ladder forward
│   │   ├── settle.ts        # settles expired plays
│   │   └── errorLogCleanup.ts (+ exampleWorkers.ts)
│   ├── middlewares/authMiddleware.ts
│   ├── types/api.ts         # DTO contract (mirrors web/src/lib/api.ts)
│   ├── utils/               # errorHandler, validationUtils, miscUtils, timeUtils
│   └── lib/
│       ├── prisma.ts        # Database client
│       ├── pyth.ts          # Pyth price reads
│       ├── price-cache.ts   # In-memory price cache
│       └── sui/             # client, predict, solver, markets, math, signer, privy, dusdc, gas, execute, config, deployed.json
```

---

## Configuration (`src/config/main-config.ts`)

All commonly used environment variables are centralized here. Import from config instead of using `process.env` directly:

```ts
import { JWT_SECRET, APP_PORT, IS_DEV } from '../config/main-config.ts';
```

**Available exports:**
- `APP_PORT: number` - Server port (default: 3780)
- `NODE_ENV: string` - Environment mode
- `IS_DEV: boolean` / `IS_PROD: boolean` - Boolean flags
- `DATABASE_URL: string` - Database connection string
- `JWT_SECRET: string` - JWT signing secret
- `JWT_EXPIRES_IN: string` - Token expiration (default: '7d')
- `ERROR_LOG_MAX_RECORDS: number` - Max error logs (default: 10000)

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
