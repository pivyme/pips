// Sweeps abandoned deposit-tracking rows (mainnet only). /deposit/execute-quote opens a PENDING row before
// the user broadcasts, so a confirm they never sign leaves a row with a null txHash. A real bridge lands in
// under ~20min and the balance live-reads chain either way, so a null-txHash PENDING row past DEPOSIT_STALE_HOURS
// is dead weight and gets deleted. Never touches a row that has a txHash (that one is a real, pollable deposit).

import cron from 'node-cron';
import { prismaQuery } from '../lib/prisma.ts';
import { DEPOSIT_CLEANUP_CRON, DEPOSIT_STALE_HOURS } from '../config/main-config.ts';
import { cronIntervalMs, recordRun, registerWorker } from '../lib/worker-registry.ts';

let isRunning = false;

const cleanupDeposits = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;
  const startedAt = Date.now();
  let runErr: unknown = null;

  try {
    const cutoff = new Date(Date.now() - DEPOSIT_STALE_HOURS * 3_600_000);
    const { count } = await prismaQuery.deposit.deleteMany({
      where: { status: 'PENDING', txHash: null, createdAt: { lt: cutoff } },
    });
    if (count > 0) console.log(`[DepositCleanup] Swept ${count} abandoned deposit rows (null txHash, > ${DEPOSIT_STALE_HOURS}h old)`);
  } catch (error) {
    runErr = error;
    console.error('[DepositCleanup] Error during cleanup:', error);
  } finally {
    isRunning = false;
    recordRun('deposit-cleanup', !runErr, Date.now() - startedAt, runErr);
  }
};

export const startDepositCleanupWorker = (): void => {
  console.log(`[DepositCleanup] Worker scheduled: ${DEPOSIT_CLEANUP_CRON}`);
  const task = cron.schedule(DEPOSIT_CLEANUP_CRON, cleanupDeposits);
  registerWorker('deposit-cleanup', task, cronIntervalMs(DEPOSIT_CLEANUP_CRON));
  cleanupDeposits();
};
