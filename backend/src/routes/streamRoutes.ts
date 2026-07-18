// SSE streams: the game chart price feed and a live PnL feed per open play.
// EventSource can't set headers, so auth is a JWT in the query (`?t=`); both validate before hijacking, so auth failures still return a normal JSON envelope.

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import type { Play } from '../../prisma/generated/client.js';
import { handleError } from '../utils/errorHandler.ts';
import { PLAY_STREAM_INTERVAL_MS } from '../config/main-config.ts';
import { userFromToken } from '../services/auth.ts';
import { displaySpot } from '../lib/price-bus.ts';
import { onPlay } from '../lib/play-bus.ts';
import { buildMarketsPayload, liveSetSignature } from '../lib/markets-feed.ts';
import { getLiveMarkCached, toPlayDTO } from '../services/plays.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { PYTH_FEED_IDS } from '../lib/pyth.ts';

const TERMINAL = new Set(['won', 'lost', 'cashed_out', 'error']);

// Past the buzzer the live mark is moot (about to become the final payout), so poll status this fast instead, landing the won/lost frame within ~1s of the worker resolving it.
const SETTLING_POLL_MS = 1000;

// Presence keepalive: the feed only pushes on join/leave, so without this an idle proxy drops the socket; also self-heals a client that missed a broadcast.
const LIVE_HEARTBEAT_MS = 25_000;

// Live presence: one connection per open app session (held at the app shell, so it spans home/games/menu, not just Home).
// Broadcast count on every join/leave for the "N ONLINE" ticker; one process serves every client, so this Set is the global count.
const liveClients = new Set<{ send: (data: unknown) => void }>();

function broadcastOnline(): void {
  const payload = { online: liveClients.size };
  for (const c of liveClients) {
    try {
      c.send(payload);
    } catch {
      // Dead socket; its close handler prunes it from the set.
    }
  }
}

// Live markets feed: one shared per-process ticker diffs a live-set signature each second and pushes a frame to every subscriber on a tradeable-set/pause flip, plus a 15s heartbeat.
// One in-memory diff for N clients instead of N polling GET /markets; runs only while someone is watching.
const marketClients = new Set<{ send: (data: unknown) => void }>();
const MARKETS_TICK_MS = 1000; // how often the shared ticker checks for a live-set/pause change (in-memory)
const MARKETS_HEARTBEAT_MS = 15_000; // force a frame at least this often (proxy keepalive + spot refresh)
let marketTicker: ReturnType<typeof setInterval> | null = null;
let lastMarketSig = '';
let lastMarketBroadcastAt = 0;

async function broadcastMarkets(): Promise<void> {
  lastMarketBroadcastAt = Date.now();
  const payload = await buildMarketsPayload().catch(() => null);
  if (!payload) return;
  for (const c of marketClients) {
    try {
      c.send(payload);
    } catch {
      // Dead socket; its close handler prunes it from the set.
    }
  }
}

function ensureMarketTicker(): void {
  if (marketTicker) return;
  lastMarketSig = liveSetSignature();
  lastMarketBroadcastAt = Date.now(); // new clients are primed on connect, so start the heartbeat clock now
  marketTicker = setInterval(() => {
    const sig = liveSetSignature();
    const stale = Date.now() - lastMarketBroadcastAt >= MARKETS_HEARTBEAT_MS;
    if (sig === lastMarketSig && !stale) return;
    lastMarketSig = sig;
    void broadcastMarkets();
  }, MARKETS_TICK_MS);
  (marketTicker as { unref?: () => void }).unref?.(); // don't keep the process alive on this timer alone
}

function stopMarketTickerIfIdle(): void {
  if (marketClients.size > 0 || !marketTicker) return;
  clearInterval(marketTicker);
  marketTicker = null;
}

