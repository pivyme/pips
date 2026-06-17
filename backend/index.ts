import './dotenv.ts';

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import FastifyCors from '@fastify/cors';
import { APP_PORT, IS_PROD, ALLOWED_ORIGIN } from './src/config/main-config.ts';

// Routes
import { exampletRoute } from './src/routes/exampleRoutes.ts';

// Workers
import { startErrorLogCleanupWorker } from './src/workers/errorLogCleanup.ts';
import { startPricePusher } from './src/workers/price-pusher.ts';
import { startOracleRoll } from './src/workers/oracle-roll.ts';
import { startSettleWorker } from './src/workers/settle.ts';

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

const start = async (): Promise<void> => {
  try {
    // Start workers
    startErrorLogCleanupWorker();
    // Predict operator: roll the oracle ladder, keep prices fresh, settle expiries.
    // All three no-op unless PIPS_OPERATOR_ENABLED=true (they spend testnet gas).
    startOracleRoll();
    startPricePusher();
    startSettleWorker();

    await fastify.listen({
      port: APP_PORT,
      host: '0.0.0.0',
    });

    const address = fastify.server.address();
    const port = typeof address === 'object' && address ? address.port : APP_PORT;

    console.log(`Server started successfully on port ${port}`);
    console.log(`http://localhost:${port}`);
  } catch (error) {
    console.log('Error starting server: ', error);
    process.exit(1);
  }
};

start();
