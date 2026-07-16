// Keeps price-cache.ts hot for every display asset so a first WS subscribe never hits a cold Hermes
// fetch (the gap that made non-BTC reel charts lag BTC's). Plain setInterval, not node-cron: the 700ms cadence needs to land under price-cache's 900ms TTL, finer than cron's 1s granularity.
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
