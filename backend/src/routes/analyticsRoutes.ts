// Analytics ingest (POST /a/*) and the admin dashboard reads (GET /admin/*). Mounted with no prefix so
// the ingest paths stay bland and so nothing collides with the unrelated POST /deposit/track.
// See bigdev/plans/cont/03-ADMIN-DASHBOARD.md §4.2 and §7.

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { adminMiddleware } from '../middlewares/adminMiddleware.ts';
import { getSetting } from '../config/admin-settings.ts';
import { RATE_LIMIT_WINDOW, SUI_NETWORK } from '../config/main-config.ts';
import { ERROR_STATUSES, buildBrief, getErrorDetail, listErrorGroups, setErrorStatus, type ErrorStatus } from '../services/insights.ts';
import { handleError, handleNotFoundError } from '../utils/errorHandler.ts';

import { captureError, capMessage, errorBudgetExceeded } from '../lib/analytics.ts';
import { userFromToken } from '../services/auth.ts';

const ok = <T>(reply: FastifyReply, data: T): FastifyReply => reply.status(200).send({ success: true, error: null, data });

// Server stamps identity, time, network, and release; the client's body only supplies the error itself.
// Returns whether the report was recorded, which is what the kill switch and the daily budget gate.
async function ingestClientError(request: FastifyRequest): Promise<boolean> {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return false;

  if (!(await getSetting('client_errors.enabled'))) return false;
  if (await errorBudgetExceeded()) return false;

  // Optional: an anonymous report is the whole point of this endpoint, so a missing or bad token is not
  // an error, it just means the row carries no userId.
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const user = token ? await userFromToken(token).catch(() => null) : null;

  captureError(new Error(capMessage(message)), {
    kind: 'client',
    stack: typeof body.stack === 'string' ? body.stack : null,
    userId: user?.id ?? null,
    sessionId: typeof body.sessionId === 'string' ? body.sessionId.slice(0, 64) : null,
    requestId: request.id,
    path: typeof body.url === 'string' ? body.url.slice(0, 200) : null,
    release: typeof body.release === 'string' ? body.release.slice(0, 40) : null,
    context: {
      platform: platformFrom(request.headers['user-agent'], body.standalone === true),
      source: typeof body.source === 'string' ? body.source.slice(0, 40) : 'unknown',
    },
  });

  return true;
}

// UA cannot tell an iOS standalone PWA from iOS Safari, so the client sends a boolean hint. A hint is not
// identity, so trusting it is fine; missing it just loses the PWA split.
function platformFrom(ua: string | undefined, standalone: boolean): string {
  const s = (ua ?? '').toLowerCase();
  if (/iphone|ipad|ipod/.test(s)) return standalone ? 'pwa' : 'ios';
  if (/android/.test(s)) return standalone ? 'pwa' : 'android';
  return standalone ? 'pwa' : 'desktop';
}

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

  // Client error reports. Anonymous is allowed on purpose: a white screen before sign-in is exactly the
  // failure we were blind to, and the client already dedupes to one report per fingerprint per session.
  // Always 202 past the rate limiter, so a broken client never sees an analytics failure.
  app.post(
    '/a/err',
    { config: { rateLimit: { max: () => getSetting('rate.track_anon_max'), timeWindow: RATE_LIMIT_WINDOW } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const accepted = await ingestClientError(request);
      return reply.status(202).send({ success: true, error: null, data: { accepted } });
    }
  );

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
