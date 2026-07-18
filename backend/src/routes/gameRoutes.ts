// Markets + the play lifecycle. Both auth modes finalize server-side and return a PlayDTO (dev signs
// as the operator, privy via a session signer). Predict errors come through as PlayError, mapped to friendly codes, never a raw Move abort.

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { handleError, handleNotFoundError } from '../utils/errorHandler.ts';
import { buildMarketsPayload } from '../lib/markets-feed.ts';
import { PlayError, httpStatusForPlayError, quoteRangeBatchReal, quoteRangeTiersReal } from '../services/games.ts';
import {
  createPlay,
  cashoutPlay,
  listPlays,
  getPlay,
  type CreatePlayInput,
} from '../services/plays.ts';
import type { Game } from '../types/api.ts';

const GAMES: Game[] = ['lucky', 'range', 'moonshot'];

// Funnel any thrown value to the envelope: PlayError is an EXPECTED business outcome (no live market,
// bad params, a buzzer race), so send its envelope directly and never log it; handleError would bury real faults under routine 4xx noise. Anything else is a 500 with no leaked details.
const fail = async (reply: FastifyReply, e: unknown, fallbackCode: string, fallbackMsg: string): Promise<FastifyReply> => {
  if (e instanceof PlayError) {
    reply.code(httpStatusForPlayError(e.code)).send({
      success: false,
      error: { code: e.code, message: e.message },
      data: null,
      timestamp: new Date().toISOString(),
    });
    return reply;
  }
  return handleError(reply, 500, fallbackMsg, fallbackCode, e as Error);
};

export const gameRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // The markets the games can trade right now (first paint; live updates ride /stream/markets). Lists
  // every priceable asset with an oracle-driven `live` flag, so display-only assets chart but never deal. See markets-feed.ts.
  app.get('/markets', { preHandler: [authMiddleware] }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Payload carries the sponsor-floor pause so a game can show "topping up" instead of a hard PLAY failure.
      return reply.code(200).send({ success: true, error: null, data: await buildMarketsPayload() });
    } catch (error) {
      return handleError(reply, 500, 'Could not load markets', 'MARKETS_FAILED', error as Error);
    }
  });

  // Pre-mint Range price previews for the whole band ladder off the live Predict ask, so the UI shows
  // what it will actually mint. Client fetches once on select and caches it (cheap, read-only, no DB). `widths` is a CSV of full-band widths (percent); static path so no collision with the play route.
  app.get('/games/range/quotes', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as { asset?: string; widths?: string; tiers?: string };
    const asset = (q.asset ?? '').toUpperCase();
    // Tier mode: price the server payout ladder (empty quotes + null model while no market is live; the client falls back).
    if (q.tiers) {
      if (!asset) {
        return fail(reply, new PlayError('INVALID_PARAMS', 'asset is required'), 'QUOTE_FAILED', 'Could not price those tiers');
      }
      const payload = await quoteRangeTiersReal();
      return reply.code(200).send({ success: true, error: null, data: payload ?? { quotes: [], model: null } });
    }
    const widthPcts = (q.widths ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!asset || widthPcts.length === 0) {
      return fail(reply, new PlayError('INVALID_PARAMS', 'asset and widths are required'), 'QUOTE_FAILED', 'Could not price those bands');
    }
    try {
      const quotes = quoteRangeBatchReal(widthPcts);
      return reply.code(200).send({ success: true, error: null, data: { quotes } });
    } catch (error) {
      return fail(reply, error, 'QUOTE_FAILED', 'Could not price those bands');
    }
  });

  // One endpoint per game, uniform shape. Body is the game-specific config plus a stake.
  app.post('/games/:game/play', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const game = (request.params as { game: string }).game as Game;
    if (!GAMES.includes(game)) return handleNotFoundError(reply, 'Game');

    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const input = buildCreateInput(game, body);
      const { play } = await createPlay(request.user!, input);
      return reply.code(200).send({ success: true, error: null, data: { play } });
    } catch (error) {
      return fail(reply, error, 'PLAY_FAILED', 'Could not place that play');
    }
  });

  // Early cash-out at the live mark. Finalized server-side in both auth modes.
  app.post('/plays/:id/cashout', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    try {
      const { play, unlocked } = await cashoutPlay(request.user!, id);
      return reply.code(200).send({ success: true, error: null, data: { play, unlocked } });
    } catch (error) {
      return fail(reply, error, 'CASHOUT_FAILED', 'Could not cash out');
    }
  });

  // Recent plays for history / stats.
  app.get('/plays', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as { status?: string; limit?: string };
    try {
      const plays = await listPlays(request.user!.id, { status: q.status, limit: q.limit ? Number(q.limit) : undefined });
      return reply.code(200).send({ success: true, error: null, data: { plays } });
    } catch (error) {
      return handleError(reply, 500, 'Could not load plays', 'PLAYS_FAILED', error as Error);
    }
  });

  // One play with its live mark / pnl.
  app.get('/plays/:id', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    try {
      const play = await getPlay(request.user!.id, id);
      if (!play) return handleNotFoundError(reply, 'Play');
      return reply.code(200).send({ success: true, error: null, data: { play } });
    } catch (error) {
      return handleError(reply, 500, 'Could not load play', 'PLAY_FAILED', error as Error);
    }
  });

  done();
};

// Validate + shape the per-game body into the service input. Throws PlayError on bad params.
function buildCreateInput(game: Game, body: Record<string, unknown>): CreatePlayInput {
  const stake = body.stake as string | number;
  if (stake == null) throw new PlayError('INVALID_PARAMS', 'Enter a play amount');

  if (game === 'lucky') {
    // LUCKY takes only the bet. The reel deals asset, direction, and multiplier tier server-side.
    return { game, stake };
  }

  if (game === 'moonshot') {
    // MOONSHOT: the player calls the direction (LONG/SHORT) and dials a reach (target multiple). The
    // round holds to the routed oracle's real expiry, so no duration is sent.
    const asset = String(body.asset ?? '');
    const side = body.side === 'down' ? 'down' : body.side === 'up' ? 'up' : null;
    const reach = Number(body.reach);
    if (!asset || !side || !Number.isFinite(reach)) {
      throw new PlayError('INVALID_PARAMS', 'Pick an asset, a direction, and a reach');
    }
    return { game, stake, asset, side, reach };
  }

  // range: the round holds to the routed oracle's real expiry, so the client sends no duration.
  // Two shapes: a payout `tier` (the knob's ladder index, the current game) or a legacy `widthPct` band.
  const asset = String(body.asset ?? '');
  if (!asset) throw new PlayError('INVALID_PARAMS', 'Pick an asset');
  if (body.tier != null) {
    const tier = Number(body.tier);
    if (!Number.isFinite(tier)) throw new PlayError('INVALID_PARAMS', 'Pick a payout tier');
    return { game, stake, asset, tier };
  }
  const widthPct = Number(body.widthPct);
  if (!Number.isFinite(widthPct)) {
    throw new PlayError('INVALID_PARAMS', 'Pick an asset and band width');
  }
  return { game, stake, asset, widthPct };
}
