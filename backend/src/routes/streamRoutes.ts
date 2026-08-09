// SSE streams: the game chart price feed and a live PnL feed per open play.
// EventSource can't set headers, so auth is a JWT in the query (`?t=`); both validate before hijacking, so auth failures still return a normal JSON envelope.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import type { Play } from '../../prisma/generated/client.js';
import { handleError } from '../utils/errorHandler.ts';
import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { PLAY_STREAM_INTERVAL_MS } from '../config/main-config.ts';
import { userFromToken } from '../services/auth.ts';
import { displaySpot } from '../lib/price-bus.ts';
import { onPlay } from '../lib/play-bus.ts';
import { buildMarketsPayload, liveSetSignature } from '../lib/markets-feed.ts';
import { getLiveMarkCached, toPlayDTO } from '../services/plays.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { PYTH_FEED_IDS } from '../lib/pyth.ts';
import { platformFrom } from '../config/analytics-catalog.ts';

const TERMINAL = new Set(['won', 'lost', 'cashed_out', 'error']);

// Past the buzzer the live mark is moot (about to become the final payout), so poll status this fast instead, landing the won/lost frame within ~1s of the worker resolving it.
const SETTLING_POLL_MS = 1000;

// Presence keepalive: the feed only pushes on join/leave, so without this an idle proxy drops the socket; also self-heals a client that missed a broadcast.
const LIVE_HEARTBEAT_MS = 25_000;

// Live presence: one connection per open app session (held at the app shell, so it spans home/games/menu,
// not just Home). One process serves every client, so this map is the global set.
//
// A socket close is the fast path out, not the only one. A tab that dies without a clean disconnect (phone
// sleeps, network switches, a proxy holding the connection open) never fires `close`, and the session used
// to sit here as LIVE until the next restart, which is how the dashboard grew a row idle for three hours.
// So each session also has to be claimed: the client pings, and a session that stops pinging is swept and
// its socket ended, which the browser answers with EventSource's own reconnect. Being frozen in a
// background tab therefore reads as gone, which is what "online now" is supposed to mean.
const PRESENCE_TTL_MS = 150_000; // ~3 missed client pings, wide enough for a throttled background timer
const PRESENCE_SWEEP_MS = 30_000;
// A session that has never pinged is a tab on a bundle from before the ping existed, so it gets the old
// socket-lifetime behaviour bounded instead of being cut every 2.5 minutes and reconnect-looping. Doubles
// as the floor if the client's ping ever breaks: presence goes stale, never blank.
const UNCLAIMED_TTL_MS = 20 * 60_000;

interface LiveSession {
  userId: string;
  platform: string | null;
  since: number;
  lastPingAt: number;
  claimed: boolean;
  send: (data: unknown) => void;
  end: () => void;
}
const liveSessions = new Map<string, LiveSession>();
let presenceSweeper: ReturnType<typeof setInterval> | null = null;

export function onlineUserIds(): string[] {
  return [...new Set([...liveSessions.values()].map((s) => s.userId))];
}

// Who is online, with session count, arrival time and the device the connection came from. Read by the
// admin dashboard's live panel, where an open session whose device is unknown is a read we got wrong.
// `since` is the oldest still-open session, so a second tab does not reset how long they have been here.
export function onlinePresence(): Array<{ userId: string; sessions: number; since: number; platform: string | null }> {
  const byUser = new Map<string, { userId: string; sessions: number; since: number; platform: string | null }>();
  for (const s of liveSessions.values()) {
    const p = byUser.get(s.userId);
    if (!p) byUser.set(s.userId, { userId: s.userId, sessions: 1, since: s.since, platform: s.platform });
    else {
      p.sessions += 1;
      p.since = Math.min(p.since, s.since);
      if (s.platform) p.platform = s.platform; // the newest connection wins the device
    }
  }
  return [...byUser.values()];
}

// Open connections, not distinct people: two tabs count twice. This is what the product's "N ONLINE" ticker shows.
export function liveSessionCount(): number {
  return liveSessions.size;
}

/** Refresh a session's claim. Returns false for an unknown or someone else's session id. */
export function presencePing(sessionId: string, userId: string): boolean {
  const s = liveSessions.get(sessionId);
  if (!s || s.userId !== userId) return false;
  s.lastPingAt = Date.now();
  s.claimed = true;
  return true;
}

// Ends the socket rather than only forgetting it, so the client is told to reconnect instead of holding a
// stream nobody counts. Runs only while someone is connected.
function ensurePresenceSweeper(): void {
  if (presenceSweeper) return;
  presenceSweeper = setInterval(() => {
    const now = Date.now();
    let dropped = 0;
    for (const [id, s] of liveSessions) {
      if (now - s.lastPingAt < (s.claimed ? PRESENCE_TTL_MS : UNCLAIMED_TTL_MS)) continue;
      liveSessions.delete(id);
      dropped += 1;
      s.end();
    }
    if (dropped) broadcastOnline();
    if (liveSessions.size === 0 && presenceSweeper) {
      clearInterval(presenceSweeper);
      presenceSweeper = null;
    }
  }, PRESENCE_SWEEP_MS);
  (presenceSweeper as { unref?: () => void }).unref?.();
}

function broadcastOnline(): void {
  const payload = { online: liveSessions.size };
  for (const s of liveSessions.values()) {
    try {
      s.send(payload);
    } catch {
      // Dead socket; its close handler prunes it from the map.
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
  // Every frame carries the session id, so a client that reconnects always knows which session to keep claiming.
  app.get('/live', async (request: FastifyRequest, reply: FastifyReply) => {
    const { t } = request.query as { t?: string };
    const user = t ? await userFromToken(t) : null;
    if (!user) return handleError(reply, 401, 'Invalid stream token', 'INVALID_TOKEN');

    const { send, onClose } = openStream(reply, request);
    const sid = randomUUID();
    // No standalone hint on an EventSource request, so an iOS PWA reads as ios here; an analytics event,
    // when there is one, refines it to pwa.
    const platform = platformFrom(request.headers['user-agent'], false);

    let closed = false;
    let heartbeat: ReturnType<typeof setInterval>;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      liveSessions.delete(sid);
      broadcastOnline();
    };
    const end = (): void => {
      cleanup();
      try {
        reply.raw.end();
      } catch {
        // Socket already gone; nothing to end.
      }
    };

    // mark this user online for the presence-gated wallet indexer
    liveSessions.set(sid, {
      userId: user.id,
      platform,
      since: Date.now(),
      lastPingAt: Date.now(),
      claimed: false,
      send: (d) => send({ ...(d as object), sid }),
      end,
    });
    ensurePresenceSweeper();
    broadcastOnline(); // newcomer is in the map, so this also primes the new connection

    heartbeat = setInterval(() => {
      try {
        send({ online: liveSessions.size, sid });
      } catch {
        cleanup();
      }
    }, LIVE_HEARTBEAT_MS);
    onClose(cleanup);
  });

  // The client's claim on its session. Without it a socket nobody is behind counts as a person, which is
  // how "LIVE, here 3h, idle" rows appeared. Cheap by design: one small POST a minute per open session.
  app.post('/live/ping', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { sid } = (request.body ?? {}) as { sid?: string };
    const alive = !!sid && presencePing(sid, request.user!.id);
    return reply.code(200).send({ success: true, error: null, data: { alive } });
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
