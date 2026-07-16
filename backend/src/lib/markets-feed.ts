// The markets feed the games render: which assets are tradeable right now, their display spot, and the
// real-mode sponsor-pause flag. ONE builder, shared by the one-shot GET /markets (first paint) and the
// /stream/markets SSE (live updates), so the two can never drift.
//
// We list every priceable asset, not just the ones with a live oracle: real-Predict-testnet only stands
// up BTC oracles, but LUCKY stacks BTC/SUI/ETH charts and seeds each from this spot, so a display-only
// asset needs its spot here or its chart lags behind BTC's. `live` stays oracle-driven, so a
// non-tradeable asset is charted but never dealt (canPlay unaffected).

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

// A cheap signature of what actually changes the games' UI: which assets are tradeable + the pause flag.
// Spot is deliberately excluded (it flows over the chart WS; a spot tick is not a "market changed"
// event), so the /stream/markets ticker can diff this every second without touching gameSpot and only
// broadcast a full frame when the live set or the pause state truly flips.
export function liveSetSignature(): string {
  const now = Date.now();
  const live = [...new Set(tradeableMarkets(now, EXPIRY_SAFETY_MS).map((m) => m.underlying))].sort();
  return `${live.join(',')}|${sponsorPaused().paused ? 1 : 0}`;
}
