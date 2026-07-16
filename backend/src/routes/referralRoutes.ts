import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { handleError } from '../utils/errorHandler.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { resolveReferrer } from '../services/auth.ts';
import {
  claimReferral,
  httpStatusForReferralError,
  listClaims,
  MIN_CLAIM_USD,
  perRefereeEarned,
  ReferralError,
  referralRewards,
  SHARE_PCT,
  toReferralClaimDTO,
} from '../services/referral.ts';
import { RATE_LIMIT_REFERRAL_CLAIM_MAX, RATE_LIMIT_WINDOW } from '../config/main-config.ts';
import { formatDusdcRaw } from '../lib/sui/config.ts';
import type { ReferralDTO, ReferralInfoDTO } from '../types/api.ts';

// Everyone this user referred, newest first, with each referee's play count + what they've earned the
// referrer so far. Earnings are folded in from one groupBy over the Play ledger (perRefereeEarned).
async function loadReferrals(userId: string): Promise<ReferralDTO[]> {
  const [referred, earnedByReferee] = await Promise.all([
    prismaQuery.user.findMany({
      where: { referredById: userId },
      select: { id: true, username: true, displayName: true, createdAt: true, _count: { select: { plays: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    perRefereeEarned(userId),
  ]);
  return referred.map((r) => ({
    handle: r.username ?? r.displayName,
    joinedAt: r.createdAt.toISOString(),
    plays: r._count.plays,
    earned: formatDusdcRaw(earnedByReferee.get(r.id) ?? 0n),
  }));
}

// The full /referral payload: link state, referees (with per-friend earnings), and the reward summary +
// claim history. One fetch for the whole screen, reusing the existing ['referral'] query key.
async function loadInfo(userId: string, code: string, anon: boolean, username: string | null): Promise<ReferralInfoDTO> {
  const [referrals, rewards, claims] = await Promise.all([
    loadReferrals(userId),
    referralRewards(userId),
    listClaims(userId),
  ]);
  return {
    code,
    anon,
    username,
    count: referrals.length,
    referrals,
    sharePct: SHARE_PCT,
    totalEarned: formatDusdcRaw(rewards.earned),
    totalClaimed: formatDusdcRaw(rewards.claimed),
    claimable: formatDusdcRaw(rewards.claimable),
    minClaim: MIN_CLAIM_USD.toFixed(2),
    claims: claims.map(toReferralClaimDTO),
  };
}

export const referralRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // Per-IP cap on top of the per-referrer advisory lock + $1 min: a claim moves funds, so gate it like withdraw.
  const claimLimit = { rateLimit: { max: RATE_LIMIT_REFERRAL_CLAIM_MAX, timeWindow: RATE_LIMIT_WINDOW } };

  // Your link state, who joined through it, and your rewards.
  app.get('/', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const me = request.user!;
    try {
      const data = await loadInfo(me.id, me.referralCode ?? '', me.referralAnon, me.username);
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
      const data = await loadInfo(updated.id, updated.referralCode ?? '', updated.referralAnon, updated.username);
      return reply.code(200).send({ success: true, error: null, data });
    } catch (error) {
      return handleError(reply, 500, 'Could not update your link', 'REFERRAL_UPDATE_FAILED', error as Error);
    }
  });

  // Claim the spendable referral balance into playable DUSDC chips. Returns the refreshed screen payload.
  app.post('/claim', { preHandler: [authMiddleware], config: claimLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const me = request.user!;
    try {
      await claimReferral(me);
      const data = await loadInfo(me.id, me.referralCode ?? '', me.referralAnon, me.username);
      return reply.code(200).send({ success: true, error: null, data });
    } catch (error) {
      if (error instanceof ReferralError) return handleError(reply, httpStatusForReferralError(error.code), error.message, error.code);
      return handleError(reply, 500, 'Could not claim your rewards', 'REFERRAL_CLAIM_FAILED', error as Error);
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
