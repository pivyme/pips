// SSE streams: the game chart price feed and a live PnL feed per open play. EventSource
// cannot set headers, so auth is a short-lived JWT in the query (`?t=`). Both validate
// before hijacking the socket, so auth failures still return a normal JSON envelope.

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { handleError } from '../utils/errorHandler.ts';
import { userFromToken } from '../services/auth.ts';
import { gameSpot } from '../lib/game-price.ts';
import { getLiveMarkRaw, toPlayDTO } from '../services/plays.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { PYTH_FEED_IDS } from '../lib/pyth.ts';

const TERMINAL = new Set(['won', 'lost', 'cashed_out', 'error']);

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
  // Chart price feed for one asset. ~1s server cadence; the client interpolates to 60fps.
  app.get('/prices', async (request: FastifyRequest, reply: FastifyReply) => {
    const { asset, t } = request.query as { asset?: string; t?: string };
    if (!asset || !PYTH_FEED_IDS[asset]) return handleError(reply, 400, 'Unknown asset', 'VALIDATION_ERROR');
    const user = t ? await userFromToken(t) : null;
    if (!user) return handleError(reply, 401, 'Invalid stream token', 'INVALID_TOKEN');

    const { send, onClose } = openStream(reply, request);
    const tick = async (): Promise<void> => {
      const spot = await gameSpot(asset);
      if (spot) send({ price: String(spot.price), ts: spot.ts });
    };
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    onClose(() => clearInterval(timer));
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
    let timer: ReturnType<typeof setInterval>;

    const tick = async (): Promise<void> => {
      if (closed) return;
      const current = await prismaQuery.play.findUnique({ where: { id } });
      if (!current) return;
      const mark = current.status === 'open' ? await getLiveMarkRaw(current).catch(() => undefined) : undefined;
      const dto = await toPlayDTO(current, mark);
      send({ markValue: dto.markValue, pnl: dto.pnl, multiplier: dto.multiplier, status: dto.status, ts: Date.now() });
      if (TERMINAL.has(current.status)) {
        closed = true;
        clearInterval(timer);
        reply.raw.end();
      }
    };

    void tick();
    timer = setInterval(() => void tick(), 1000);
    onClose(() => {
      closed = true;
      clearInterval(timer);
    });
  });

  done();
};
