// Analytics ingest (POST /a/*) and the admin dashboard reads (GET /admin/*). Mounted with no prefix so
// the ingest paths stay bland and so nothing collides with the unrelated POST /deposit/track.
// See bigdev/plans/cont/03-ADMIN-DASHBOARD.md §4.2 and §7.

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { adminMiddleware } from '../middlewares/adminMiddleware.ts';
import { getSetting } from '../config/admin-settings.ts';
import { RATE_LIMIT_WINDOW, SUI_NETWORK } from '../config/main-config.ts';
import { MAX_EVENTS_PER_REQUEST, isEventName, isPreAuthEvent, platformFrom } from '../config/analytics-catalog.ts';
import { RELEASE } from '../config/release.ts';
import { ERROR_STATUSES, buildBrief, getErrorDetail, listErrorGroups, setErrorStatus, usageReport, type ErrorStatus } from '../services/insights.ts';
import { handleError, handleNotFoundError } from '../utils/errorHandler.ts';

import { ANALYTICS_OFF, BUDGET_SAMPLE_RATE, captureError, capMessage, capProps, errorBudgetExceeded, eventBudgetExceeded, redact } from '../lib/analytics.ts';
import { CLOCK_SKEW_MS, issueSession, open, unframe } from '../lib/envelope.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { userFromToken, userIdFromToken } from '../services/auth.ts';

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

// ---------------------------------------------------------------------------
// Event ingest (§4.2, §4.3, §4.4)
// ---------------------------------------------------------------------------

