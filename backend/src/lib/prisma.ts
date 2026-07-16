import { PrismaClient } from '../../prisma/generated/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { DB_POOL_MAX } from '../config/main-config.ts';

// The pg adapter builds a node-postgres Pool from this config, so `max` caps this instance's concurrent
// DB connections (sizing guidance lives on DB_POOL_MAX in main-config.ts + 09-DEPLOYMENT.md).
//
// Reconnect behavior (verified against @prisma/adapter-pg 7.8 source, not memory): the pool does NOT
// reconnect a specific dropped client in place. When a pooled connection dies (Postgres restart, network
// blip, idle timeout) the pool discards it and lazily opens a fresh one on the next query, up to `max`,
// so a transient DB drop recovers on its own with no manual retry wrapper on the hot path. The adapter
// attaches an 'error' handler to the pool, so a dropped IDLE connection can't crash the process (the
// classic node-postgres footgun); onPoolError just surfaces it in the logs instead of a debug-only line.
// Cold start ("DB not up yet") is handled separately by the boot readiness ping in app.ts (waitForDb).
const adapter = new PrismaPg(
  { connectionString: process.env.DATABASE_URL, max: DB_POOL_MAX },
  {
    onPoolError: (err: Error) =>
      console.warn('[db] idle pool connection error (pool reconnects on next query):', err.message),
  },
);

export const prismaQuery = new PrismaClient({ adapter });
