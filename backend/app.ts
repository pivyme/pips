import './dotenv.ts';

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import FastifyCors from '@fastify/cors';
import { APP_PORT, IS_PROD, ALLOWED_ORIGIN, OPERATOR_ENABLED } from './src/config/main-config.ts';
import { NETWORK, PACKAGE_ID, PREDICT_ID, DUSDC_TYPE } from './src/lib/sui/config.ts';

// Routes
import { exampletRoute } from './src/routes/exampleRoutes.ts';
import { authRoutes } from './src/routes/authRoutes.ts';
import { gameRoutes } from './src/routes/gameRoutes.ts';
import { streamRoutes } from './src/routes/streamRoutes.ts';
import { menuRoutes } from './src/routes/menuRoutes.ts';
import { leaderboardRoutes } from './src/routes/leaderboardRoutes.ts';
import { walletRoutes } from './src/routes/walletRoutes.ts';

// Workers
import { startErrorLogCleanupWorker } from './src/workers/errorLogCleanup.ts';
import { startPricePusher } from './src/workers/price-pusher.ts';
import { startOracleRoll } from './src/workers/oracle-roll.ts';
import { startSettleWorker } from './src/workers/settle.ts';
import { startMarketSync } from './src/workers/market-sync.ts';
import { startOpsFunding } from './src/workers/ops-funding.ts';
import { startDevnetFaucet } from './src/workers/devnet-faucet.ts';
import { startDeployWatch } from './src/workers/deploy-watch.ts';

// Ops-wallet funding (operator-driven): seeds/tops up the sponsor (SUI), settlement (SUI), and
// treasury (SUI + DUSDC reserve) wallets so plays, redeems, and chip payouts never stall.
import { ensureOpsFunded } from './src/lib/sui/gas.ts';
import { SPONSOR_ENABLED, ensureSponsorAccumulator } from './src/lib/sui/sponsor.ts';

console.log(
  '======================\n======================\nMY BACKEND SYSTEM STARTED!\n======================\n======================\n'
);

const fastify = Fastify({
  logger: false,
});

// Production CORS locks to an explicit allow-list. ALLOWED_ORIGIN is comma-separated so the apex and
// www (and any preview/staging origin) all pass. Dev stays open. Auth is a Bearer token, and SSE uses
// a ?t= query (EventSource can't set headers), not cookies, so we don't enable credentials.
const corsOrigins = ALLOWED_ORIGIN.split(',')
  .map((o) => o.trim())
  .filter(Boolean);
if (IS_PROD && corsOrigins.length === 0) {
  console.warn(
    '[cors] NODE_ENV=production but ALLOWED_ORIGIN is empty: every cross-origin request will be blocked. Set ALLOWED_ORIGIN to your frontend origin(s).',
  );
}
fastify.register(FastifyCors, {
  origin: IS_PROD ? corsOrigins : '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'token'],
});

// Health check endpoint
fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
  return reply.status(200).send({
    success: true,
    message: 'Hello there!',
    error: null,
    data: null,
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
      predictPackageId: PACKAGE_ID,
      predictId: PREDICT_ID,
      dusdcType: DUSDC_TYPE,
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
fastify.register(streamRoutes, { prefix: '/stream' });

const start = async (): Promise<void> => {
  try {
    // Start workers
    startErrorLogCleanupWorker();

    // Ops wallets: the operator seeds/tops up the sponsor (SUI), settlement (SUI), and treasury
    // (SUI + DUSDC reserve) on boot so the first play, redeem, and chip payout don't stall. Behind
    // OPERATOR_ENABLED so only the leader funds it. Best-effort: warn and continue (each step is
    // independently guarded inside ensureOpsFunded; already-funded wallets just no-op).
    if (OPERATOR_ENABLED) {
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

    // Predict operator: roll the oracle ladder, keep prices fresh, settle expiries.
    // All three no-op unless PIPS_OPERATOR_ENABLED=true (they spend testnet gas).
    startOracleRoll();
    startPricePusher();
    startSettleWorker();
    // Follower mode (operator disabled): learn the live oracle set from chain so the games are
    // playable against the deployed operator without running the operator workers here.
    startMarketSync();
    // Ongoing top-up safety net for the sponsor + settlement + treasury wallets (operator only).
    startOpsFunding();
    // Devnet only: keep the crucial wallets (+ extra addresses) funded from the public faucet, so a
    // low balance or a devnet wipe self-heals instead of stalling plays. No-op off devnet.
    startDevnetFaucet();
    // Self-heal: watch the shared DB for a fresh deploy record (a devnet-wipe recovery) and restart
    // this process to adopt the new ids. With a restart-on-exit container (Dokploy default) the box
    // re-points to a fresh deployment on its own, no env paste, no manual redeploy.
    startDeployWatch();

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
