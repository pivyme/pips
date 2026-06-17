// Stats card, achievements grid, and settings. All read-mostly; settings PATCH persists
// immediately with no confirm step. Amounts convert to display strings at this edge.

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { handleError } from '../utils/errorHandler.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { fromDusdcRaw } from '../lib/sui/config.ts';
import { evaluateMetrics } from '../services/achievements.ts';
import type { AchievementDTO, Game, UserStatsDTO } from '../types/api.ts';

const money = (raw: bigint): string => fromDusdcRaw(raw).toFixed(2);

export const menuRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // The shareable stats card.
  app.get('/stats', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const s = await prismaQuery.userStats.findUnique({ where: { userId: request.user!.id } });
      const stats: UserStatsDTO = {
        gamesPlayed: s?.gamesPlayed ?? 0,
        wins: s?.wins ?? 0,
        losses: s?.losses ?? 0,
        winRate: s && s.gamesPlayed > 0 ? s.wins / s.gamesPlayed : 0,
        currentStreak: s?.currentStreak ?? 0,
        maxStreak: s?.maxStreak ?? 0,
        totalVolume: money(s?.totalVolume ?? 0n),
        netPnl: money(s?.netPnl ?? 0n),
        firstPlayAt: s?.firstPlayAt?.toISOString(),
        favoriteGame: (s?.favoriteGame as Game) ?? undefined,
      };
      return reply.code(200).send({ success: true, error: null, data: { stats } });
    } catch (error) {
      return handleError(reply, 500, 'Could not load stats', 'STATS_FAILED', error as Error);
    }
  });

  // Full catalog with per-user unlock state and progress toward the locked ones.
  app.get('/achievements', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = request.user!.id;
      const [catalog, unlocked, stats, plays] = await Promise.all([
        prismaQuery.achievement.findMany({ orderBy: { sortOrder: 'asc' } }),
        prismaQuery.userAchievement.findMany({ where: { userId } }),
        prismaQuery.userStats.findUnique({ where: { userId } }),
        prismaQuery.play.findMany({ where: { userId } }),
      ]);
      const unlockedAt = new Map(unlocked.map((u) => [u.achievementSlug, u.unlockedAt]));
      const metrics = stats ? evaluateMetrics(stats, plays) : {};

      const achievements: AchievementDTO[] = catalog.map((a) => {
        const at = unlockedAt.get(a.slug);
        const current = Math.min(metrics[a.metric] ?? 0, a.threshold);
        return {
          slug: a.slug,
          name: a.name,
          description: a.description,
          illo: a.illo,
          unlocked: at != null,
          unlockedAt: at?.toISOString(),
          progress: at != null ? undefined : { current, target: a.threshold },
        };
      });
      return reply.code(200).send({ success: true, error: null, data: { achievements } });
    } catch (error) {
      return handleError(reply, 500, 'Could not load achievements', 'ACHIEVEMENTS_FAILED', error as Error);
    }
  });

  app.get('/settings', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const u = request.user!;
    return reply
      .code(200)
      .send({ success: true, error: null, data: { settings: { sound: u.soundEnabled, haptics: u.hapticsEnabled, reducedMotion: u.reducedMotion } } });
  });

  app.patch('/settings', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { sound?: boolean; haptics?: boolean; reducedMotion?: boolean };
    try {
      const updated = await prismaQuery.user.update({
        where: { id: request.user!.id },
        data: {
          ...(typeof body.sound === 'boolean' ? { soundEnabled: body.sound } : {}),
          ...(typeof body.haptics === 'boolean' ? { hapticsEnabled: body.haptics } : {}),
          ...(typeof body.reducedMotion === 'boolean' ? { reducedMotion: body.reducedMotion } : {}),
        },
      });
      return reply
        .code(200)
        .send({ success: true, error: null, data: { settings: { sound: updated.soundEnabled, haptics: updated.hapticsEnabled, reducedMotion: updated.reducedMotion } } });
    } catch (error) {
      return handleError(reply, 500, 'Could not save settings', 'SETTINGS_FAILED', error as Error);
    }
  });

  done();
};
