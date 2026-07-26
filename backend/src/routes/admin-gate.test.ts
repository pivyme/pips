// Access control (§7.5, Addendum A6 item 4). Walks the REGISTERED route list rather than a hardcoded
// list of paths, so an /admin/* route added later cannot silently skip the gate: it shows up here the
// moment it is registered, and it has to pass all three cases.
//
// 404, never 403, on every failure. A 403 confirms the surface exists, which is the thing the rule exists
// to prevent, so the test asserts the code and not merely "denied".

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import Fastify from 'fastify';

const ADMIN_TOKEN = 'token-admin';
const USER_TOKEN = 'token-user';

// Roles are read fresh per request through this, which is what makes a revoke take effect immediately.
let revoked = false;

mock.module('../services/auth.ts', () => ({
  userFromToken: async (token: string) => {
    if (token === ADMIN_TOKEN) return { id: 'u_admin', username: 'admin', specialRoles: revoked ? [] : ['ADMIN'] };
    if (token === USER_TOKEN) return { id: 'u_normal', username: 'normal', specialRoles: [] };
    return null;
  },
}));

const GROUP = {
  fingerprint: 'chain.backing_unfunded',
  title: 'Rolled market backing unfunded',
  culprit: 'src/services/plays.ts:235',
  kind: 'chain',
  level: 'error',
  count: 7,
  usersAffected: 2,
  firstSeen: new Date('2026-07-20T09:00:00Z'),
  lastSeen: new Date('2026-07-26T14:00:00Z'),
  status: 'open',
  resolvedAt: null,
  firstRelease: 'a3f91c2',
  lastRelease: '415b715',
  notes: null,
};

const SAMPLE = {
  id: 'ee_1',
  fingerprint: GROUP.fingerprint,
  message: 'MoveAbort ... assert_backing ... 0',
  stack: 'Error: boom\n    at commitPlay (/app/backend/src/services/plays.ts:235:11)',
  context: { playId: 'play_1', sponsor_sui: 0.84, sponsor_floor_sui: 0.5 },
  userId: 'u_normal',
  sessionId: 'sess_1',
  requestId: 'req_1',
  method: 'POST',
  path: '/games/lucky/play',
  playId: 'play_1',
  release: '415b715',
  network: 'testnet',
  createdAt: new Date('2026-07-26T14:00:00Z'),
};

mock.module('../lib/prisma.ts', () => ({
  prismaQuery: {
    errorGroup: {
      findMany: async () => [GROUP],
      findUnique: async () => GROUP,
      update: async () => GROUP,
    },
    errorEvent: {
      findMany: async () => [SAMPLE],
      groupBy: async () => [],
    },
    event: { findMany: async () => [] },
    user: { findMany: async () => [{ id: 'u_normal', username: 'normal' }] },
    play: { findMany: async () => [] },
    appConfig: { findUnique: async () => null },
    errorLog: { create: async () => ({}) },
  },
}));

const { analyticsRoutes } = await import('./analyticsRoutes.ts');

type Registered = { method: string; url: string };

// A real listening server on an ephemeral port rather than app.inject(): light-my-request emits a stray
// ERR_HTTP_HEADERS_SENT when a hook answers before the handler, which is exactly the path under test here,
// and a real fetch exercises the true request lifecycle anyway.
async function buildApp(): Promise<{ app: ReturnType<typeof Fastify>; routes: Registered[]; call: Call }> {
  const app = Fastify({ logger: false });
  const routes: Registered[] = [];
  app.addHook('onRoute', (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const m of methods) if (m !== 'HEAD' && r.url.startsWith('/admin')) routes.push({ method: m, url: r.url });
  });
  await app.register(analyticsRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as { port: number };

  const call: Call = async (method, url, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.rawAuth !== undefined ? { authorization: opts.rawAuth } : {}),
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, text, contentType: res.headers.get('content-type') ?? '', json: () => JSON.parse(text) as Record<string, unknown> };
  };

  return { app, routes, call };
}

type Call = (
  method: string,
  url: string,
  opts?: { token?: string; rawAuth?: string; body?: Record<string, unknown> }
) => Promise<{ status: number; text: string; contentType: string; json: () => Record<string, unknown> }>;

