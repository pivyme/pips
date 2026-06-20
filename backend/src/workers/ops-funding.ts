// Keeps the three ops wallets topped up: the gas sponsor (SUI), the settlement wallet (SUI), and the
// treasury (SUI + a big DUSDC reserve). Operator-driven, since only the leader owns the SUI + DUSDC
// TreasuryCap to fund from, so this no-ops unless OPERATOR_ENABLED. Generous amounts (free localnet
// SUI), low cadence: each tick just reads three balances and tops up the shortfall. Boot funding is
// done once in index.ts before serving; this worker is the ongoing safety net.

import cron from 'node-cron';

import { OPERATOR_ENABLED } from '../config/main-config.ts';
import { ensureOpsFunded } from '../lib/sui/gas.ts';

let isRunning = false;

const tick = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;
  try {
    await ensureOpsFunded();
  } catch (e) {
    console.warn('[ops-funding] tick error:', e instanceof Error ? e.message : e);
  } finally {
    isRunning = false;
  }
};

export const startOpsFunding = (): void => {
  if (!OPERATOR_ENABLED) return; // only the leader funds the ops wallets
  console.log('[ops-funding] Scheduled: every 2 min (sponsor + settlement + treasury)');
  cron.schedule('*/2 * * * *', tick);
};
