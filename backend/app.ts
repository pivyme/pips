import './dotenv.ts';

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import FastifyCors from '@fastify/cors';
import FastifyWebsocket from '@fastify/websocket';
import { APP_PORT, IS_PROD, ALLOWED_ORIGIN, OPERATOR_ENABLED, IS_REAL_PREDICT } from './src/config/main-config.ts';
import { NETWORK, PUBLIC_PREDICT_PACKAGE, PUBLIC_PREDICT_OBJECT, DUSDC_TYPE } from './src/lib/sui/config.ts';
import { verifyRealDeployment } from './src/lib/sui/config-real.ts';

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
