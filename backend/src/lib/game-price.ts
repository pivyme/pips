// gameSpot: the eased on-chain oracle spot every player/chart/settlement reads, so the chart line IS the
// price the round prices/settles against (entry/target can never sit where the line never went).

import { getSpot } from './price-cache.ts';
import { assetSpot } from './sui/markets.ts';

// The display feed: the on-chain oracle spot, eased so the ~1-2s sync steps glide. assetSpot is what
// market-sync mirrors from chain; chart/entry/strike/settlement all read one price, no second walk to
// drift from. Falls back to raw Pyth on a cold boot.
const followShown = new Map<string, { price: number; at: number }>();
const FOLLOW_TAU_MS = 650; // smoothing constant for the ~2s chain-spot steps, kept short so the line
// tracks the oracle closely; a long tau can show the line above target when it settled below (win-zone shading reads this).

async function followerSpot(asset: string): Promise<{ price: number; ts: number } | null> {
  let target = assetSpot(asset);
  if (target == null || target <= 0) {
    const s = await getSpot(asset);
    target = s ? s.price : null;
  }
  if (target == null || target <= 0) return null;
  const now = Date.now();
  const cur = followShown.get(asset);
  if (!cur) {
    followShown.set(asset, { price: target, at: now });
    return { price: target, ts: now };
  }
  const k = 1 - Math.exp(-(now - cur.at) / FOLLOW_TAU_MS);
  cur.price += (target - cur.price) * k;
  cur.at = now;
  return { price: cur.price > 0 ? cur.price : target, ts: now };
}

// The display price every game screen shows: the eased on-chain oracle spot, so the chart line IS the
// price the round prices/settles against. Null only on a cold boot.
export async function gameSpot(asset: string): Promise<{ price: number; ts: number } | null> {
  return followerSpot(asset);
}
