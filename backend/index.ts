import './dotenv.ts';

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import FastifyCors from '@fastify/cors';
import { APP_PORT, IS_PROD, ALLOWED_ORIGIN, OPERATOR_ENABLED } from './src/config/main-config.ts';

// Routes
import { exampletRoute } from './src/routes/exampleRoutes.ts';
import { authRoutes } from './src/routes/authRoutes.ts';
import { gameRoutes } from './src/routes/gameRoutes.ts';
import { streamRoutes } from './src/routes/streamRoutes.ts';
import { menuRoutes } from './src/routes/menuRoutes.ts';
import { walletRoutes } from './src/routes/walletRoutes.ts';

// Workers
import { startErrorLogCleanupWorker } from './src/workers/errorLogCleanup.ts';
import { startPricePusher } from './src/workers/price-pusher.ts';
import { startOracleRoll } from './src/workers/oracle-roll.ts';
import { startSettleWorker } from './src/workers/settle.ts';
import { startMarketSync } from './src/workers/market-sync.ts';

// Gas sponsor funding (operator-driven, seeds the sponsor's SUI address balance)
import { ensureSponsorFunded } from './src/lib/sui/gas.ts';

console.log(
  '======================\n======================\nMY BACKEND SYSTEM STARTED!\n======================\n======================\n'
);

const fastify = Fastify({
  logger: false,
});

fastify.register(FastifyCors, {
  origin: IS_PROD ? ALLOWED_ORIGIN : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
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

// Register routes with prefixes
// Example: fastify.register(adminRoutes, { prefix: '/admin' })
// Example: fastify.register(userRoutes, { prefix: '/user' })
fastify.register(exampletRoute, { prefix: '/example' });
fastify.register(authRoutes, { prefix: '/auth' });
fastify.register(gameRoutes);
fastify.register(menuRoutes);
fastify.register(walletRoutes, { prefix: '/wallet' });
fastify.register(streamRoutes, { prefix: '/stream' });

const start = async (): Promise<void> => {
  try {
    // Start workers
    startErrorLogCleanupWorker();

    // Gas sponsor: the operator seeds/tops up the sponsor's SUI address balance so every privy play
    // is gasless for the user. Behind OPERATOR_ENABLED so only the leader funds it. Best-effort:
    // warn and continue (a non-sponsored or already-funded backend just no-ops).
    if (OPERATOR_ENABLED) {
      try {
        await ensureSponsorFunded();
      } catch (e) {
        console.warn('[sponsor] boot funding failed (plays may fail until funded):', e instanceof Error ? e.message : e);
      }
    }

    // Predict operator: roll the oracle ladder, keep prices fresh, settle expiries.
    // All three no-op unless PIPS_OPERATOR_ENABLED=true (they spend testnet gas).
    startOracleRoll();
    startPricePusher();
    startSettleWorker();
    // Follower mode (operator disabled): learn the live oracle set from chain so the games are
    // playable against the deployed operator without running the operator workers here.
    startMarketSync();

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
