// One shared broadcast loop per asset (not per-connection) so every socket sees the same value on the
// same frame; one socket multiplexes all of a client's assets via a `{type:'sub',assets}` control message. Auth rides the query token since a browser can't set WS headers. Cosmetic display bus only (L-015).

import type { FastifyInstance, FastifyPluginCallback, FastifyRequest } from 'fastify';

import { PRICE_WS_BROADCAST_MS } from '../config/main-config.ts';
import { userFromToken } from '../services/auth.ts';
import { displaySpot } from '../lib/price-bus.ts';
import { PYTH_FEED_IDS } from '../lib/pyth.ts';

type Conn = { send: (s: string) => void; assets: Set<string> };

// asset -> the connections currently watching it, and the one shared broadcast timer per active asset.
const assetSubs = new Map<string, Set<Conn>>();
const assetTimers = new Map<string, ReturnType<typeof setInterval>>();

// Start the shared broadcast loop for an asset (idempotent). An `inFlight` guard drops a tick if the
// previous displaySpot read hasn't resolved (the fallback rung awaits Pyth), so slow reads never pile up.
function ensureAssetLoop(asset: string): void {
  if (assetTimers.has(asset)) return;
  let inFlight = false;
  const timer = setInterval(async () => {
    const subs = assetSubs.get(asset);
    if (!subs || subs.size === 0 || inFlight) return;
    inFlight = true;
    try {
      const spot = await displaySpot(asset);
      if (!spot) return;
      const frame = JSON.stringify({ type: 'price', asset, price: String(spot.price), ts: spot.ts });
      for (const c of subs) {
        try {
          c.send(frame);
        } catch {
          // dead socket; its close handler prunes it
        }
      }
    } finally {
      inFlight = false;
    }
  }, PRICE_WS_BROADCAST_MS);
  (timer as { unref?: () => void }).unref?.();
  assetTimers.set(asset, timer);
}

// Drop an asset's loop once nobody is watching it, so idle assets carry no timer.
function reapAsset(asset: string): void {
  const subs = assetSubs.get(asset);
  if (subs && subs.size > 0) return;
  const timer = assetTimers.get(asset);
  if (timer) clearInterval(timer);
  assetTimers.delete(asset);
  assetSubs.delete(asset);
}

// Replace a connection's subscription set (initial query + every `{type:'sub'}`). Only known assets are
// honored; unknown symbols are ignored. Adds to new assets' loops, prunes from dropped ones.
function subscribe(conn: Conn, wanted: string[]): void {
  const next = new Set(wanted.filter((a) => PYTH_FEED_IDS[a]));
  for (const a of conn.assets) {
    if (!next.has(a)) {
      assetSubs.get(a)?.delete(conn);
      reapAsset(a);
    }
  }
  for (const a of next) {
    let subs = assetSubs.get(a);
    if (!subs) {
      subs = new Set();
      assetSubs.set(a, subs);
    }
    subs.add(conn);
    ensureAssetLoop(a);
  }
  conn.assets = next;
}

function dropConn(conn: Conn): void {
  for (const a of [...conn.assets]) {
    assetSubs.get(a)?.delete(conn);
    reapAsset(a);
  }
  conn.assets = new Set();
}

const parseAssets = (csv: string | undefined): string[] =>
  (csv ?? '')
    .split(',')
    .map((a) => a.trim().toUpperCase())
    .filter(Boolean);

export const wsRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.get('/ws', { websocket: true }, async (socket: import('@fastify/websocket').WebSocket, request: FastifyRequest) => {
    const { assets, t } = request.query as { assets?: string; t?: string };
    const user = t ? await userFromToken(t) : null;
    if (!user) {
      try {
        socket.close(1008, 'unauthorized');
      } catch {
        // already closed
      }
      return;
    }

    const conn: Conn = { send: (s) => socket.send(s), assets: new Set() };
    subscribe(conn, parseAssets(assets));

    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string; assets?: unknown };
        if (msg.type === 'sub' && Array.isArray(msg.assets)) {
          subscribe(conn, msg.assets.map((a) => String(a).toUpperCase()));
        }
      } catch {
        // ignore a malformed control frame
      }
    });
    socket.on('close', () => dropConn(conn));
    socket.on('error', () => dropConn(conn));
  });

  done();
};
