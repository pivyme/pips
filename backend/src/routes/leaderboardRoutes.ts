// Leaderboards: global Gainers/REKT, per-game winners, and minigame high scores. Authed so each board
// can flag the caller's own row; every row carries username + displayName only, never an address.

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { handleError } from '../utils/errorHandler.ts';
import {
  checkRun,
  fullLeaderboard,
  gameLeaderboard,
  minigameLeaderboard,
  openMinigameRun,
  submitMinigameScore,
} from '../services/leaderboard.ts';
import type { Game, Minigame } from '../types/api.ts';

const GAMES = new Set<Game>(['lucky', 'range', 'moonshot']);
const MINIGAMES = new Set<Minigame>(['line-rider', 'flappy-piper']);
const MAX_SCORE = 100_000_000; // a sane ceiling so a tampered client can't park garbage at #1

export const leaderboardRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // Every board in one response (global Gainers/REKT + per-game winners + minigame scores), so the
  // menu fetches once and switches tabs with no refetch.
  app.get('/', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const leaderboard = await fullLeaderboard(request.user!.id);
      return reply.code(200).send({ success: true, error: null, data: { leaderboard } });
    } catch (error) {
      return handleError(reply, 500, 'Could not load the leaderboard', 'LEADERBOARD_FAILED', error as Error);
    }
  });

  // Per-game winners: Lucky or Range, by summed PnL.
  app.get('/game/:game', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const game = (request.params as { game: string }).game as Game;
    if (!GAMES.has(game)) return handleError(reply, 400, 'Unknown game', 'BAD_GAME');
    try {
      const leaderboard = await gameLeaderboard(game, request.user!.id);
      return reply.code(200).send({ success: true, error: null, data: { leaderboard } });
    } catch (error) {
      return handleError(reply, 500, 'Could not load the leaderboard', 'LEADERBOARD_FAILED', error as Error);
    }
  });

  // Minigame high scores.
  app.get('/minigame/:game', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const game = (request.params as { game: string }).game as Minigame;
    if (!MINIGAMES.has(game)) return handleError(reply, 400, 'Unknown minigame', 'BAD_GAME');
    try {
      const leaderboard = await minigameLeaderboard(game, request.user!.id);
      return reply.code(200).send({ success: true, error: null, data: { leaderboard } });
    } catch (error) {
      return handleError(reply, 500, 'Could not load the leaderboard', 'LEADERBOARD_FAILED', error as Error);
    }
  });

  // Open a run before playing; returns the token required to submit its score.
  app.post('/minigame/:game/start', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const game = (request.params as { game: string }).game as Minigame;
    if (!MINIGAMES.has(game)) return handleError(reply, 400, 'Unknown minigame', 'BAD_GAME');
    const runToken = openMinigameRun(request.user!.id, game);
    return reply.code(200).send({ success: true, error: null, data: { runToken } });
  });

  // Submit a finished minigame run; keeps the player's best. The run is validated first.
  app.post('/minigame/:game', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const game = (request.params as { game: string }).game as Minigame;
    if (!MINIGAMES.has(game)) return handleError(reply, 400, 'Unknown minigame', 'BAD_GAME');
    const body = (request.body as { score?: unknown; runToken?: unknown }) ?? {};
    const score = Math.floor(Number(body.score));
    if (!Number.isFinite(score) || score < 0 || score > MAX_SCORE) {
      return handleError(reply, 400, 'Invalid score', 'BAD_SCORE');
    }
    const check = checkRun(request.user!.id, game, score, body.runToken);
    if (!check.ok) {
      request.log.warn({ game, userId: request.user!.id, reason: check.reason }, 'minigame run rejected');
      return handleError(reply, 400, 'Could not record that run', 'RUN_REJECTED');
    }
    try {
      const result = await submitMinigameScore(request.user!.id, game, score);
      return reply.code(200).send({ success: true, error: null, data: { result } });
    } catch (error) {
      return handleError(reply, 500, 'Could not save your score', 'SCORE_FAILED', error as Error);
    }
  });

  done();
};
