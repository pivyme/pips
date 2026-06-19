// Pyth Hermes spot prices over HTTP (no key). Source of truth for what we push to our
// oracles and for the UI price stream. Feed ids are the canonical Pyth USD feeds, the
// same across networks. https://hermes.pyth.network

import { PYTH_HERMES_URL } from '../config/main-config.ts';

// asset symbol -> Pyth price feed id (USD pairs)
export const PYTH_FEED_IDS: Record<string, string> = {
  BTC: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  ETH: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  SOL: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  SUI: '23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
};

type HermesPrice = {
  id: string;
  price: { price: string; expo: number; conf: string; publish_time: number };
};

// Fetch latest USD spot for one or more assets. Returns a map symbol -> price.
// Hermes is an external service with variable latency; one slow response should not kill a
// solve/settle/push flow, so retry a couple times on timeout before giving up.
export async function fetchSpots(assets: string[]): Promise<Record<string, number>> {
  const ids = assets.map((a) => PYTH_FEED_IDS[a]).filter(Boolean);
  if (ids.length === 0) return {};

  const url = new URL('/v2/updates/price/latest', PYTH_HERMES_URL);
  for (const id of ids) url.searchParams.append('ids[]', id);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Pyth Hermes ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { parsed?: HermesPrice[] };

      const byId: Record<string, number> = {};
      for (const p of body.parsed ?? []) {
        byId[p.id.toLowerCase()] = Number(p.price.price) * 10 ** p.price.expo;
      }

      const out: Record<string, number> = {};
      for (const asset of assets) {
        const id = PYTH_FEED_IDS[asset]?.toLowerCase();
        if (id && byId[id] != null) out[asset] = byId[id];
      }
      return out;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchSpot(asset: string): Promise<number> {
  const spots = await fetchSpots([asset]);
  const v = spots[asset];
  if (v == null) throw new Error(`Pyth: no price for ${asset}`);
  return v;
}
