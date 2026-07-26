// Analytics ingest (POST /a/*) and the admin dashboard reads (GET /admin/*). Mounted with no prefix so
// the ingest paths stay bland and so nothing collides with the unrelated POST /deposit/track.
// See bigdev/plans/cont/03-ADMIN-DASHBOARD.md §4.2 and §7.

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { adminMiddleware } from '../middlewares/adminMiddleware.ts';
import { getSetting } from '../config/admin-settings.ts';
import { RATE_LIMIT_WINDOW, SUI_NETWORK } from '../config/main-config.ts';
import { ERROR_STATUSES, buildBrief, getErrorDetail, listErrorGroups, setErrorStatus, type ErrorStatus } from '../services/insights.ts';
import { handleError, handleNotFoundError } from '../utils/errorHandler.ts';

const ok = <T>(reply: FastifyReply, data: T): FastifyReply => reply.status(200).send({ success: true, error: null, data });

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

  // Grouped errors. Default is open bugs newest-first, which is the triage order.
  app.get('/admin/errors', admin, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, string | undefined>;
    const groups = await listErrorGroups({
      status: q.status,
      level: q.level,
      kind: q.kind,
      network: q.network,
      release: q.release,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    return ok(reply, { groups });
  });

  app.get('/admin/errors/:fingerprint', admin, async (request: FastifyRequest, reply: FastifyReply) => {
    const { fingerprint } = request.params as { fingerprint: string };
    const detail = await getErrorDetail(fingerprint);
    if (!detail) return handleNotFoundError(reply, 'Error group');
    return ok(reply, detail);
  });

  // ack / resolve / ignore. `ignore` is what keeps an expected abort from ever paging us again.
  app.patch('/admin/errors/:fingerprint', admin, async (request: FastifyRequest, reply: FastifyReply) => {
    const { fingerprint } = request.params as { fingerprint: string };
    const body = (request.body ?? {}) as { status?: string; notes?: string | null };
    if (!body.status || !ERROR_STATUSES.includes(body.status as ErrorStatus)) {
      return handleError(reply, 400, `status must be one of ${ERROR_STATUSES.join(', ')}`, 'INVALID_STATUS');
    }
    const group = await setErrorStatus(fingerprint, body.status as ErrorStatus, body.notes);
    if (!group) return handleNotFoundError(reply, 'Error group');
    return ok(reply, { group });
  });

  // text/markdown, not JSON: the whole point is that it pastes straight into an AI.
  app.get('/admin/errors/:fingerprint/brief', admin, async (request: FastifyRequest, reply: FastifyReply) => {
    const { fingerprint } = request.params as { fingerprint: string };
    const brief = await buildBrief(fingerprint);
    if (!brief) return handleNotFoundError(reply, 'Error group');
    return reply.status(200).type('text/markdown; charset=utf-8').send(brief);
  });

  done();
};
