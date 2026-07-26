// Prunes the legacy ErrorLog table. Age-based off the `retention.error_days` setting, not count-based:
// a count cap silently drops the oldest occurrence of a rare-but-critical bug the moment a noisy bug
// floods the table, which is exactly backwards. See bigdev/plans/cont/03-ADMIN-DASHBOARD.md §9.
//
// ErrorLog itself survives one release for history, then this worker folds into workers/analytics.ts.

import cron from 'node-cron';
import { prismaQuery } from '../lib/prisma.ts';
import { ERROR_LOG_CLEANUP_INTERVAL } from '../config/main-config.ts';
import { getSetting } from '../config/admin-settings.ts';
import { cronIntervalMs, recordRun, registerWorker } from '../lib/worker-registry.ts';

let isRunning = false;

const cleanupErrorLogs = async (): Promise<void> => {
  if (isRunning) {
    console.log('[ErrorLogCleanup] Previous cleanup still running, skipping...');
    return;
  }

  isRunning = true;
  const startedAt = Date.now();
  let runErr: unknown = null;

  try {
    const days = await getSetting('retention.error_days');
    const cutoff = new Date(Date.now() - days * 86_400_000);

    const { count } = await prismaQuery.errorLog.deleteMany({ where: { createdAt: { lt: cutoff } } });

    if (count > 0) console.log(`[ErrorLogCleanup] Deleted ${count} error logs older than ${days}d`);
  } catch (error) {
    runErr = error;
    console.error('[ErrorLogCleanup] Error during cleanup:', error);
  } finally {
    isRunning = false;
    recordRun('error-log-cleanup', !runErr, Date.now() - startedAt, runErr);
  }
};

export const startErrorLogCleanupWorker = (): void => {
  console.log(`[ErrorLogCleanup] Worker scheduled: ${ERROR_LOG_CLEANUP_INTERVAL}`);

  const task = cron.schedule(ERROR_LOG_CLEANUP_INTERVAL, cleanupErrorLogs);
  registerWorker('error-log-cleanup', task, cronIntervalMs(ERROR_LOG_CLEANUP_INTERVAL));

  // Run initial cleanup on startup
  cleanupErrorLogs();
};
