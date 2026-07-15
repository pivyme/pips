import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { handleError } from '../utils/errorHandler.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { resolveReferrer } from '../services/auth.ts';
import type { ReferralDTO, ReferralInfoDTO } from '../types/api.ts';

// Everyone this user referred, newest first, with each referee's play count.
async function loadReferrals(userId: string): Promise<ReferralDTO[]> {
  const referred = await prismaQuery.user.findMany({
    where: { referredById: userId },
    select: { username: true, displayName: true, createdAt: true, _count: { select: { plays: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return referred.map((r) => ({
    handle: r.username ?? r.displayName,
    joinedAt: r.createdAt.toISOString(),
    plays: r._count.plays,
  }));
}

export const referralRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // Your link state + who joined through it.
  app.get('/', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const me = request.user!;
    try {
      const referrals = await loadReferrals(me.id);
      const data: ReferralInfoDTO = { code: me.referralCode ?? '', anon: me.referralAnon, username: me.username, count: referrals.length, referrals };
      return reply.code(200).send({ success: true, error: null, data });
    } catch (error) {
      return handleError(reply, 500, 'Could not load your referrals', 'REFERRAL_LOAD_FAILED', error as Error);
    }
  });

  // Flip the link format (username <-> anon code).
  app.patch('/', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const me = request.user!;
    const body = (request.body ?? {}) as { anon?: boolean };
    if (typeof body.anon !== 'boolean') return handleError(reply, 400, 'anon must be a boolean', 'REFERRAL_ANON_INVALID');
    try {
      const updated = await prismaQuery.user.update({ where: { id: me.id }, data: { referralAnon: body.anon } });
      const referrals = await loadReferrals(me.id);
      const data: ReferralInfoDTO = {
        code: updated.referralCode ?? '',
        anon: updated.referralAnon,
        username: updated.username,
        count: referrals.length,
        referrals,
      };
      return reply.code(200).send({ success: true, error: null, data });
    } catch (error) {
      return handleError(reply, 500, 'Could not update your link', 'REFERRAL_UPDATE_FAILED', error as Error);
    }
  });

  // Public, unauthenticated: what the door shows for a stashed referral token. Already-public info
  // (handles are listed on /leaderboard too), so this leaks nothing new.
  app.get('/resolve', async (request: FastifyRequest, reply: FastifyReply) => {
    const ref = (request.query as { ref?: string } | undefined)?.ref;
    const referrer = await resolveReferrer(ref);
    const handle = referrer && !referrer.referralAnon && referrer.username ? referrer.username : null;
    return reply.code(200).send({ success: true, error: null, data: { valid: Boolean(referrer), handle } });
  });

  done();
};
