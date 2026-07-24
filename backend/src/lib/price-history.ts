// The shared chart pre-roll: a rolling ~60s ring of the SAME displaySpot series /ws broadcasts, recorded
// server-side so two devices opening the same game draw the same past instead of each rolling a local random
// walk. Sampled by its own always-on loop (not the /ws hub, which only runs while someone is subscribed), so
// the first player of the day still gets real history. Display-only (L-015): nothing truthful reads this.

import { displaySpot } from './price-bus.ts';
import { PYTH_FEED_IDS } from './pyth.ts';
import { recordRun, registerWorker } from './worker-registry.ts';

export type SpotPoint = { t: number; p: number };

const WINDOW_MS = 60_000; // how far back we keep, comfortably past the chart's 30s visible span
const SAMPLE_MS = 500; // dense enough that the pre-roll reads like the live line, cheap enough to always run
const ASSETS = Object.keys(PYTH_FEED_IDS);
const rings = new Map<string, SpotPoint[]>();

function record(asset: string, price: number, ts: number): void {
  if (!(price > 0)) return;
  let ring = rings.get(asset);
  if (!ring) {
    ring = [];
    rings.set(asset, ring);
  }
  ring.push({ t: ts, p: price });
  const cutoff = ts - WINDOW_MS;
  let drop = 0;
  while (drop < ring.length && ring[drop]!.t < cutoff) drop++;
  if (drop > 0) ring.splice(0, drop);
}

// The recorded pre-roll for an asset, oldest first. Empty until the sampler has run.
export function spotHistory(asset: string): SpotPoint[] {
  const ring = rings.get(asset);
  if (!ring || ring.length === 0) return [];
  const cutoff = Date.now() - WINDOW_MS;
  const from = ring.findIndex((pt) => pt.t >= cutoff);
  return from < 0 ? [] : ring.slice(from);
}

let isRunning = false;

const sample = async (): Promise<void> => {
  if (isRunning) return; // a slow read never stacks samples on top of each other
  isRunning = true;
  const startedAt = Date.now();
  let runErr: unknown = null;
  try {
    const spots = await Promise.all(ASSETS.map((a) => displaySpot(a).catch(() => null)));
    const ts = Date.now();
    ASSETS.forEach((a, i) => {
      const s = spots[i];
      if (s) record(a, s.price, ts); // one stamp for the batch: every asset shares the sample grid
    });
  } catch (error) {
    runErr = error;
    console.error('[PriceHistory] Error:', error);
  } finally {
    isRunning = false;
    recordRun('price-history', !runErr, Date.now() - startedAt, runErr);
  }
};

export const startPriceHistory = (): void => {
  console.log(`[PriceHistory] Recording ${WINDOW_MS}ms of ${ASSETS.join(', ')} every ${SAMPLE_MS}ms`);
  const timer = setInterval(() => void sample(), SAMPLE_MS);
  timer.unref();
  registerWorker('price-history', { stop: () => clearInterval(timer) }, SAMPLE_MS);
  void sample();
};
