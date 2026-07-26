// Analytics ingest (POST /a/*) and the admin dashboard reads (GET /admin/*). Mounted with no prefix so
// the ingest paths stay bland and so nothing collides with the unrelated POST /deposit/track.
// See bigdev/plans/cont/03-ADMIN-DASHBOARD.md §4.2 and §7.

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { adminMiddleware } from '../middlewares/adminMiddleware.ts';
import { getSetting } from '../config/admin-settings.ts';
import { RATE_LIMIT_WINDOW, SUI_NETWORK } from '../config/main-config.ts';

export const analyticsRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // The dashboard's own bucket, read live off the setting so tuning it is a UI edit, not a deploy.
  const admin = {
    config: { rateLimit: { max: () => getSetting('rate.admin_max'), timeWindow: RATE_LIMIT_WINDOW } },
    preHandler: adminMiddleware,
  };

  // Liveness for the gate itself: 200 for an ADMIN, 404 for everyone else including anonymous.
  app.get('/admin/ping', admin, async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(200).send({
      success: true,
      error: null,
      data: {
        ok: true,
        user: { id: request.user?.id, username: request.user?.username ?? null },
        network: SUI_NETWORK,
        analyticsEnabled: await getSetting('analytics.enabled'),
      },
    });
  });

  done();
};
