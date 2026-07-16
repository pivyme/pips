import './dotenv.ts';

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import FastifyCors from '@fastify/cors';
import FastifyWebsocket from '@fastify/websocket';
import FastifyRateLimit from '@fastify/rate-limit';
import FastifyHelmet from '@fastify/helmet';
import { APP_PORT, IS_PROD, ALLOWED_ORIGIN, IS_REAL_PREDICT, SHUTDOWN_TIMEOUT_MS, RATE_LIMIT_WINDOW, RATE_LIMIT_GLOBAL_MAX } from './src/config/main-config.ts';
import { NETWORK, PUBLIC_PREDICT_PACKAGE, PUBLIC_PREDICT_OBJECT, DUSDC_TYPE } from './src/lib/sui/config.ts';
import { verifyRealDeployment } from './src/lib/sui/config-real.ts';
import { prismaQuery } from './src/lib/prisma.ts';
import { allWorkerHealth, stopAllWorkers } from './src/lib/worker-registry.ts';
import { acquireLeaderLock, releaseLeaderLock, isOperatorLeader } from './src/lib/leader-lock.ts';
import { alert } from './src/lib/alert.ts';

// Routes
import { exampletRoute } from './src/routes/exampleRoutes.ts';
import { authRoutes } from './src/routes/authRoutes.ts';
import { gameRoutes } from './src/routes/gameRoutes.ts';
import { streamRoutes } from './src/routes/streamRoutes.ts';
import { wsRoutes } from './src/routes/wsRoutes.ts';
import { menuRoutes } from './src/routes/menuRoutes.ts';
import { leaderboardRoutes } from './src/routes/leaderboardRoutes.ts';
import { walletRoutes } from './src/routes/walletRoutes.ts';
import { referralRoutes } from './src/routes/referralRoutes.ts';

// Workers
import { startErrorLogCleanupWorker } from './src/workers/errorLogCleanup.ts';
import { startPricePusher } from './src/workers/price-pusher.ts';
import { startOracleRoll } from './src/workers/oracle-roll.ts';
import { startSettleWorker } from './src/workers/settle.ts';
import { startMarketSync } from './src/workers/market-sync.ts';
import { startPriceWarmer } from './src/workers/price-warmer.ts';
import { startOpsFunding } from './src/workers/ops-funding.ts';
import { startDevnetFaucet } from './src/workers/devnet-faucet.ts';
import { startDeployWatch } from './src/workers/deploy-watch.ts';
import { startBinance } from './src/lib/binance-ws.ts';

// Ops-wallet funding (operator-driven): seeds/tops up the sponsor (SUI), settlement (SUI), and
// treasury (SUI + DUSDC reserve) wallets so plays, redeems, and chip payouts never stall.
import { ensureOpsFunded } from './src/lib/sui/gas.ts';
import { SPONSOR_ENABLED, sponsorAddress, ensureSponsorAccumulator } from './src/lib/sui/sponsor.ts';
import { treasuryAddress } from './src/lib/sui/signer.ts';
import { startSponsorMonitor } from './src/lib/sui/play-safety.ts';
import { SPONSOR_FLOOR_SUI, TREASURY_MIN_DUSDC, MIN_STAKE, MAX_STAKE } from './src/config/main-config.ts';

console.log(
  '======================\n======================\nMY BACKEND SYSTEM STARTED!\n======================\n======================\n'
);

const fastify = Fastify({
  // Structured per-request access log (method, url, status, response time, a request id) with no per-route
  // churn. Redact the auth-bearing headers so a token never lands in a log line. Existing console.* call
  // sites stay as-is; this adds the HTTP access log + request-id, not a logging rewrite.
  logger: {
    level: IS_PROD ? 'info' : 'debug',
    redact: { paths: ['req.headers.authorization', 'req.headers.token', 'req.headers.cookie'], remove: true },
  },
  // Dokploy fronts services with one Traefik hop, so trust one proxy hop: rate-limit keys and
  // errorHandler.ts's logged `ip` then reflect the real client IP (X-Forwarded-For) instead of the
  // proxy's. Revisit to a specific hop count if a CDN is ever added in front of Traefik.
  trustProxy: true,
  // Explicit 1MB request-body ceiling (matches Fastify's own default, made a conscious choice). No route
  // here takes file/blob uploads (confirmed across every route file); if one ever does, it gets its own
  // larger per-route limit, not a global bump.
  bodyLimit: 1_000_000,
});

