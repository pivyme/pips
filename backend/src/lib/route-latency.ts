// Per-route response times, kept in memory for the Performance page.
//
// Keyed on the ROUTE PATTERN (`/plays/:id`), never the concrete url, for the same reason event names are
// allowlisted: `/plays/abc123` as a key means one bucket per play and every GROUP BY is destroyed. A
// request that matched no route is dropped rather than filed under a made-up key.
//
// Bounded by construction: a fixed ring per route and a hard ceiling on distinct routes, so this can never
// be the reason a long-lived process grows. Nothing is persisted; a restart starts a fresh window, which is
// the right trade for a number you read while looking at a live system.

import type { FastifyInstance } from 'fastify';

const SAMPLES_PER_ROUTE = 512;
const MAX_ROUTES = 200;

type Ring = { at: number; values: Float64Array; filled: number };

const rings = new Map<string, Ring>();

export function recordRouteLatency(key: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  let ring = rings.get(key);
  if (!ring) {
    if (rings.size >= MAX_ROUTES) return; // the app has ~60 routes; past 200 something is generating keys
    rings.set(key, (ring = { at: 0, values: new Float64Array(SAMPLES_PER_ROUTE), filled: 0 }));
  }
  ring.values[ring.at] = ms;
  ring.at = (ring.at + 1) % SAMPLES_PER_ROUTE;
  ring.filled = Math.min(SAMPLES_PER_ROUTE, ring.filled + 1);
}

export function routeSamples(): Array<{ route: string; samples: number[] }> {
  return [...rings.entries()].map(([route, ring]) => ({ route, samples: [...ring.values.slice(0, ring.filled)] }));
}

/** Test seam, and what a settings-driven reset would call. */
export function clearRouteLatency(): void {
  rings.clear();
}

export function installRouteLatency(app: FastifyInstance): void {
  app.addHook('onResponse', (request, reply, done) => {
    const pattern = request.routeOptions?.url;
    if (pattern) recordRouteLatency(`${request.method} ${pattern}`, reply.elapsedTime);
    done();
  });
}
