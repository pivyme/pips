// Leaderboards: global Gainers/REKT, per-game winners (Lucky/Range), and minigame high scores
// (Line Rider / Flappy Piper). All read-mostly and authed (so each board can flag the caller's own
// row). Every row carries username + displayName only, never an address. See services/leaderboard.ts.

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { handleError } from '../utils/errorHandler.ts';
import {
  fullLeaderboard,
  gameLeaderboard,
  minigameLeaderboard,
  submitMinigameScore,
} from '../services/leaderboard.ts';
import type { Game, Minigame } from '../types/api.ts';

const GAMES = new Set<Game>(['lucky', 'range']);
const MINIGAMES = new Set<Minigame>(['line-rider', 'candle-hop']);
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

  // Submit a finished minigame run; keeps the player's best.
  app.post('/minigame/:game', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const game = (request.params as { game: string }).game as Minigame;
    if (!MINIGAMES.has(game)) return handleError(reply, 400, 'Unknown minigame', 'BAD_GAME');
    const raw = (request.body as { score?: unknown })?.score;
    const score = Math.floor(Number(raw));
    if (!Number.isFinite(score) || score < 0 || score > MAX_SCORE) {
      return handleError(reply, 400, 'Invalid score', 'BAD_SCORE');
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
