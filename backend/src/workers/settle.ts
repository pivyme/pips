// settle: resolves expired rounds on a tight cadence via settleDuePlaysReal (plays.ts), which reads the
// backing market straight from chain per expired play. Reading the chain means a play settles even after
// its market falls out of cache on restart, fixing the old SETTLING-forever bug.

import cron from 'node-cron';

import { SETTLE_CRON } from '../config/main-config.ts';
import { allMarkets, removeMarket } from '../lib/sui/markets.ts';
import { settleDuePlaysReal } from '../services/plays.ts';
import { cronIntervalMs, recordRun, registerWorker } from '../lib/worker-registry.ts';

let isRunning = false;

// Long enough that any open play on an expired market has settled before we drop it. settleDuePlaysReal
// reads the chain directly, so this is pure memory hygiene, not a correctness dependency.
const ORACLE_PRUNE_GRACE_MS = 5 * 60_000;

const settleTick = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;
  const startedAt = Date.now();
  let runErr: unknown = null;
  try {
    // redeem_settled per expired play (Mysten/Pyth settle the market, no operator nudge), then prune the
    // retired market cache.
    await settleDuePlaysReal();
    pruneRetiredOracles();
  } catch (err) {
    runErr = err;
    console.error('[Settle] tick error:', err instanceof Error ? err.message : err);
  } finally {
    isRunning = false;
    recordRun('settle', !runErr, Date.now() - startedAt, runErr);
  }
};

// Drops markets the live set no longer needs: settled, or expired well past the point any open play could
// reference them. Routing already ignores expired markets (liveByAsset/tradeableMarkets), so this only bounds cache memory.
const pruneRetiredOracles = (): void => {
  const cutoff = Date.now() - ORACLE_PRUNE_GRACE_MS;
  for (const m of allMarkets()) {
    if (m.settled || m.expiryMs < cutoff) removeMarket(m.oracleId);
  }
};

export const startSettleWorker = (): void => {
  console.log(`[Settle] Scheduled: ${SETTLE_CRON} (redeem_settled per play)`);
  const task = cron.schedule(SETTLE_CRON, settleTick);
  registerWorker('settle', task, cronIntervalMs(SETTLE_CRON));
  settleTick();
};
