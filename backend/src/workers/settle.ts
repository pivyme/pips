// settle: resolves expired rounds on a tight cadence via settleDuePlays (plays.ts), which reads the backing
// oracle straight from chain per expired play. Reading the chain (not the in-memory ladder) means a play settles even after its oracle falls out of cache on restart, fixing the old SETTLING-forever bug.

import cron from 'node-cron';

import { IS_REAL_PREDICT, SETTLE_CRON } from '../config/main-config.ts';
import { allMarkets, removeMarket } from '../lib/sui/markets.ts';
import { settleDuePlays, settleDuePlaysReal } from '../services/plays.ts';
import { cronIntervalMs, recordRun, registerWorker } from '../lib/worker-registry.ts';
import { isOperatorLeader } from '../lib/leader-lock.ts';

let isRunning = false;

// Long enough that any open play on an expired oracle has settled before we drop it. settleDuePlays reads
// the chain directly, so this is pure memory hygiene, not a correctness dependency.
const ORACLE_PRUNE_GRACE_MS = 5 * 60_000;

const settleTick = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;
  const startedAt = Date.now();
  let runErr: unknown = null;
  try {
    // Real mode: redeem_settled per expired play (Mysten/Pyth settle the market, no operator nudge). Fork
    // mode: the self-healing operator/follower settle. Both prune the retired market cache.
    if (IS_REAL_PREDICT) await settleDuePlaysReal();
    else await settleDuePlays();
    pruneRetiredOracles();
  } catch (err) {
    runErr = err;
    console.error('[Settle] tick error:', err instanceof Error ? err.message : err);
  } finally {
    isRunning = false;
    recordRun('settle', !runErr, Date.now() - startedAt, runErr);
  }
};

// Drops oracles the live set no longer needs: settled, or expired well past the point any open play could
// reference them. Routing already ignores expired oracles (liveByAsset/tradeableMarkets), so this only bounds cache memory.
const pruneRetiredOracles = (): void => {
  const cutoff = Date.now() - ORACLE_PRUNE_GRACE_MS;
  for (const m of allMarkets()) {
    if (m.settled || m.expiryMs < cutoff) removeMarket(m.oracleId);
  }
};

export const startSettleWorker = (): void => {
  // Runs in both modes; the operator also nudges expired oracles to settlement (settleDuePlays Phase 1), while
  // a follower skips the nudge and only finalizes its own DB's plays, else they'd sit on SETTLING forever.
  const role = IS_REAL_PREDICT
    ? 'real: redeem_settled per play'
    : isOperatorLeader()
      ? 'operator'
      : 'follower: settle-only, no oracle nudge';
  console.log(`[Settle] Scheduled: ${SETTLE_CRON} (${role})`);
  const task = cron.schedule(SETTLE_CRON, settleTick);
  registerWorker('settle', task, cronIntervalMs(SETTLE_CRON));
  settleTick();
};