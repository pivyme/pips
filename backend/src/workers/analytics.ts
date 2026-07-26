// The analytics worker: evaluates the ops detectors on a cadence and sends the nightly digest.
//
// The detectors are the early-warning system behind the Overview banner (§6). They run here rather than on
// page load so a dashboard visit never costs twelve queries, and so an alert fires whether or not anyone
// happens to be looking. Alerting is on the TRANSITION into critical plus once on recovery, which is
// decided in evaluateDetectors, never here.

import cron from 'node-cron';

import { buildNightlyDigest, evaluateDetectors, refreshBalanceSnapshot } from '../services/insights.ts';
import { alert } from '../lib/alert.ts';
import { cronIntervalMs, recordRun, registerWorker } from '../lib/worker-registry.ts';

const DETECTOR_CRON = '* * * * *'; // every minute: fine enough for a 2-minute "no live markets" threshold
const DIGEST_CRON = '0 9 * * *'; // 09:00 UTC daily
const BALANCE_CRON = '*/15 * * * *'; // total user chips is a chain read per user, so never on page load

let isRunning = false;

const detectorTask = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;
  const startedAt = Date.now();
  let runErr: unknown = null;
  try {
    const snap = await evaluateDetectors();
    if (snap.worst !== 'ok') {
      const bad = snap.detectors.filter((d) => d.level !== 'ok');
      console.warn(`[Analytics] ops ${snap.worst}: ${bad.map((d) => `${d.title} ${d.display}`).join(', ')}`);
    }
  } catch (err) {
    runErr = err;
    console.error('[Analytics] detector sweep failed:', err instanceof Error ? err.message : err);
  } finally {
    isRunning = false;
    recordRun('analytics', !runErr, Date.now() - startedAt, runErr);
  }
};

const digestTask = async (): Promise<void> => {
  const startedAt = Date.now();
  let runErr: unknown = null;
  try {
    const digest = await buildNightlyDigest();
    // Not urgent enough to page, which is exactly why it needs a scheduled read rather than a threshold.
    if (digest) alert('warn', `nightly error digest\n${digest}`, undefined, 'ops:digest');
  } catch (err) {
    runErr = err;
    console.error('[Analytics] nightly digest failed:', err instanceof Error ? err.message : err);
  } finally {
    recordRun('analytics-digest', !runErr, Date.now() - startedAt, runErr);
  }
};

// The Overview's money block. Slow by nature (one chain read per user plus the ops wallets), which is
// exactly why it is a cron writing one row and the page renders it with an "as of" rather than waiting.
let balanceRunning = false;

const balanceTask = async (): Promise<void> => {
  if (balanceRunning) return;
  balanceRunning = true;
  const startedAt = Date.now();
  let runErr: unknown = null;
  try {
    await refreshBalanceSnapshot();
  } catch (err) {
    runErr = err;
    console.error('[Analytics] balance sweep failed:', err instanceof Error ? err.message : err);
  } finally {
    balanceRunning = false;
    recordRun('analytics-balances', !runErr, Date.now() - startedAt, runErr);
  }
};

export const startAnalyticsWorker = (): void => {
  const task = cron.schedule(DETECTOR_CRON, detectorTask);
  registerWorker('analytics', task, cronIntervalMs(DETECTOR_CRON));
  const digest = cron.schedule(DIGEST_CRON, digestTask);
  registerWorker('analytics-digest', digest, cronIntervalMs(DIGEST_CRON));
  const balances = cron.schedule(BALANCE_CRON, balanceTask);
  registerWorker('analytics-balances', balances, cronIntervalMs(BALANCE_CRON));
  void detectorTask(); // paint the banner from real data on the first page load after a boot
  void balanceTask();
};
