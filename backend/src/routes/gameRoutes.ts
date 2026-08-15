// Markets + the play lifecycle. Both auth modes finalize server-side and return a PlayDTO (dev signs
// as the operator, privy via a session signer). Predict errors come through as PlayError, mapped to friendly codes, never a raw Move abort.

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { handleError, handleNotFoundError } from '../utils/errorHandler.ts';
import { buildMarketsPayload } from '../lib/markets-feed.ts';
import { spotHistory } from '../lib/price-history.ts';
import { PYTH_FEED_IDS } from '../lib/pyth.ts';
import {
  PlayError,
  RUSH_APPETITES,
  dealRushOffer,
  httpStatusForPlayError,
  maxStakeFor,
  parseStake,
  quoteMoonshotAimReal,
  quotePinModelReal,
  quoteSnipeModelReal,
  quoteRangeBatchReal,
  quoteRangeTiersReal,
  rushDealChance,
} from '../services/games.ts';
import {
  createPlay,
  cashoutPlay,
  listPlays,
  getPlay,
  type CreatePlayInput,
} from '../services/plays.ts';
import { dealTooSoon, dropOffers, liveOffer, noteDeal, putOffer, type RushOffer } from '../services/rush-offers.ts';
import { rakeOf } from '../lib/sui/house.ts';
import { canSeeGame } from '../config/games.ts';
import type { Game } from '../types/api.ts';

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

  // The chart's pre-roll: the last window of the display feed, recorded server-side so every device seeds
  // the same past line. `now` is the server clock the ages are measured against, so a skewed device still
  // lands the history at the right offset. Display-only (L-015).
  app.get('/prices/history', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const asset = ((request.query as { asset?: string }).asset ?? '').toUpperCase();
    if (!asset || !PYTH_FEED_IDS[asset]) return handleError(reply, 400, 'Unknown asset', 'VALIDATION_ERROR');
    return reply.code(200).send({
      success: true,
      error: null,
      data: { asset, now: Date.now(), points: spotHistory(asset) },
    });
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

  // MOONSHOT aim preview: the strike offset each reach mints at, so the aimed TARGET line equals the drawn
  // strike (mirrors the Range tier quote). Empty levels while no market is live; the client falls back.
  app.get('/games/moonshot/aim', { preHandler: [authMiddleware] }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const payload = quoteMoonshotAimReal();
    return reply.code(200).send({ success: true, error: null, data: payload ?? { levels: [] } });
  });

  // PIN's round model: spot, the calibrated vol, the pin's usable travel, and each WINDOW's half-width, so
  // the screen can redraw the box and its estimate every frame the knob moves without a call per frame.
  // Lab-gated like the play route, so the game's existence is not leaked by a probe.
  app.get('/games/pin/model', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!canSeeGame('pin', request.user!.specialRoles)) return handleNotFoundError(reply, 'Game');
    const model = await quotePinModelReal();
    return reply.code(200).send({ success: true, error: null, data: model ?? null });
  });

  // SNIPE's round model: spot, the clock, the calibrated vol, and the wall's mintable travel, so the knob can
  // plant a wall and the screen can read the exact gap every frame. Lab-gated like the play route.
  app.get('/games/snipe/model', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!canSeeGame('snipe', request.user!.specialRoles)) return handleNotFoundError(reply, 'Game');
    const model = await quoteSnipeModelReal();
    return reply.code(200).send({ success: true, error: null, data: model ?? null });
  });

  // RUSH's deal: the machine offers a band, or nothing this beat. The offer is stored server-side with the
  // exact ticks it would mint at and a short life, and the take references it by id, so the band and the
  // multiple are never the client's to assert. Lab-gated like the play route.
  app.post('/games/rush/deal', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!canSeeGame('rush', request.user!.specialRoles)) return handleNotFoundError(reply, 'Game');
    const body = (request.body ?? {}) as Record<string, unknown>;
    const userId = request.user!.id;
    // `now` is the server clock the offer's countdown is measured against: a 3s window has no room for the
    // device clock to disagree, so the client offsets rather than trusting its own.
    const dealt = (offer: RushOffer | null) =>
      reply.code(200).send({
        success: true,
        error: null,
        data: {
          now: Date.now(),
          offer: offer && {
            id: offer.id,
            lower: offer.lower,
            upper: offer.upper,
            multiplier: offer.multiplier,
            expiresAt: offer.expiresAt,
            expiryMs: offer.expiryMs,
          },
        },
      });
    try {
      const stakeRaw = parseStake(body.stake as string | number, maxStakeFor(request.user!));
      // One band on the table at a time. A repeat call while a deal is live returns that same deal rather
      // than quoting a fresh one, which is both the honest answer and the throttle on the shared fullnode.
      const live = liveOffer(userId);
      if (live?.stakeRaw === stakeRaw) return dealt(live);
      if (live) dropOffers(userId); // the chip moved under it, so that deal is not this player's bet any more
      if (dealTooSoon(userId)) return dealt(null);
      noteDeal(userId);
      const appetite = Math.max(1.05, Number(body.appetite) || RUSH_APPETITES[0]);
      // The rhythm is the route's, the price is the resolver's. Drawing here means a quiet beat costs nothing.
      if (Math.random() > rushDealChance(appetite)) return dealt(null);
      const solved = await dealRushOffer(appetite, rakeOf(stakeRaw).net);
      // Nothing on the table is a normal beat, not an error: it is what makes a high appetite go quiet.
      if (!solved) return dealt(null);
      return dealt(putOffer({ ...solved, userId, stakeRaw }));
    } catch (e) {
      return fail(reply, e, 'RUSH_DEAL_FAILED', 'Could not deal');
    }
  });

  // One endpoint per game, uniform shape. Body is the game-specific config plus a stake.
  app.post('/games/:game/play', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const game = (request.params as { game: string }).game;
    // A lab game is 404 for a non-admin, identical to a name that does not exist. Never 403.
    if (!canSeeGame(game, request.user!.specialRoles)) return handleNotFoundError(reply, 'Game');

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
    const q = request.query as { status?: string; limit?: string; network?: string };
    try {
      const plays = await listPlays(request.user!.id, { status: q.status, limit: q.limit ? Number(q.limit) : undefined, network: q.network });
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

  if (game === 'snipe') {
    // SNIPE: the wall is an absolute PRICE the player planted, and the side is what they committed to. Both
    // travel together, because re-deriving the side from a spot that has since crossed the wall flips the bet.
    const asset = String(body.asset ?? '');
    const wall = Number(body.wall);
    const side = body.side === 'down' ? 'down' : 'up';
    if (!asset || !Number.isFinite(wall)) throw new PlayError('INVALID_PARAMS', 'Plant a wall');
    return { game, stake, asset, wall, side };
  }

  if (game === 'rush') {
    // A take names an OFFER, never a band. The bounds, the ticks and the multiple all come from the
    // server's own record of what it dealt, so nothing about the bet is assertable from here.
    const asset = String(body.asset ?? '');
    const offerId = String(body.offerId ?? '');
    if (!asset || !offerId) throw new PlayError('INVALID_PARAMS', 'That offer is gone');
    return { game, stake, asset, offerId };
  }

  if (game === 'press') {
    // PRESS: the client picks only the OPENING width, by ladder index. How deep the round already is and
    // which box a press nests inside are read off the player's own open boxes server-side, never sent.
    const asset = String(body.asset ?? '');
    const open = Number(body.open);
    if (!asset || !Number.isFinite(open)) throw new PlayError('INVALID_PARAMS', 'Pick an opening width');
    return { game, stake, asset, open };
  }

  if (game === 'pin') {
    // PIN: the player names a price and picks how much slack sits around it. The server owns the window
    // ladder, so the client sends its index, never a dollar width.
    const asset = String(body.asset ?? '');
    const pin = Number(body.pin);
    const window = Number(body.window);
    if (!asset || !Number.isFinite(pin) || !Number.isFinite(window)) {
      throw new PlayError('INVALID_PARAMS', 'Name a price and pick a window');
    }
    return { game, stake, asset, pin, window };
  }

  if (game === 'range') {
    // The round holds to the routed oracle's real expiry, so the client sends no duration. Two shapes:
    // a payout `tier` (the knob's ladder index, the current game) or a legacy `widthPct` band.
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

  throw new PlayError('INVALID_PARAMS', 'That game is not playable yet');
}