// === Process resilience: crash handlers + graceful shutdown ===
// A redeploy sends SIGTERM; without a handler every in-flight HTTP/WS connection was hard-dropped. An
// uncaughtException / unhandledRejection leaves the process in an unknown state, so the only safe move is
// a clean, bounded exit and let the container restart policy bring up a fresh, known-good process. Both
// paths funnel through one drain routine bounded by SHUTDOWN_TIMEOUT_MS.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining...`);
  const hardExit = setTimeout(() => {
    console.error(`[shutdown] drain exceeded ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  hardExit.unref();
  try {
    stopAllWorkers(); // stop cron/interval/socket workers; in-flight runs finish under their own guard
    await releaseLeaderLock(); // hand operator leadership to the next instance before we finish draining
    await fastify.close(); // drain HTTP + WS connections, run registered onClose hooks
    await prismaQuery.$disconnect();
    console.log('[shutdown] drained cleanly');
  } catch (e) {
    console.error('[shutdown] error while draining:', e instanceof Error ? e.message : e);
  } finally {
    clearTimeout(hardExit);
    process.exit(signal === 'FATAL' ? 1 : 0);
  }
}

function handleFatal(kind: string, err: unknown): void {
  console.error(`\n[FATAL] ${kind}:`, err instanceof Error ? (err.stack ?? err.message) : err);
  // Notify a human before we exit: the container restart brings up a fresh process, but a crash loop is
  // invisible without this. No-op unless a webhook is configured; can't throw (would re-enter here).
  alert('critical', `process crashed (${kind}), restarting`, { error: err instanceof Error ? err.message : String(err) });
  void shutdown('FATAL');
}

process.on('uncaughtException', (err) => handleFatal('uncaughtException', err));
process.on('unhandledRejection', (reason) => handleFatal('unhandledRejection', reason));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Boot-time DB readiness: don't start workers (they hit the DB) or serve traffic until Postgres answers.
// Covers a cold stack where the app container starts before the DB. Retry with backoff; on exhaustion
// exit non-zero and let the restart policy retry the whole boot rather than serving a broken instance.
async function waitForDb(): Promise<void> {
  const backoffs = [1000, 2000, 4000, 8000, 16000];
  for (let attempt = 0; ; attempt++) {
    try {
      await prismaQuery.$queryRaw`SELECT 1`;
      if (attempt > 0) console.log(`[boot] database ready after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}`);
      return;
    } catch (e) {
      if (attempt >= backoffs.length) {
        console.error('[boot] database unreachable after retries, exiting:', e instanceof Error ? e.message : e);
        process.exit(1);
      }
      const wait = backoffs[attempt];
      console.warn(`[boot] database not ready (attempt ${attempt + 1}), retrying in ${wait}ms:`, e instanceof Error ? e.message : e);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// Production CORS locks to an explicit allow-list. ALLOWED_ORIGIN is comma-separated so the apex and
// www (and any preview/staging origin) all pass. Dev stays open. Auth is a Bearer token, and SSE uses
// a ?t= query (EventSource can't set headers), not cookies, so we don't enable credentials.
const corsOrigins = ALLOWED_ORIGIN.split(',')
  .map((o) => o.trim())
  .filter(Boolean);
if (IS_PROD && corsOrigins.length === 0) {
  // Fail fast, not warn-and-drift: a prod backend that blocks 100% of cross-origin frontend requests is
  // not meaningfully "up". Better to abort the deploy loudly than serve every request into a CORS wall.
  console.error(
    'FATAL: NODE_ENV=production but ALLOWED_ORIGIN is empty: every cross-origin frontend request would be blocked. Set ALLOWED_ORIGIN to your frontend origin(s).',
  );
  process.exit(1);
}
fastify.register(FastifyCors, {
  origin: IS_PROD ? corsOrigins : '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'token'],
});

// Security headers. This is a pure JSON API serving no HTML, so CSP has no target and only risks
// breaking things for no benefit (off). COEP/CORP defaults are meant for browser-rendered content and
// would fight the web app's cross-origin fetches, so allow cross-origin resource policy (the actual
// origin allow-list is CORS above). The rest of helmet's defaults stay on: X-Content-Type-Options,
// X-Frame-Options, and HSTS (meaningful because Traefik terminates TLS in front of this).
fastify.register(FastifyHelmet, {
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});

// Transport-layer rate limiting, keyed by the real client IP (trustProxy above). Generous global default
// so the fast gameplay loop is never throttled; tighter per-route caps live on the auth/wallet routes via
// their `config.rateLimit`. Registered before the routes so its onRoute hook covers them. 429s return the
// app's standard error envelope. Health probes opt out (config.rateLimit:false) so an orchestrator poll
// is never throttled into a false "unhealthy".
fastify.register(FastifyRateLimit, {
  global: true,
  max: RATE_LIMIT_GLOBAL_MAX,
  timeWindow: RATE_LIMIT_WINDOW,
  errorResponseBuilder: (_req, context) => {
    // The plugin THROWS this value; Fastify reads `statusCode` off the thrown object for the HTTP code
    // (a plain object without it defaults to 500). Keep it non-enumerable so the JSON body stays exactly
    // the app's standard { success, error, data } envelope.
    const body = {
      success: false,
      error: { code: 'RATE_LIMITED', message: `Too many requests. Retry in ${Math.ceil(context.ttl / 1000)}s.` },
      data: null,
    };
    Object.defineProperty(body, 'statusCode', { value: context.statusCode, enumerable: false });
    return body;
  },
});

// WebSocket support for the price hub (/ws). Registered before the routes that use `{websocket:true}`.
// Verified on the Bun runtime; the SSE /stream/prices route stays as a flagged fallback for one release.
fastify.register(FastifyWebsocket);

// Health check endpoint
fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
  return reply.status(200).send({
    success: true,
    message: 'Hello there!',
    error: null,
    data: null,
  });
});

// Liveness: always 200 if the process can respond at all. No dependency checks, so it can never itself
// get stuck. This is what the container orchestrator (Docker HEALTHCHECK) polls every 30s: a hung
// dependency must NOT bounce an otherwise-alive instance and drop every in-flight connection with it.
fastify.get('/health', { config: { rateLimit: false } }, async (_request: FastifyRequest, reply: FastifyReply) => {
  return reply.status(200).send({
    success: true,
    error: null,
    data: { uptime: Math.round(process.uptime()), shuttingDown },
  });
});

// Bounded DB ping for readiness. Races SELECT 1 against a short timeout so a wedged connection can't hang
// the endpoint (which would otherwise make the orchestrator's readiness probe itself time out).
async function pingDb(timeoutMs = 2000): Promise<boolean> {
  try {
    await Promise.race([
      prismaQuery.$queryRaw`SELECT 1`,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('db ping timeout')), timeoutMs)),
    ]);
    return true;
  } catch {
    return false;
  }
}

// Readiness: reports whether this instance can actually serve. DB down => 503 (the one case an
// orchestrator should stop routing traffic here). A stale non-critical worker sets `degraded` but stays
// 200: a wedged price-warmer must not bounce a healthy API instance, it should just be visible so a
// human or the alert path can look. A worker is stale once it hasn't run in ~3x its own cadence.
fastify.get('/health/ready', { config: { rateLimit: false } }, async (_request: FastifyRequest, reply: FastifyReply) => {
  const now = Date.now();
  const dbOk = await pingDb();
  const workers = allWorkerHealth().map((w) => ({
    ...w,
    stale: w.intervalMs != null && w.lastRunAt != null && now - w.lastRunAt > 3 * w.intervalMs,
  }));
  const degraded = !dbOk || workers.some((w) => w.stale);
  return reply.status(dbOk ? 200 : 503).send({
    success: dbOk,
    error: null,
    data: { db: dbOk ? 'ok' : 'down', workers, degraded },
  });
});

// Public deploy config. The frontend fetches this at boot so the DUSDC coin type (and explorer ids)
// follow the live deployment without a rebuild: after a devnet wipe the client re-reads the new type
// instead of showing a stale balance. Unauthenticated on purpose (read-only, the client needs it pre-login).
fastify.get('/config', async (_request: FastifyRequest, reply: FastifyReply) => {
  return reply.status(200).send({
    success: true,
    error: null,
    data: {
      network: NETWORK,
      predictPackageId: PUBLIC_PREDICT_PACKAGE,
      predictId: PUBLIC_PREDICT_OBJECT,
      dusdcType: DUSDC_TYPE,
      // Stake band the play endpoints enforce. The client sizes its bet ladder to this so it never
      // offers an out-of-band bet (testnet-real is a tight 1.5..3, the fork is a wide 1..100).
      minStake: MIN_STAKE,
      maxStake: MAX_STAKE,
    },
  });
});

// Register routes with prefixes
// Example: fastify.register(adminRoutes, { prefix: '/admin' })
// Example: fastify.register(userRoutes, { prefix: '/user' })
fastify.register(exampletRoute, { prefix: '/example' });
fastify.register(authRoutes, { prefix: '/auth' });
fastify.register(gameRoutes);
fastify.register(menuRoutes);
fastify.register(leaderboardRoutes, { prefix: '/leaderboard' });
fastify.register(walletRoutes, { prefix: '/wallet' });
fastify.register(referralRoutes, { prefix: '/referral' });
fastify.register(streamRoutes, { prefix: '/stream' });
// Price hub at /ws (no prefix): one shared 10Hz broadcast loop per asset, all users in lock-step.
fastify.register(wsRoutes);

const start = async (): Promise<void> => {
  try {
    // Confirm Postgres is reachable before starting DB-touching workers or serving. Exits + lets the
    // container restart if the DB never comes up, instead of booting into a broken state.
    await waitForDb();

    // Operator leader election (advisory lock). Attempted only when OPERATOR_ENABLED; if another
    // instance already holds it, this one boots as a plain follower (isOperatorLeader() stays false, so
    // the fund-moving workers below never start). Awaited before any worker starts so every gate reads
    // the settled leadership state. Follower-only instances skip it entirely.
    await acquireLeaderLock();

    // Start workers
    startErrorLogCleanupWorker();

    // Real mode (testnet): confirm Mysten's configured Predict objects still exist before serving, so
    // a Mysten redeploy shows a clear STALE ID error in the logs instead of every play failing opaquely.
    // Non-fatal: the app still boots (demo mode survives) and the log points at the fix.
    if (IS_REAL_PREDICT) {
      void verifyRealDeployment().catch((e) =>
        console.warn('[predict-real] deployment verify errored:', e instanceof Error ? e.message : e),
      );
      // Real-mode wallets are hand-funded (no faucet, no DUSDC mint, L-008). Print the exact addresses
      // to top up so funding is never a guessing game: treasury holds the DUSDC chip reserve, sponsor
      // holds the SUI that pays every play's gas. Both auto-recover once funded (treasury payout retries,
      // sponsor monitor resumes plays), so this is the whole manual-funding runbook in one log line.
      console.log('[predict-real] hand-funded wallets (transfer testnet funds to these to enable plays):');
      console.log(`  treasury (DUSDC chips, keep >= ${TREASURY_MIN_DUSDC} DUSDC): ${treasuryAddress || '(TREASURY_WALLET_PK unset -> chips fall back to operator)'}`);
      console.log(`  sponsor  (SUI gas,     keep >= ${SPONSOR_FLOOR_SUI} SUI)  : ${sponsorAddress || '(GAS_SPONSORSHIP_WALLET_PK unset -> plays not sponsored)'}`);
    }

    // Ops wallets: the operator seeds/tops up the sponsor (SUI), settlement (SUI), and treasury
    // (SUI + DUSDC reserve) on boot so the first play, redeem, and chip payout don't stall. Behind the
    // operator leader lock so only the single leader funds it. Best-effort: warn and continue (each step
    // is independently guarded inside ensureOpsFunded; already-funded wallets just no-op).
    if (isOperatorLeader()) {
      try {
        await ensureOpsFunded();
      } catch (e) {
        console.warn('[ops-funding] boot funding failed (plays/payouts may stall until funded):', e instanceof Error ? e.message : e);
      }
    }

    // The gas sponsor's address-balance accumulator funds every privy play, and unlike the operator
    // ops wallets a FOLLOWER can keep it topped up itself (the deposit is sponsor-signed), so warm it
    // up here regardless of OPERATOR_ENABLED. Fire-and-forget so it never delays serving; if it can't
    // land now, the first play that hits an empty accumulator self-heals + retries (execute.ts).
    if (SPONSOR_ENABLED) {
      void ensureSponsorAccumulator().catch((e) =>
        console.warn('[sponsor] boot accumulator warm-up failed (self-heals on first play):', e instanceof Error ? e.message : e),
      );
    }

    // Fork mode only (localnet/devnet): roll our own oracle ladder, push our own prices, and run the
    // devnet self-heal safety nets (faucet top-up + wipe-recovery restart). On testnet Mysten owns the
    // market roll and price feed and there is no fork deployment to self-publish, so these are pure
    // dead weight there, skip starting them entirely instead of relying on each one's internal no-op.
    if (!IS_REAL_PREDICT) {
      startOracleRoll();
      startPricePusher();
      startDevnetFaucet();
      startDeployWatch();
    }
    startSettleWorker();
    // Follower mode (operator disabled): learn the live oracle set from chain so the games are
    // playable against the deployed operator without running the operator workers here.
    startMarketSync();
    // Ongoing top-up safety net for the sponsor + settlement + treasury wallets (operator only).
    startOpsFunding();
    // Real mode (testnet): watch the sponsor's finite SUI reserve and pause new plays before it runs
    // dry (clear user state, auto-resume on top-up), and log burn rate. No-op off testnet / no sponsor.
    startSponsorMonitor();
    // Realtime chart display feed: one shared Binance aggTrade socket the price bus pins to the on-chain
    // oracle. No-op off testnet / when disabled; any outage degrades to the on-chain fallback (L-015).
    startBinance();
    // Keeps every display asset's Pyth spot pre-warmed so a cold WS asset loop never blocks its first
    // broadcast on a live Hermes fetch (the LUCKY non-BTC reel-lag fix). Runs on every instance, no
    // shared state, so it's always on regardless of OPERATOR_ENABLED/IS_REAL_PREDICT.
    startPriceWarmer();

    await fastify.listen({
      port: APP_PORT,
      host: '0.0.0.0',
    });

    const address = fastify.server.address();
    const port = typeof address === 'object' && address ? address.port : APP_PORT;

    console.log(`Server started successfully on port ${port}`);
    console.log(`http://localhost:${port}`);

    // Loud, dev-only notice that the review-harness auth bypass is live. Refused under prod.
    if (!IS_PROD && process.env.TESTING_TOKEN) {
      console.warn('[TESTING_TOKEN] dev auth bypass ENABLED. Any Bearer == TESTING_TOKEN resolves to the dev user. Never ship this token.');
    }
  } catch (error) {
    console.log('Error starting server: ', error);
    process.exit(1);
  }
};

start();
