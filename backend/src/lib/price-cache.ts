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