// Hijack the reply and open the event-stream. Returns a writer + a close registration.
function openStream(reply: FastifyReply, request: FastifyRequest): { send: (data: unknown) => void; onClose: (fn: () => void) => void } {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  reply.raw.write('retry: 2000\n\n');
  const send = (data: unknown): void => {
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const onClose = (fn: () => void): void => {
    request.raw.on('close', fn);
  };
  return { send, onClose };
}

export const streamRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // Chart price feed for one asset, ~1s cadence, client interpolates to 60fps. Cosmetic only (display bus: Binance motion pinned to on-chain oracle); every truthful number reads the chain (L-015).
  // The WS hub (/ws) supersedes this at 10Hz; this SSE route stays as the flagged fallback for one release.
  app.get('/prices', async (request: FastifyRequest, reply: FastifyReply) => {
    const { asset, t } = request.query as { asset?: string; t?: string };
    if (!asset || !PYTH_FEED_IDS[asset]) return handleError(reply, 400, 'Unknown asset', 'VALIDATION_ERROR');
    const user = t ? await userFromToken(t) : null;
    if (!user) return handleError(reply, 401, 'Invalid stream token', 'INVALID_TOKEN');

    const { send, onClose } = openStream(reply, request);
    const tick = async (): Promise<void> => {
      const spot = await displaySpot(asset);
      if (spot) send({ price: String(spot.price), ts: spot.ts });
    };
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    onClose(() => clearInterval(timer));
  });

  // Live presence: one connection per app session (held at the app shell, so a player stays counted mid-game, not just on Home). Drives the "N ONLINE" ticker; count pushes on join/leave.
  app.get('/live', async (request: FastifyRequest, reply: FastifyReply) => {
    const { t } = request.query as { t?: string };
    const user = t ? await userFromToken(t) : null;
    if (!user) return handleError(reply, 401, 'Invalid stream token', 'INVALID_TOKEN');

    const { send, onClose } = openStream(reply, request);
    const client = { send };
    liveClients.add(client);
    broadcastOnline(); // newcomer is in the set, so this also primes the new connection

    let closed = false;
    let heartbeat: ReturnType<typeof setInterval>;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      liveClients.delete(client);
      broadcastOnline();
    };
    heartbeat = setInterval(() => {
      try {
        send({ online: liveClients.size });
      } catch {
        cleanup();
      }
    }, LIVE_HEARTBEAT_MS);
    onClose(cleanup);
  });

  // Live markets feed: tradeable set + sponsor-pause, pushed on change (replaces the per-client GET /markets
  // poll). Primes each connection immediately, then the shared ticker broadcasts to all; reconnects re-prime.
  app.get('/markets', async (request: FastifyRequest, reply: FastifyReply) => {
    const { t } = request.query as { t?: string };
    const user = t ? await userFromToken(t) : null;
    if (!user) return handleError(reply, 401, 'Invalid stream token', 'INVALID_TOKEN');

    const { send, onClose } = openStream(reply, request);
    const client = { send };
    marketClients.add(client);
    ensureMarketTicker();
    // Prime this connection immediately; the shared ticker only pushes on change, not on connect.
    void buildMarketsPayload()
      .then((p) => {
        try {
          send(p);
        } catch {
          // Socket already gone; its close handler prunes it.
        }
      })
      .catch(() => {});

    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      marketClients.delete(client);
      stopMarketTickerIfIdle();
    };
    onClose(cleanup);
  });

  // Live PnL for one open play, event-driven: the play bus (plays.ts commitPlay) fires the instant a status write commits, so pending->open and the settle reveal land in one RTT instead of a poll interval.
  // A slow mark cadence rides alongside for trickle P/L and as a safety net for any missed bus emit (split operator topology, TRADE_REALTIME.md §6); emits a terminal frame and closes once, whichever path sees it first.
  app.get('/plays/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    const { t } = request.query as { t?: string };
    const user = t ? await userFromToken(t) : null;
    if (!user) return handleError(reply, 401, 'Invalid stream token', 'INVALID_TOKEN');

    const play = await prismaQuery.play.findFirst({ where: { id, userId: user.id } });
    if (!play) return handleError(reply, 404, 'Play not found', 'NOT_FOUND');

    const { send, onClose } = openStream(reply, request);
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsub: (() => void) | undefined;

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      if (unsub) unsub();
    };
    // Tear down and send the socket FIN; guarded by `closed` so a terminal seen by both the event and cadence paths (or a race) ends the stream exactly once.
    const endStream = (): void => {
      if (closed) return;
      cleanup();
      try {
        reply.raw.end();
      } catch {
        // Socket already gone; nothing to end.
      }
    };

    // Build + push one frame from a row. `mark` is the optional live cash-out value (a ~1.5s chain devInspect); omit it on the instant push so a slow mark never delays pending->open.
    // Returns true once a terminal frame has closed the stream, so callers stop looping.
    const pushFrame = async (current: Play, mark?: bigint): Promise<boolean> => {
      if (closed) return true;
      const dto = await toPlayDTO(current, mark);
      if (closed) return true;
      try {
        send({
          markValue: dto.markValue,
          pnl: dto.pnl,
          multiplier: dto.multiplier,
          entryValue: dto.entryValue,
          maxPayout: dto.maxPayout,
          status: dto.status,
          lockPrice: dto.lockPrice,
          // Market fields too: a mid-flight re-route/restrike moves the real strike/band/entry/expiry, so push them so the client overlay + countdown snap to what actually minted, not the stale pending values.
          entrySpot: dto.entrySpot,
          strike: dto.market.strike,
          lower: dto.market.lower,
          upper: dto.market.upper,
          expiry: dto.market.expiry,
          ts: Date.now(),
        });
      } catch {
        // Socket died between the disconnect check and the write; tear down (no FIN, it's already gone).
        cleanup();
        return true;
      }
      if (TERMINAL.has(current.status)) {
        endStream();
        return true;
      }
      return false;
    };

    // Instant status push: the bus carries the committed row, so push it with NO DB read on the hot path (a
    // bulk sweep omits it, then read the one row). No mark devInspect here, so pending->open lands in 1 RTT.
    const onEvent = async (row?: Play): Promise<void> => {
      if (closed) return;
      const current = row ?? (await prismaQuery.play.findUnique({ where: { id } }).catch(() => null));
      if (closed || !current) return;
      await pushFrame(current);
    };
    unsub = onPlay(id, (row) => void onEvent(row));

    // Mark cadence: the slow, chain-bound trickle P/L and safety net that re-reads status each tick in case a bus emit was missed or came from another process.
    // Pre-buzzer, refresh the live mark; while settling (past expiry) skip the moot mark and poll status fast (SETTLING_POLL_MS) so a cross-process settle resolves within ~1s.
    const cadence = async (): Promise<void> => {
      if (closed) return;
      const current = await prismaQuery.play.findUnique({ where: { id } }).catch(() => null);
      if (closed) return;
      if (!current) {
        timer = setTimeout(() => void cadence(), PLAY_STREAM_INTERVAL_MS);
        return;
      }
      const settling = current.status === 'open' && Date.now() >= Number(current.expiry);
      const mark = current.status === 'open' && !settling ? await getLiveMarkCached(current).catch(() => undefined) : undefined;
      if (await pushFrame(current, mark)) return;
      timer = setTimeout(() => void cadence(), settling ? SETTLING_POLL_MS : PLAY_STREAM_INTERVAL_MS);
    };

    // One immediate frame on connect (no mark), then start the cadence loop for trickle mark + safety poll; a terminal play closes on that first frame and cadence never starts.
    onClose(cleanup);
    if (!(await pushFrame(play))) void cadence();
  });

  done();
};
