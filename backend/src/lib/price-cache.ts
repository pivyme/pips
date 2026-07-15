// A tiny shared spot cache over Pyth Hermes. Many SSE clients can subscribe to the same
// asset without each one hitting Hermes: a fetch refreshes at most ~once/second per asset,
// and a transient Pyth blip serves the last good price instead of dropping the stream.

import { fetchSpots } from './pyth.ts';

const TTL_MS = 900;
const cache = new Map<string, { price: number; ts: number }>();

export async function getSpot(asset: string): Promise<{ price: number; ts: number } | null> {
  const now = Date.now();
  const hit = cache.get(asset);
  if (hit && now - hit.ts < TTL_MS) return hit;
  try {
    const spots = await fetchSpots([asset]);
    const price = spots[asset];
    if (price == null) return hit ?? null;
    const entry = { price, ts: now };
    cache.set(asset, entry);
    return entry;
  } catch {
    return hit ?? null; // serve stale on a transient failure, never blank the chart
  }
}

// Batched proactive refresh for price-warmer.ts: one Hermes round-trip for every asset instead of N
// lazy per-asset ones, so a cold WS asset loop (wsRoutes.ts ensureAssetLoop) never has to block its
// first broadcast on a live fetch. Silent on failure, the TTL cache just serves stale a bit longer.
export async function warmSpots(assets: string[]): Promise<void> {
  const spots = await fetchSpots(assets).catch(() => null);
  if (!spots) return;
  const now = Date.now();
  for (const [asset, price] of Object.entries(spots)) cache.set(asset, { price, ts: now });
}
