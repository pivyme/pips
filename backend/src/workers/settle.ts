// settle: resolves expired rounds on a tight cadence. The real work lives in settleDuePlays
// (plays.ts), which is the self-healing, play-driven authority: for each open play whose round has
// expired it reads the backing oracle straight from chain, drives it to settlement if the chain has
// not frozen it yet (a post-expiry price push settles it, gotcha #3), then sweeps any in-the-money
// payout into the user's manager. Because it reads the chain (not the in-memory ladder), a play
// settles even if its oracle fell out of the cache on a restart, which is what stopped rounds from
// sitting on SETTLING forever. This worker just ticks it and prunes retired oracles from the cache.

import cron from 'node-cron';

import { OPERATOR_ENABLED, SETTLE_CRON } from '../config/main-config.ts';
import { allMarkets, removeMarket } from '../lib/sui/markets.ts';
import { settleDuePlays } from '../services/plays.ts';

let isRunning = false;

// Long enough that any open play on an expired oracle has settled before we drop it. settleDuePlays
// reads the chain directly, so even pruning early would not strand a settle, this is pure memory
// hygiene so a long-lived process doesn't accumulate dead oracles in the cache.
const ORACLE_PRUNE_GRACE_MS = 5 * 60_000;

const settleTick = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;
  try {
    await settleDuePlays();
    pruneRetiredOracles();
  } catch (err) {
    console.error('[Settle] tick error:', err instanceof Error ? err.message : err);
  } finally {
    isRunning = false;
  }
};

// Drop oracles the live set no longer needs: settled, or expired well past the point any open play
// could still reference them. Routing already ignores expired oracles (liveByAsset/tradeableMarkets
// filter on remaining life), so this only bounds the cache's memory.
const pruneRetiredOracles = (): void => {
  const cutoff = Date.now() - ORACLE_PRUNE_GRACE_MS;
  for (const m of allMarkets()) {
    if (m.settled || m.expiryMs < cutoff) removeMarket(m.oracleId);
  }
};

export const startSettleWorker = (): void => {
  // Runs in BOTH modes. The operator also nudges expired oracles to settlement (settleDuePlays
  // Phase 1); a follower skips the nudge and only finalizes its OWN database's plays against the
  // oracles the leader settles on the shared chain. Without this, a follower's plays (separate DB,
  // invisible to the deployed operator) sit on SETTLING forever. settleDuePlays gates per phase.
  const role = OPERATOR_ENABLED ? 'operator' : 'follower: settle-only, no oracle nudge';
  console.log(`[Settle] Scheduled: ${SETTLE_CRON} (${role})`);
  cron.schedule(SETTLE_CRON, settleTick);
  settleTick();
};