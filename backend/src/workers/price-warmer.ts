// Keeps price-cache.ts hot for every display asset, independent of whether anyone is subscribed to
// that asset's WS broadcast loop yet (wsRoutes.ts ensureAssetLoop). Without this, an asset with no
// on-chain oracle backing it (real-Predict-testnet only ever lists BTC, see market-sync.ts) falls
// through to a live Hermes fetch on the loop's very first tick before it can emit anything, which is
// the multi-hundred-ms-to-seconds gap that made LUCKY's non-BTC reel charts visibly lag behind BTC's
// instantly-live chart. Plain setInterval, not node-cron: the ~700ms cadence needs to land just under
// price-cache's 900ms TTL, finer than cron's 1s granularity.
import { warmSpots } from '../lib/price-cache.ts';
import { PYTH_FEED_IDS } from '../lib/pyth.ts';
import { recordRun, registerWorker } from '../lib/worker-registry.ts';

const WARM_INTERVAL_MS = 700;
const ASSETS = Object.keys(PYTH_FEED_IDS);

let isRunning = false;

const warm = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;
  const startedAt = Date.now();
  let runErr: unknown = null;
  try {
    await warmSpots(ASSETS);
  } catch (error) {
    runErr = error;
    console.error('[PriceWarmer] Error:', error);
  } finally {
    isRunning = false;
    recordRun('price-warmer', !runErr, Date.now() - startedAt, runErr);
  }
};

export const startPriceWarmer = (): void => {
  console.log(`[PriceWarmer] Scheduled every ${WARM_INTERVAL_MS}ms for ${ASSETS.join(', ')}`);
  const timer = setInterval(() => void warm(), WARM_INTERVAL_MS);
  timer.unref();
  // Plain setInterval, not node-cron, so the registry's stop handle clears the interval directly.
  registerWorker('price-warmer', { stop: () => clearInterval(timer) }, WARM_INTERVAL_MS);
  void warm();
};
