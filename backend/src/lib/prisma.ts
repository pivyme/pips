import { PrismaClient } from '../../prisma/generated/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { DB_POOL_MAX } from '../config/main-config.ts';

// `max` caps this instance's pool (sizing guidance on DB_POOL_MAX in main-config.ts). The pool never
// reconnects a dropped client in place, it discards and lazily reopens on the next query, so a transient DB drop self-heals with no retry wrapper; onPoolError just stops a dropped idle connection from crashing the process. Cold start is handled separately by waitForDb in app.ts.
const adapter = new PrismaPg(
  { connectionString: process.env.DATABASE_URL, max: DB_POOL_MAX },
  {
    onPoolError: (err: Error) =>
      console.warn('[db] idle pool connection error (pool reconnects on next query):', err.message),
  },
);

export const prismaQuery = new PrismaClient({ adapter });
