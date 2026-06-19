// price-pusher: the heartbeat of the Predict instance. Every tick it pulls spot from Pyth
// Hermes and pushes it onto every tradeable oracle so mint/redeem stay inside the 30s
// freshness gate (gotcha #1). Pushes are batched per cap (one PTB per cap, gotcha #5) and
// it never touches an oracle inside the expiry safety window, so an in-flight mint cannot
// race settlement (gotcha #3); settle owns oracles past that line.

import cron from 'node-cron';

import { EXPIRY_SAFETY_MS, OPERATOR_ENABLED, PRICE_PUSH_CRON } from '../config/main-config.ts';
import { usd1e9 } from '../lib/sui/config.ts';
import { executeAsOperator } from '../lib/sui/execute.ts';
import { appendPriceUpdate } from '../lib/sui/predict.ts';
import { getMarket, tradeableMarkets } from '../lib/sui/markets.ts';
import { gameSpot } from '../lib/game-price.ts';
import { Transaction } from '@mysten/sui/transactions';

let isRunning = false;

const pushPrices = async (): Promise<void> => {
  if (isRunning) return; // a slow RPC round should never stack pushes
  isRunning = true;
  try {
    const now = Date.now();
    const due = tradeableMarkets(now, EXPIRY_SAFETY_MS);
    if (due.length === 0) return;

    const assets = [...new Set(due.map((m) => m.underlying))];
    // The synthetic game price (real Pyth anchor + vol), the same value the chart streams, so the
    // oracle the play settles against carries exactly what the player watched.
    const spots: Record<string, number> = {};
    await Promise.all(
      assets.map(async (a) => {
        const s = await gameSpot(a);
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
    console.error('[PricePusher] tick error:', err instanceof Error ? err.message : err);
  } finally {
    isRunning = false;
  }
};

export const startPricePusher = (): void => {
  if (!OPERATOR_ENABLED) {
    console.log('[PricePusher] Operator disabled (PIPS_OPERATOR_ENABLED != true), not scheduling');
    return;
  }
  console.log(`[PricePusher] Scheduled: ${PRICE_PUSH_CRON}`);
  cron.schedule(PRICE_PUSH_CRON, pushPrices);
  pushPrices();
};
