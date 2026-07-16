// price-pusher: the heartbeat of the Predict instance, pulling Pyth spot each tick and pushing it onto
// every tradeable oracle to keep mint/redeem inside the 30s freshness gate. Batched one PTB per cap; never touches an oracle inside the expiry safety window, so an in-flight mint can't race settlement.

import cron from 'node-cron';

import { EXPIRY_SAFETY_MS, IS_REAL_PREDICT, PRICE_PUSH_CRON } from '../config/main-config.ts';
import { usd1e9 } from '../lib/sui/config.ts';
import { executeAsOperator } from '../lib/sui/execute.ts';
import { appendPriceUpdate } from '../lib/sui/predict.ts';
import { getMarket, tradeableMarkets } from '../lib/sui/markets.ts';
import { engineSpot } from '../lib/game-price.ts';
import { cronIntervalMs, recordRun, registerWorker } from '../lib/worker-registry.ts';
import { isOperatorLeader } from '../lib/leader-lock.ts';
import { Transaction } from '@mysten/sui/transactions';

let isRunning = false;

const pushPrices = async (): Promise<void> => {
  if (isRunning) return; // a slow RPC round should never stack pushes
  isRunning = true;
  const startedAt = Date.now();
  let runErr: unknown = null;
  try {
    const now = Date.now();
    const due = tradeableMarkets(now, EXPIRY_SAFETY_MS);
    if (due.length === 0) return;

    const assets = [...new Set(due.map((m) => m.underlying))];
    // The synthetic walk (real Pyth anchor + vol) is the value written on-chain; the chart streams an eased
    // version of THIS pushed price (gameSpot), so the line always tracks what the play settles against, never a second walk.
    const spots: Record<string, number> = {};
    await Promise.all(
      assets.map(async (a) => {
        const s = await engineSpot(a);
        if (s) spots[a] = s.price;
      }),
    );

    // group by cap so each owned cap is used in exactly one in-flight tx (no version race)
    const byCap = new Map<string, typeof due>();
    for (const m of due) {
      if (!m.capId || spots[m.underlying] == null) continue;
      const group = byCap.get(m.capId);
      if (group) group.push(m);
      else byCap.set(m.capId, [m]);
    }

    for (const [capId, group] of byCap) {
      const tx = new Transaction();
      for (const m of group) appendPriceUpdate(tx, m.oracleId, capId, spots[m.underlying]);
      try {
        await executeAsOperator(tx, `price-push (${group.length} oracle${group.length > 1 ? 's' : ''})`);
        const pushedAt = Date.now();
        for (const m of group) {
          const cur = getMarket(m.oracleId);
          if (cur) {
            cur.spot1e9 = String(usd1e9(spots[m.underlying]));
            cur.lastPushAt = pushedAt;
          }
        }
      } catch (err) {
        // One bad cap-group (e.g. an oracle that settled mid-tick) must not stall the rest.
        console.error(`[PricePusher] push failed for cap ${capId}:`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    runErr = err;
    console.error('[PricePusher] tick error:', err instanceof Error ? err.message : err);
  } finally {
    isRunning = false;
    recordRun('price-pusher', !runErr, Date.now() - startedAt, runErr);
  }
};

export const startPricePusher = (): void => {
  if (IS_REAL_PREDICT) {
    // Real mode reads external Propbook feeds (Pyth/Block Scholes); we never push a price on chain.
    console.log('[PricePusher] Real Predict mode (external feeds), not scheduling');
    return;
  }
  if (!isOperatorLeader()) {
    console.log('[PricePusher] Not the operator leader (disabled or lost the advisory lock), not scheduling');
    return;
  }
  console.log(`[PricePusher] Scheduled: ${PRICE_PUSH_CRON}`);
  const task = cron.schedule(PRICE_PUSH_CRON, pushPrices);
  registerWorker('price-pusher', task, cronIntervalMs(PRICE_PUSH_CRON));
  pushPrices();
};
