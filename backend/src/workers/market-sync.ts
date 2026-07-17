// Real-Predict market discovery: Mysten owns the roll schedule and there's no operator role, so we read
// the chain each tick for PoolVault's live 1m BTC market ids, keep the unsettled/unpaused ones with room
// before expiry, and upsert them into the same market set the games read.

import cron from 'node-cron';

import { EXPIRY_SAFETY_MS, MARKET_SYNC_CRON } from '../config/main-config.ts';
import { REAL_BTC_ASSET } from '../lib/sui/config-real.ts';
import {
  isMinuteExpiry,
  readActiveMarketIds,
  readBtcSpot,
  readMarketCoarse,
  readMarketEconomics,
} from '../lib/sui/predict-real.ts';
import { allMarkets, getMarket, removeMarket, upsertMarket } from '../lib/sui/markets.ts';
import { cronIntervalMs, recordRun, registerWorker } from '../lib/worker-registry.ts';

// Game asset symbol for the only underlying live on Mysten's testnet Predict (propbook id 1); every
// selected asset routes to this BTC market, tagged with the symbol the asset picker + assetSpot key on.
const REAL_BTC_GAME_ASSET = 'BTC';

let isRunning = false;

const sync = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;
  const startedAt = Date.now();
  let runErr: unknown = null;
  try {
    const t = Date.now();
    const underlyingId = REAL_BTC_ASSET?.propbookUnderlyingId ?? 1;
    // One live BS spot read per tick, stamped on every discovered BTC market so assetSpot('BTC') and
    // the eased chart feed track the price the round is marked against. Kept if a tick can't read it.
    const spot = await readBtcSpot();
    const ids = await readActiveMarketIds();

    await Promise.all(
      ids.map(async (marketId) => {
        try {
          const c = await readMarketCoarse(marketId);
          if (!c || c.settled || c.mintPaused) return;
          if (c.underlyingId !== underlyingId) return;
          if (!isMinuteExpiry(c.expiryMs)) return;
          if (c.expiryMs - t <= EXPIRY_SAFETY_MS) return;
          const e = await readMarketEconomics(marketId);
          const prev = getMarket(marketId);
          upsertMarket({
            oracleId: marketId,
            capId: '', // permissionless in real mode, no per-market cap
            underlying: REAL_BTC_GAME_ASSET,
            expiryMs: c.expiryMs,
            minStrike: '0', // unused in real mode; the tick codec drives strikes
            tickSize: e.tickSizeRaw.toString(),
            settled: false,
            spot1e9: spot ? spot.spot1e9.toString() : prev?.spot1e9,
            lastPushAt: spot ? t : prev?.lastPushAt,
            admissionTickSizeRaw: e.admissionTickSizeRaw.toString(),
            maxLeverage1e9: e.maxLeverage1e9.toString(),
            liquidationLtv1e9: e.liquidationLtv1e9.toString(),
          });
        } catch {
          // transient read error on one market; the next tick re-reads it
        }
      }),
    );

    for (const m of allMarkets()) {
      if (m.settled || m.expiryMs <= t) removeMarket(m.oracleId);
    }
  } catch (err) {
    runErr = err;
    console.error('[MarketSync] tick error:', err instanceof Error ? err.message : err);
  } finally {
    isRunning = false;
    recordRun('market-sync', !runErr, Date.now() - startedAt, runErr);
  }
};

export const startMarketSync = (): void => {
  console.log(`[MarketSync] Real-Predict discovery: scheduled ${MARKET_SYNC_CRON}`);
  const task = cron.schedule(MARKET_SYNC_CRON, sync);
  registerWorker('market-sync', task, cronIntervalMs(MARKET_SYNC_CRON));
  sync();
};
