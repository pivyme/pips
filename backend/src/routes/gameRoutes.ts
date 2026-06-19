// Markets + the play lifecycle. Both auth modes finalize server-side and return a PlayDTO (dev
// signs as the operator, privy signs with the user's wallet via a session signer). Predict errors
// come through as PlayError and map to friendly codes, never a raw Move abort.

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { handleError, handleNotFoundError } from '../utils/errorHandler.ts';
import { EXPIRY_SAFETY_MS, GAME_DURATIONS } from '../config/main-config.ts';
import { allMarkets, tradeableMarkets } from '../lib/sui/markets.ts';
import { getSpot } from '../lib/price-cache.ts';
import { PlayError, httpStatusForPlayError } from '../services/games.ts';
import {
  createPlay,
  cashoutPlay,
  listPlays,
  getPlay,
  type CreatePlayInput,
} from '../services/plays.ts';
import type { Game, MarketDTO } from '../types/api.ts';

const GAMES: Game[] = ['lucky', 'range', 'tap'];

// Funnel any thrown value to the envelope: PlayError keeps its friendly code, anything else
// is a 500 we do not leak details of.
const fail = (reply: FastifyReply, e: unknown, fallbackCode: string, fallbackMsg: string): Promise<FastifyReply> => {
  if (e instanceof PlayError) return handleError(reply, httpStatusForPlayError(e.code), e.message, e.code);
  return handleError(reply, 500, fallbackMsg, fallbackCode, e as Error);
};

export const gameRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // The markets the games can trade right now. Spot comes from Pyth; `live` reflects whether
  // an oracle is fresh and far enough from expiry to mint against.
  app.get('/markets', { preHandler: [authMiddleware] }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const now = Date.now();
      const live = new Set(tradeableMarkets(now, EXPIRY_SAFETY_MS).map((m) => m.underlying));
      const assets = [...new Set(allMarkets().map((m) => m.underlying))];

      const markets: MarketDTO[] = await Promise.all(
        assets.map(async (asset) => {
          const spot = await getSpot(asset);
          return { asset, spot: spot ? String(spot.price) : '0', durations: GAME_DURATIONS, live: live.has(asset) };
        }),
      );
      return reply.code(200).send({ success: true, error: null, data: { markets } });
    } catch (error) {
      return handleError(reply, 500, 'Could not load markets', 'MARKETS_FAILED', error as Error);
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
  if (stake == null) throw new PlayError('INVALID_PARAMS', 'Enter a bet amount');

  if (game === 'lucky') {
    // LUCKY takes only the bet. The reel deals asset, direction, and multiplier tier server-side.
    return { game, stake };
  }

  if (game === 'range') {
    // The round holds to the routed oracle's real expiry, so the client sends no duration.
    const widthPct = Number(body.widthPct);
    const asset = String(body.asset ?? '');
    if (!asset || !Number.isFinite(widthPct)) {
      throw new PlayError('INVALID_PARAMS', 'Pick an asset and band width');
    }
    return { game, stake, asset, widthPct };
  }

  // tap
  const band = body.band as { lower?: number; upper?: number } | undefined;
  const duration = Number(body.duration);
  const asset = String(body.asset ?? '');
  if (!asset || !band || band.lower == null || band.upper == null || !Number.isFinite(duration)) {
    throw new PlayError('INVALID_PARAMS', 'Pick an asset, a box, and duration');
  }
  return { game, stake, asset, band: { lower: Number(band.lower), upper: Number(band.upper) }, duration };
}
