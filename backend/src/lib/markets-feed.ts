// The markets feed the games render: tradeable assets, display spot, and the sponsor-pause flag. ONE
// builder shared by GET /markets and the /stream/markets SSE so they can't drift; lists every priceable asset (not just live-oracle ones) so LUCKY's non-BTC charts still seed a spot, `live` stays oracle-driven.

import { EXPIRY_SAFETY_MS, GAME_DURATIONS } from '../config/main-config.ts';
import { allMarkets, tradeableMarkets } from './sui/markets.ts';
import { sponsorPaused } from './sui/play-safety.ts';
import { gameSpot } from './game-price.ts';
import { PYTH_FEED_IDS } from './pyth.ts';
import type { MarketDTO } from '../types/api.ts';

export type MarketsPayload = { markets: MarketDTO[]; playsPaused: boolean };

// Stable display order for the market list. The live oracle set reshuffles as the ladder rolls, so
// without a fixed order the client's asset picker would keep jumping. Unknown assets sort after these.
const ASSET_ORDER = ['BTC', 'ETH', 'SOL', 'SUI', 'DEEP'];
const assetRank = (a: string): number => {
  const i = ASSET_ORDER.indexOf(a);
  return i < 0 ? ASSET_ORDER.length : i;
};

const listedAssets = (): string[] =>
  [...new Set([...allMarkets().map((m) => m.underlying), ...Object.keys(PYTH_FEED_IDS)])].sort(
    (a, b) => assetRank(a) - assetRank(b) || a.localeCompare(b),
  );

export async function buildMarketsPayload(): Promise<MarketsPayload> {
  const now = Date.now();
  const live = new Set(tradeableMarkets(now, EXPIRY_SAFETY_MS).map((m) => m.underlying));
  const markets: MarketDTO[] = await Promise.all(
    listedAssets().map(async (asset) => {
      const spot = await gameSpot(asset);
      return { asset, spot: spot ? String(spot.price) : '0', durations: GAME_DURATIONS, live: live.has(asset) };
    }),
  );
  return { markets, playsPaused: sponsorPaused().paused };
}

// Cheap signature of what changes the games' UI: the tradeable set + the pause flag (spot excluded, it
// flows over the chart WS). The ticker diffs this each second and only broadcasts a frame on a flip.
export function liveSetSignature(): string {
  const now = Date.now();
  const live = [...new Set(tradeableMarkets(now, EXPIRY_SAFETY_MS).map((m) => m.underlying))].sort();
  return `${live.join(',')}|${sponsorPaused().paused ? 1 : 0}`;
}