// Concrete params + a valid body per route, so an ADMIN really gets a 200 rather than a 404 for a missing
// resource, which would make the gate look like it passed when it never ran.
function concrete(url: string): string {
  return url.replace(':fingerprint', encodeURIComponent(GROUP.fingerprint));
}

function payload(method: string): Record<string, unknown> | undefined {
  return method === 'PATCH' ? { status: 'ack' } : undefined;
}

beforeEach(() => {
  revoked = false;
});

describe('/admin/* access control (§7.5)', () => {
  it('registers the admin routes it is supposed to', async () => {
    const { app, routes } = await buildApp();
    // A sanity floor: if the loops below ever ran over an empty list they would pass vacuously.
    expect(routes.length).toBeGreaterThanOrEqual(5);
    expect(routes.map((r) => `${r.method} ${r.url}`)).toContain('GET /admin/ping');
    await app.close();
  });

  it('answers 404 for an unauthenticated request on every registered admin route', async () => {
    const { app, routes, call } = await buildApp();
    for (const r of routes) {
      const res = await call(r.method, concrete(r.url), { body: payload(r.method) });
      expect(`${r.method} ${r.url} -> ${res.status}`).toBe(`${r.method} ${r.url} -> 404`);
    }
    await app.close();
  });

  it('answers 404 for a normal authenticated user on every registered admin route', async () => {
    const { app, routes, call } = await buildApp();
    for (const r of routes) {
      const res = await call(r.method, concrete(r.url), { token: USER_TOKEN, body: payload(r.method) });
      expect(`${r.method} ${r.url} -> ${res.status}`).toBe(`${r.method} ${r.url} -> 404`);
      // Never a 403: the response must not admit the route exists.
      expect(res.json()).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    }
    await app.close();
  });

  it('answers 404 for a malformed, unknown, or unprefixed token', async () => {
    const { app, call } = await buildApp();
    for (const rawAuth of ['Bearer ', 'Bearer nonsense', 'Basic abc', ADMIN_TOKEN]) {
      const res = await call('GET', '/admin/ping', { rawAuth });
      expect(`${rawAuth} -> ${res.status}`).toBe(`${rawAuth} -> 404`);
    }
    await app.close();
  });

  it('answers 200 for an ADMIN on every registered admin route', async () => {
    const { app, routes, call } = await buildApp();
    for (const r of routes) {
      const res = await call(r.method, concrete(r.url), { token: ADMIN_TOKEN, body: payload(r.method) });
      expect(`${r.method} ${r.url} -> ${res.status}`).toBe(`${r.method} ${r.url} -> 200`);
    }
    await app.close();
  });

  it('rejects an unknown status on the PATCH rather than storing it', async () => {
    const { app, call } = await buildApp();
    const res = await call('PATCH', concrete('/admin/errors/:fingerprint'), { token: ADMIN_TOKEN, body: { status: 'wontfix' } });
    expect(res.status).toBe(400);
    await app.close();
  });

  it('locks a revoked ADMIN out on the very next request, with no token change', async () => {
    const { app, call } = await buildApp();

    expect((await call('GET', '/admin/ping', { token: ADMIN_TOKEN })).status).toBe(200);
    revoked = true;
    expect((await call('GET', '/admin/ping', { token: ADMIN_TOKEN })).status).toBe(404);

    await app.close();
  });
});

describe('the brief (§5)', () => {
  it('serves markdown, under 8KB, with the sections the template promises', async () => {
    const { app, call } = await buildApp();
    const res = await call('GET', `/admin/errors/${encodeURIComponent(GROUP.fingerprint)}/brief`, { token: ADMIN_TOKEN });

    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/markdown');
    expect(Buffer.byteLength(res.text, 'utf8')).toBeLessThanOrEqual(8192);

    for (const section of ['# PIPS error:', '## Summary', '## Where', '## Message', '## What the user was doing', '## System state at the time', '## Where to look']) {
      expect(res.text).toContain(section);
    }
    // The system state comes from what captureError folded into context at error time.
    expect(res.text).toContain('Sponsor SUI: 0.84');
    // Own-code frames are marked so the reader (and the AI) knows which frames are ours.
    expect(res.text).toContain('> at commitPlay');

    await app.close();
  });
});
