// Real-Predict market discovery: Mysten owns the roll schedule and there's no operator role, so we read
// PoolVault's live 1m BTC market ids from chain, keep the unsettled/unpaused ones with room before expiry,
// and upsert them into the same market set the games read.
//
// Two cadences, because the fullnode is rate limited per IP: the spot read runs every tick (the chart is
// pinned to it), the market SET is re-read every MARKET_DISCOVERY_MS. Reading both every tick cost ~6 req/s
// against a public node that allows ~3.3, which is what made every mint race a 429.

import cron from 'node-cron';

import { EXPIRY_SAFETY_MS, MARKET_SYNC_CRON, MARKET_DISCOVERY_MS } from '../config/main-config.ts';
import { REAL_BTC_ASSET } from '../lib/sui/config-real.ts';
import { isRateLimitedError } from '../lib/sui/client.ts';
import {
  isMinuteExpiry,
  readActiveMarkets,
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
let lastDiscoveryAt = 0;

// The chart needs a fresh spot every tick; the market SET barely moves (1m markets roll once a minute), so
// rediscovering it on the same cadence just burns fullnode budget. Split the two.
const discoverMarkets = async (t: number, spot: { spot1e9: bigint } | null): Promise<void> => {
  const underlyingId = REAL_BTC_ASSET?.propbookUnderlyingId ?? 1;
  const active = await readActiveMarkets();

  // The vault entry carries expiry_ms since 7-29, so cadence and the expiry window are decidable without
  // fetching the market. Two thirds of the active set is 5m/1h we'd read and throw away.
  const candidates = active.filter((e) => e.expiryMs === 0 || (isMinuteExpiry(e.expiryMs) && e.expiryMs - t > EXPIRY_SAFETY_MS));

  await Promise.all(
    candidates.map(async ({ marketId }) => {
      try {
        const c = await readMarketCoarse(marketId);
        if (!c || c.settled || c.mintPaused) return;
        if (c.underlyingId !== underlyingId) return;
        if (!isMinuteExpiry(c.expiryMs)) return;
        if (c.expiryMs - t <= EXPIRY_SAFETY_MS) return;
        const e = await readMarketEconomics(marketId); // cached per market, immutable
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
          noLeverageWindowMs: e.noLeverageWindowMs.toString(),
        });
      } catch {
        // transient read error on one market; the next discovery re-reads it
      }
    }),
  );
};

// Exported so an ops script can populate the market cache once without standing up the cron.
export const syncMarketsOnce = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;
  const startedAt = Date.now();
  let runErr: unknown = null;
  try {
    const t = Date.now();
    // One live BS spot read per tick, stamped on every known BTC market so assetSpot('BTC') and the eased
    // chart feed track the price the round is marked against. Kept if a tick can't read it.
    const spot = await readBtcSpot();
    if (spot) {
      for (const m of allMarkets()) {
        if (m.underlying !== REAL_BTC_GAME_ASSET) continue;
        upsertMarket({ ...m, spot1e9: spot.spot1e9.toString(), lastPushAt: t });
      }
    }

    if (t - lastDiscoveryAt >= MARKET_DISCOVERY_MS) {
      lastDiscoveryAt = t;
      await discoverMarkets(t, spot);
    }

    for (const m of allMarkets()) {
      if (m.settled || m.expiryMs <= t) removeMarket(m.oracleId);
    }
  } catch (err) {
    runErr = err;
    console.error('[MarketSync] tick error:', err instanceof Error ? err.message : err);
  } finally {
    isRunning = false;
    // A surviving rate limit is upstream backpressure, not a bug in this worker: one warn group, not an
    // error group counting every tick (the old shape filed 7.4k rows off one misconfigured endpoint).
    const throttled = runErr != null && isRateLimitedError(runErr);
    recordRun('market-sync', !runErr, Date.now() - startedAt, runErr, throttled ? { level: 'warn', fingerprint: 'worker.rpc_rate_limited', title: 'Fullnode rate limit, market sync tick skipped' } : undefined);
  }
};

export const startMarketSync = (): void => {
  console.log(`[MarketSync] Real-Predict discovery: scheduled ${MARKET_SYNC_CRON}`);
  const task = cron.schedule(MARKET_SYNC_CRON, syncMarketsOnce);
  registerWorker('market-sync', task, cronIntervalMs(MARKET_SYNC_CRON));
  syncMarketsOnce();
};
