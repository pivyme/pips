// settle: drives expired oracles to settlement. Between expiry and the first post-expiry
// price push an oracle is frozen (mint AND redeem revert, gotcha #3), so this worker nudges
// each expired oracle with a final price, which freezes its settlement price and flips it
// settled. It then compacts the settled strike matrix to reclaim storage and retires the
// oracle from the live cache. Per-play redemption (redeem_permissionless into each user's
// manager + Play/stats/achievement updates) is owned by the plays service once the Play
// model exists; this worker is the oracle-lifecycle half it builds on.

import cron from 'node-cron';

import { OPERATOR_ENABLED, SETTLE_CRON } from '../config/main-config.ts';
import { FLOAT_SCALING } from '../lib/sui/config.ts';
import { executeAsOperator } from '../lib/sui/execute.ts';
import { buildCompactSettled, appendPriceUpdate, readOracle } from '../lib/sui/predict.ts';
import { allMarkets, removeMarket } from '../lib/sui/markets.ts';
import { settleDuePlays } from '../services/plays.ts';
import { fetchSpot } from '../lib/pyth.ts';
import { Transaction } from '@mysten/sui/transactions';

let isRunning = false;

// Settle price: honest current Pyth spot, falling back to the oracle's last known spot if
// Hermes is briefly unreachable so settlement never stalls.
const settlePrice = async (asset: string, lastSpot1e9?: string): Promise<number> => {
  try {
    return await fetchSpot(asset);
  } catch {
    if (lastSpot1e9) return Number(BigInt(lastSpot1e9)) / Number(FLOAT_SCALING);
    throw new Error(`no settle price for ${asset} (Pyth down, no cached spot)`);
  }
};

const settleTick = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;
  try {
    await driveOraclesToSettlement();
    // Then redeem + record any open plays whose oracle has now settled. Reads the oracle
    // directly, so it still resolves plays after their market left the live cache.
    await settleDuePlays();
  } catch (err) {
    console.error('[Settle] tick error:', err instanceof Error ? err.message : err);
  } finally {
    isRunning = false;
  }
};

// Nudge each expired oracle to settlement, compact its strike matrix, and retire it.
const driveOraclesToSettlement = async (): Promise<void> => {
  const now = Date.now();
  for (const m of allMarkets()) {
    if (m.settled || m.expiryMs > now) continue; // live or already retired

    let state = await readOracle(m.oracleId);
    if (!state) {
      removeMarket(m.oracleId); // object gone, nothing to settle
      continue;
    }

    try {
      // Nudge to settlement if the chain has not frozen it yet.
      if (!state.settled) {
        const spot = await settlePrice(m.underlying, m.spot1e9);
        const tx = new Transaction();
        appendPriceUpdate(tx, m.oracleId, m.capId, spot);
        await executeAsOperator(tx, `settle-nudge ${m.underlying} ${m.oracleId}`);
        state = { ...state, settled: true };
        console.log(`[Settle] settled ${m.underlying} oracle ${m.oracleId}`);
      }

      // Best-effort storage reclaim; a failure here costs only the rebate, not correctness.
      try {
        const compactTx = new Transaction();
        buildCompactSettled(compactTx, m.oracleId, m.capId);
        await executeAsOperator(compactTx, `compact ${m.oracleId}`);
      } catch (err) {
        console.error(`[Settle] compact failed for ${m.oracleId}:`, err instanceof Error ? err.message : err);
      }

      removeMarket(m.oracleId);
    } catch (err) {
      // Leave it in the cache so the next tick retries the nudge.
      console.error(`[Settle] settle failed for ${m.oracleId}:`, err instanceof Error ? err.message : err);
    }
  }
};

export const startSettleWorker = (): void => {
  if (!OPERATOR_ENABLED) {
    console.log('[Settle] Operator disabled (PIPS_OPERATOR_ENABLED != true), not scheduling');
    return;
  }
  console.log(`[Settle] Scheduled: ${SETTLE_CRON}`);
  cron.schedule(SETTLE_CRON, settleTick);
  settleTick();
};