function bearer(request: FastifyRequest): string {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

// Verify-only, no DB: the key and the limit both have to be decided before the handler runs, and neither is
// worth a query. A signed token is a trustworthy userId either way.
function ingestUserId(request: FastifyRequest): string | null {
  const token = bearer(request);
  return token ? userIdFromToken(token) : null;
}

// Authenticated ingest is keyed by userId, not IP, so one user cannot amplify through many IPs. Anonymous
// falls back to the real client IP (trustProxy is on) at a much tighter cap.
function ingestRateKey(request: FastifyRequest): string {
  const userId = ingestUserId(request);
  return userId ? `u:${userId}` : `ip:${request.ip}`;
}

interface RawEvent {
  name?: unknown;
  props?: unknown;
  sessionId?: unknown;
  anonId?: unknown;
  ts?: unknown;
  /** The one thing the UA genuinely cannot tell us: iOS standalone PWA vs iOS Safari. */
  standalone?: unknown;
}

type Parsed = { ok: true; events: RawEvent[] } | { ok: false; status: number; code: string; message: string };

const bad = (status: number, code: string, message: string): Parsed => ({ ok: false, status, code, message });

// One record's plaintext is one event (sealed at queue time, §4.4 point 5), but a plain `{ events: [...] }`
// batch is accepted too, which is what the JSON fallback and any curl sends.
function eventsFrom(plaintext: string): RawEvent[] | null {
  try {
    const parsed = JSON.parse(plaintext) as unknown;
    if (Array.isArray(parsed)) return parsed as RawEvent[];
    if (parsed && typeof parsed === 'object') {
      const batch = (parsed as { events?: unknown }).events;
      if (Array.isArray(batch)) return batch as RawEvent[];
      return [parsed as RawEvent];
    }
    return null;
  } catch {
    return null;
  }
}

async function parseBody(request: FastifyRequest, now: number): Promise<Parsed> {
  const body = request.body;

  // JSON path: the plaintext fallback and anything hand-driven.
  if (body && !Buffer.isBuffer(body) && typeof body === 'object') {
    const events = eventsFrom(JSON.stringify(body));
    return events ? { ok: true, events } : bad(400, 'BAD_BODY', 'body is not a recognised event batch');
  }

  if (!Buffer.isBuffer(body) || !body.length) return bad(400, 'BAD_BODY', 'body is empty');

  const records = unframe(new Uint8Array(body), MAX_EVENTS_PER_REQUEST);
  if (!records) return bad(400, 'BAD_BODY', 'malformed envelope framing');
  if (records.length > MAX_EVENTS_PER_REQUEST) return bad(400, 'TOO_MANY_EVENTS', `at most ${MAX_EVENTS_PER_REQUEST} events per request`);

  const out: RawEvent[] = [];
  for (const record of records) {
    const opened = await open(record, now);
    if (!opened.ok) return bad(400, 'BAD_ENVELOPE', opened.reason);
    const events = eventsFrom(opened.plaintext);
    if (!events) return bad(400, 'BAD_BODY', 'envelope payload is not an event');
    out.push(...events);
  }
  return { ok: true, events: out };
}

interface IngestResult {
  status: number;
  code?: string;
  message?: string;
  accepted: number;
}

// Everything the client sends about identity, time, network, and release is discarded and restamped here
// (§13 rule 2). The client only ever supplies the event name, its props, and its own session/anon ids.
async function ingestEvents(request: FastifyRequest): Promise<IngestResult> {
  // A hard kill and a flipped setting both look like success to the client: ingest must never surface as a
  // failure, and a client that sees an error is a client that might retry.
  if (ANALYTICS_OFF) return { status: 202, accepted: 0 };
  if (!(await getSetting('analytics.enabled'))) return { status: 202, accepted: 0 };

  const now = Date.now();
  const parsed = await parseBody(request, now);
  if (!parsed.ok) return { status: parsed.status, code: parsed.code, message: parsed.message, accepted: 0 };
  if (parsed.events.length > MAX_EVENTS_PER_REQUEST) {
    return { status: 400, code: 'TOO_MANY_EVENTS', message: `at most ${MAX_EVENTS_PER_REQUEST} events per request`, accepted: 0 };
  }

  const userId = ingestUserId(request);
  const platform = platformFrom(request.headers['user-agent'], hasStandaloneHint(parsed.events));

  const rows: Array<Record<string, unknown>> = [];
  for (const raw of parsed.events) {
    const name = typeof raw.name === 'string' ? raw.name : '';
    // Allowlist or reject. Checked before the auth gate because bounded cardinality is the control that
    // protects every GROUP BY in the dashboard.
    if (!isEventName(name)) return { status: 400, code: 'UNKNOWN_EVENT', message: `unknown event name "${name.slice(0, 60)}"`, accepted: 0 };
    if (!userId && !isPreAuthEvent(name)) return { status: 401, code: 'AUTH_REQUIRED', message: `"${name}" requires a session`, accepted: 0 };

    // Replay window on the client clock. Stateless, and it caps replay of a captured request on data that
    // is already low value, which is why there is no seq store.
    if (typeof raw.ts === 'number' && Math.abs(now - raw.ts) > CLOCK_SKEW_MS) {
      return { status: 400, code: 'STALE_EVENT', message: 'event timestamp is outside the accepted window', accepted: 0 };
    }

    // Redact before capping, so a long secret is scrubbed rather than truncated into the row.
    const source = raw.props && typeof raw.props === 'object' && !Array.isArray(raw.props) ? redact(raw.props as Record<string, unknown>) : raw.props;
    const capped = capProps(source, { strict: true });
    if (!capped.ok) return { status: 400, code: 'BAD_PROPS', message: capped.reason, accepted: 0 };

    rows.push({
      name,
      userId,
      // Client-owned on purpose: the anonId is what stitches a pre-auth session to the user at query time.
      anonId: typeof raw.anonId === 'string' ? raw.anonId.slice(0, 64) : null,
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId.slice(0, 64) : 'unknown',
      props: Object.keys(capped.props).length ? capped.props : undefined,
      platform,
      source: 'web',
      release: RELEASE,
      network: SUI_NETWORK,
    });
  }

  // Past the daily budget we sample rather than go dark, so trends stay readable while the table cools.
  const sampled = (await eventBudgetExceeded()) ? rows.filter(() => Math.random() <= BUDGET_SAMPLE_RATE) : rows;

  // Fire-and-forget. `ts` is deliberately not passed: the column defaults to the server clock, so a client
  // cannot backdate a row. skipDuplicates would be a no-op here, there is no unique constraint to collide on.
  if (sampled.length) {
    void prismaQuery.event.createMany({ data: sampled as never }).catch(() => {});
  }
  return { status: 202, accepted: sampled.length };
}

// Metadata rather than a prop, so it survives sendBeacon (which cannot set a header) without eating a prop
// slot. A hint is not identity, so trusting it is fine.
function hasStandaloneHint(events: RawEvent[]): boolean {
  return events.some((e) => e.standalone === true);
}

export const analyticsRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // Sealed envelopes arrive as binary. Scoped to this plugin, so no other route's body parsing changes.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, cb) => {
    cb(null, body);
  });

  // Anonymous is capped hard and keyed by IP; authenticated is looser and keyed by userId.
  const ingest = {
    config: {
      rateLimit: {
        max: (request: FastifyRequest) => (ingestUserId(request) ? getSetting('rate.track_max') : getSetting('rate.track_anon_max')),
        timeWindow: RATE_LIMIT_WINDOW,
        keyGenerator: ingestRateKey,
      },
    },
  };

  // The handshake. The key is issued at runtime over TLS and never baked into the bundle, which is the
  // whole reason the envelope is worth anything (§4.4).
  app.post('/a/hello', ingest, async (_request: FastifyRequest, reply: FastifyReply) => {
    const session = issueSession();
    return reply.status(200).send({ success: true, error: null, data: session });
  });

  // Ingest. 202 for anything past the gates, and the client ignores the code either way.
  app.post('/a/e', ingest, async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await ingestEvents(request);
    if (result.status !== 202) return handleError(reply, result.status, result.message ?? 'Rejected', result.code ?? 'REJECTED');
    return reply.status(202).send({ success: true, error: null, data: { accepted: result.accepted } });
  });

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

  // Usage: the ascending event list, the funnel, per-game conversion, menu ranks, and D1/D7.
  app.get('/admin/usage', admin, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as { days?: string };
    const days = Math.min(90, Math.max(1, Number(q.days) || 30));
    return ok(reply, await usageReport(days));
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
