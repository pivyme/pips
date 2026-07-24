// Token metadata + best-effort price refresh: keeps the TokenInfo cache the send picker + activity feed read
// from warm, off the request path. Chill (every ~10 min), bounded batch, best-effort per token. On testnet
// only SUI + stables get a real USD price; that is expected (§6c).

import cron from 'node-cron';

import { TOKEN_SYNC_CRON, TOKEN_SYNC_BATCH } from '../config/main-config.ts';
import { syncTokens } from '../lib/sui/tokens.ts';
import { WALLET_REAL_NETWORK } from '../lib/sui/wallet-ledger.ts';
import { cronIntervalMs, recordRun, registerWorker } from '../lib/worker-registry.ts';

let isRunning = false;

const tick = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;
  const startedAt = Date.now();
  let runErr: unknown = null;
  try {
    await syncTokens(TOKEN_SYNC_BATCH);
  } catch (error) {
    runErr = error;
    console.error('[TokenWorker] error:', error instanceof Error ? error.message : error);
  } finally {
    isRunning = false;
    recordRun('token-worker', !runErr, Date.now() - startedAt, runErr);
  }
};

export const startTokenWorker = (): void => {
  // Metadata comes from gRPC (works anywhere), but the whole thing only matters where the ledger scan runs.
  if (!WALLET_REAL_NETWORK) {
    console.log('[TokenWorker] skipped (non-real network)');
    return;
  }
  console.log(`[TokenWorker] scheduled ${TOKEN_SYNC_CRON}`);
  const task = cron.schedule(TOKEN_SYNC_CRON, tick);
  registerWorker('token-worker', task, cronIntervalMs(TOKEN_SYNC_CRON));
  void tick(); // warm the curated rows at boot
};
