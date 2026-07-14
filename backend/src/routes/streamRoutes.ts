// SSE streams: the game chart price feed and a live PnL feed per open play. EventSource
// cannot set headers, so auth is a short-lived JWT in the query (`?t=`). Both validate
// before hijacking the socket, so auth failures still return a normal JSON envelope.

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { handleError } from '../utils/errorHandler.ts';
import { PLAY_STREAM_INTERVAL_MS } from '../config/main-config.ts';
import { userFromToken } from '../services/auth.ts';
import { displaySpot } from '../lib/price-bus.ts';
import { getLiveMarkCached, toPlayDTO } from '../services/plays.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { PYTH_FEED_IDS } from '../lib/pyth.ts';

const TERMINAL = new Set(['won', 'lost', 'cashed_out', 'error']);

// Once a round is past its buzzer the play is 'settling' on the client and the live mark is moot
// (about to become the final payout). Poll the status this fast then, so the won/lost frame lands
// within ~1s of the worker resolving it instead of waiting out a full live-mark interval.
const SETTLING_POLL_MS = 1000;

// Presence keepalive. The live feed is event-driven (we only push on join/leave), so without a
// periodic frame an idle proxy would hang the socket up. Re-sending the count on this interval is
// the heartbeat and also self-heals any client that missed a broadcast.
const LIVE_HEARTBEAT_MS = 25_000;

// Live presence: every open app holds one connection here for its whole session (the client opens it
// at the app shell, so it stays up across home, games, and menu, not just on the Home screen).
// Broadcast the current count to all of them on every join/leave so the "N ONLINE" ticker moves in
// real time. One process serves every web client (frontend talks to a single API), so this Set is the
// global count.
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
  // Chart price feed for one asset. ~1s server cadence; the client interpolates to 60fps. Serves the
  // display bus (Binance motion pinned to the on-chain oracle in real mode, gameSpot in fork mode), a
  // cosmetic feed only, every truthful number reads the chain (L-015). The WS hub (/ws) supersedes this
  // at 10Hz; this SSE route stays as the flagged fallback for one release.
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

  // Live presence: one connection per open app session (held at the client app shell, so a player
  // stays counted while playing a game, not only on Home). No per-client tick beyond the keepalive,
  // the count is pushed to everyone on join/leave. Drives the "N ONLINE" ticker on the device home.
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

  // Live PnL for one open play. Emits a terminal frame and closes once the play settles.
  app.get('/plays/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    const { t } = request.query as { t?: string };
    const user = t ? await userFromToken(t) : null;
    if (!user) return handleError(reply, 401, 'Invalid stream token', 'INVALID_TOKEN');

    const play = await prismaQuery.play.findFirst({ where: { id, userId: user.id } });
    if (!play) return handleError(reply, 404, 'Play not found', 'NOT_FOUND');

    const { send, onClose } = openStream(reply, request);
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async (): Promise<void> => {
      if (closed) return;
      const current = await prismaQuery.play.findUnique({ where: { id } });
      if (!current) {
        timer = setTimeout(() => void tick(), PLAY_STREAM_INTERVAL_MS);
        return;
      }
      // Past the buzzer the round is settling: skip the ~1.5s live-mark devInspect (the mark is about
      // to be the payout) and just poll the status fast so the result frame is near-instant.
      const settling = current.status === 'open' && Date.now() >= Number(current.expiry);
      const mark = current.status === 'open' && !settling ? await getLiveMarkCached(current).catch(() => undefined) : undefined;
      const dto = await toPlayDTO(current, mark);
      send({
        markValue: dto.markValue,
        pnl: dto.pnl,
        multiplier: dto.multiplier,
        entryValue: dto.entryValue,
        maxPayout: dto.maxPayout,
        status: dto.status,
        lockPrice: dto.lockPrice,
        ts: Date.now(),
      });
      if (TERMINAL.has(current.status)) {
        closed = true;
        reply.raw.end();
        return;
      }
      timer = setTimeout(() => void tick(), settling ? SETTLING_POLL_MS : PLAY_STREAM_INTERVAL_MS);
    };

    void tick();
    onClose(() => {
      closed = true;
      clearTimeout(timer);
    });
  });

  done();
};
