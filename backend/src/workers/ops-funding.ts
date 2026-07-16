// Keeps the three ops wallets topped up: the gas sponsor (SUI), the settlement wallet (SUI), and the
// treasury (SUI + a big DUSDC reserve). Operator-driven, since only the leader owns the SUI + DUSDC
// TreasuryCap to fund from, so this no-ops unless OPERATOR_ENABLED. Generous amounts (free localnet
// SUI), low cadence: each tick just reads three balances and tops up the shortfall. Boot funding is
// done once in index.ts before serving; this worker is the ongoing safety net.

import cron from 'node-cron';

import { ensureOpsFunded } from '../lib/sui/gas.ts';
import { cronIntervalMs, recordRun, registerWorker } from '../lib/worker-registry.ts';
import { isOperatorLeader } from '../lib/leader-lock.ts';

const OPS_FUNDING_CRON = '*/2 * * * *';

let isRunning = false;

const tick = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;
  const startedAt = Date.now();
  let runErr: unknown = null;
  try {
    await ensureOpsFunded();
  } catch (e) {
    runErr = e;
    console.warn('[ops-funding] tick error:', e instanceof Error ? e.message : e);
  } finally {
    isRunning = false;
    recordRun('ops-funding', !runErr, Date.now() - startedAt, runErr);
  }
};

export const startOpsFunding = (): void => {
  if (!isOperatorLeader()) return; // only the single operator leader funds the ops wallets
  console.log('[ops-funding] Scheduled: every 2 min (sponsor + settlement + treasury)');
  const task = cron.schedule(OPS_FUNDING_CRON, tick);
  registerWorker('ops-funding', task, cronIntervalMs(OPS_FUNDING_CRON));
};
