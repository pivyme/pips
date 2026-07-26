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
  // The ingest path's verify-only resolve: a userId with no DB round trip.
  userIdFromToken: (token: string) => {
    if (token === ADMIN_TOKEN) return 'u_admin';
    if (token === USER_TOKEN) return 'u_normal';
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

// Writes the client-ingest test inspects. Reads stay static: those tests are about the gate, not the data.
export const written = {
  groups: new Map<string, { count: number; kind: string; level: string }>(),
  samples: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
};

// Stored setting overrides, so the kill-switch test can flip `client_errors.enabled` off for real.
const settingRows = new Map<string, string>();

// The role the API is allowed to move, so the revoke rules can be watched to hold.
let roleState: string[] = [];

mock.module('../lib/prisma.ts', () => ({
  prismaQuery: {
    errorGroup: {
      findMany: async () => [GROUP],
      // Feeds the "N resolved this week" line the empty Errors list shows instead of reporting an absence.
      count: async () => 3,
      findUnique: async ({ where }: { where: { fingerprint: string } }) =>
        written.groups.has(where.fingerprint) ? { ...GROUP, fingerprint: where.fingerprint, status: 'open' } : GROUP,
      update: async () => GROUP,
      upsert: async ({ where, create }: { where: { fingerprint: string }; create: { kind: string; level: string } }) => {
        const g = written.groups.get(where.fingerprint);
        if (g) g.count += 1;
        else written.groups.set(where.fingerprint, { count: 1, kind: create.kind, level: create.level });
        return {};
      },
    },
    errorEvent: {
      findMany: async ({ skip }: { skip?: number }) => (skip === undefined ? [SAMPLE] : []),
      findFirst: async () => null,
      groupBy: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        written.samples.push(data);
        return data;
      },
      deleteMany: async () => ({ count: 1 }),
      // Discriminated: a per-group count feeds the sample purge, an age-window count feeds the daily
      // error budget, and they must not answer for each other.
      count: async ({ where }: { where?: { fingerprint?: string } } = {}) => (where?.fingerprint ? 1 : 0),
    },
    event: {
      findMany: async () => [],
      findFirst: async () => null,
      groupBy: async () => [],
      count: async () => 0,
      // The push runs synchronously at call time (an async body runs to its first await), so the row is
      // observable by the time the fire-and-forget handler has replied.
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        written.events.push(...data);
        return { count: data.length };
      },
    },
    user: {
      findMany: async () => [{ id: 'u_normal', username: 'normal', createdAt: new Date('2026-07-20T00:00:00Z') }],
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === 'u_normal' ? { id: 'u_normal', username: 'normal', specialRoles: roleState.slice() } : null),
      update: async ({ data }: { data: { specialRoles: string[] } }) => {
        roleState = data.specialRoles;
        return { id: 'u_normal', specialRoles: roleState };
      },
      count: async () => 1,
    },
    play: { findMany: async () => [], count: async () => 0 },
    deposit: { findMany: async () => [] },
    walletTx: { findMany: async () => [] },
    appConfig: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        const value = settingRows.get(where.key);
        return value === undefined ? null : { key: where.key, value };
      },
      upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
        settingRows.set(where.key, create.value);
        return { key: where.key, value: create.value };
      },
    },
    errorLog: { create: async () => ({}) },
    // The newest-N-per-fingerprint window function. No overflow in this fixture: these tests are about
    // the gate's status codes, not the arithmetic, which retention.test.ts pins.
    $queryRaw: async (strings: TemplateStringsArray) =>
      strings.join(' ').includes('count(*)') ? [{ n: 0n, oldest: null, newest: null }] : [],
  },
}));

const { analyticsRoutes } = await import('./analyticsRoutes.ts');
const { flushCaptures } = await import('../lib/analytics.ts');
const { clearSettingsCache } = await import('../config/admin-settings.ts');
const { frame, fromB64url, issueSession, seal } = await import('../lib/envelope.ts');
const { RELEASE } = await import('../config/release.ts');
const { SUI_NETWORK } = await import('../config/main-config.ts');

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
        ...(opts.raw ? { 'content-type': 'application/octet-stream' } : {}),
        ...(opts.ua ? { 'user-agent': opts.ua } : {}),
      },
      body: opts.raw ?? (opts.body ? JSON.stringify(opts.body) : undefined),
    });
    const text = await res.text();
    return { status: res.status, text, contentType: res.headers.get('content-type') ?? '', json: () => JSON.parse(text) as Record<string, unknown> };
  };

  return { app, routes, call };
}

type Call = (
  method: string,
  url: string,
  opts?: { token?: string; rawAuth?: string; body?: Record<string, unknown>; raw?: Uint8Array; ua?: string }
) => Promise<{ status: number; text: string; contentType: string; json: () => Record<string, unknown> }>;

// Concrete params + a valid body per route, so an ADMIN really gets a 200 rather than a 404 for a missing
// resource, which would make the gate look like it passed when it never ran.
function concrete(url: string): string {
  const path = url.replace(':fingerprint', encodeURIComponent(GROUP.fingerprint)).replace(':id', 'u_normal');
  // Two routes need a query to do anything at all, and a walk that got a 400 here would be asserting the
  // argument check rather than the gate.
  if (url.endsWith('/settings/preview')) return `${path}?key=retention.event_days&value=90`;
  if (url.endsWith('/samples')) return `${path}?confirm=${encodeURIComponent('delete 1 samples')}`;
  return path;
}

function payload(method: string, url: string): Record<string, unknown> | undefined {
  if (method !== 'PATCH') return undefined;
  // A non-destructive key at its default: enough to prove the gate, and it changes nothing.
  if (url === '/admin/settings') return { key: 'rate.admin_max', value: 60 };
  if (url.endsWith('/roles')) return { role: 'KOL', grant: true };
  return { status: 'ack' };
}

beforeEach(() => {
  revoked = false;
  written.groups.clear();
  written.samples = [];
  written.events = [];
  settingRows.clear();
  roleState = [];
  clearSettingsCache();
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
      const res = await call(r.method, concrete(r.url), { body: payload(r.method, r.url) });
      expect(`${r.method} ${r.url} -> ${res.status}`).toBe(`${r.method} ${r.url} -> 404`);
    }
    await app.close();
  });

  it('answers 404 for a normal authenticated user on every registered admin route', async () => {
    const { app, routes, call } = await buildApp();
    for (const r of routes) {
      const res = await call(r.method, concrete(r.url), { token: USER_TOKEN, body: payload(r.method, r.url) });
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
      const res = await call(r.method, concrete(r.url), { token: ADMIN_TOKEN, body: payload(r.method, r.url) });
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

describe('client error ingest (§3.2 surface 5)', () => {
  it('records an anonymous report as exactly one group with a usable stack', async () => {
    const { app, call } = await buildApp();
    const stack = 'TypeError: undefined is not an object\n    at LuckyScreen (https://playpips.fun/assets/lucky-abc.js:12:44)';

    const res = await call('POST', '/a/err', {
      body: { message: 'undefined is not an object (evaluating reel.length)', stack, sessionId: 's_1', release: 'a3f91c2', url: '/games/lucky', standalone: true },
    });

    expect(res.status).toBe(202);
    await flushCaptures();

    expect(written.groups.size).toBe(1);
    const [group] = [...written.groups.values()];
    expect(group.kind).toBe('client');
    expect(written.samples).toHaveLength(1);
    expect(String(written.samples[0].stack)).toContain('LuckyScreen');
    // Anonymous is allowed here on purpose: a white screen before sign-in is what we were blind to.
    expect(written.samples[0].userId).toBeNull();
    expect(written.samples[0].release).toBe('a3f91c2');

    await app.close();
  });

  it('attributes an authenticated report to the user from the token, not the body', async () => {
    const { app, call } = await buildApp();
    const res = await call('POST', '/a/err', {
      token: USER_TOKEN,
      body: { message: 'boom', sessionId: 's_2', userId: 'u_someone_else' },
    });

    expect(res.status).toBe(202);
    await flushCaptures();
    expect(written.samples[0].userId).toBe('u_normal');

    await app.close();
  });

  // The kill switch exists because a client render loop is the top flood vector. It has to silence the
  // write while still answering 202, or a flooding client starts retrying instead.
  it('records nothing once client_errors.enabled is off, and still answers 202', async () => {
    settingRows.set('setting:client_errors.enabled', 'false');
    clearSettingsCache();

    const { app, call } = await buildApp();
    const res = await call('POST', '/a/err', { body: { message: 'boom while the switch is off', sessionId: 's_off' } });

    expect(res.status).toBe(202);
    expect(res.json()).toMatchObject({ data: { accepted: false } });
    await flushCaptures();
    expect(written.groups.size).toBe(0);
    expect(written.samples).toHaveLength(0);

    await app.close();
  });

  it('accepts and ignores a report with no message rather than erroring', async () => {
    const { app, call } = await buildApp();
    const res = await call('POST', '/a/err', { body: { sessionId: 's_3' } });

    expect(res.status).toBe(202);
    expect(res.json()).toMatchObject({ data: { accepted: false } });
    await flushCaptures();
    expect(written.groups.size).toBe(0);

    await app.close();
  });
});

// Addendum A6 item 8. The rule these pin: the server stamps identity, time, network, and release, and the
// allowlist bounds cardinality. Both are the kind of thing that looks fine until the day it is not, so the
// assertions read the STORED row rather than the response.
describe('event ingest (§4.2, §4.3)', () => {
  const one = (over: Record<string, unknown> = {}) => ({ events: [{ name: 'game.play_tap', sessionId: 's_1', anonId: 'a_1', ...over }] });

  it('accepts an authenticated batch and stamps every server-owned field', async () => {
    const { app, call } = await buildApp();
    const res = await call('POST', '/a/e', { token: USER_TOKEN, body: one({ props: { game: 'lucky', stake: 2 } }) });

    expect(res.status).toBe(202);
    expect(res.json()).toMatchObject({ data: { accepted: 1 } });
    expect(written.events).toHaveLength(1);
    expect(written.events[0]).toMatchObject({
      name: 'game.play_tap',
      userId: 'u_normal',
      anonId: 'a_1',
      sessionId: 's_1',
      source: 'web',
      network: SUI_NETWORK,
      release: RELEASE,
      props: { game: 'lucky', stake: 2 },
    });
    // ts is never passed: the column defaults to the server clock, so a client cannot backdate a row.
    expect(written.events[0]).not.toHaveProperty('ts');

    await app.close();
  });

  it('overwrites userId, ts, network, and release when the body supplies its own', async () => {
    const { app, call } = await buildApp();
    const res = await call('POST', '/a/e', {
      token: USER_TOKEN,
      body: {
        events: [
          {
            name: 'game.play_tap',
            sessionId: 's_1',
            userId: 'u_admin',
            network: 'mainnet',
            release: 'deadbeef',
            source: 'backend',
            platform: 'pwa',
            ts: Date.now(),
          },
        ],
      },
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    });

    expect(res.status).toBe(202);
    const row = written.events[0]!;
    expect(row.userId).toBe('u_normal');       // from the JWT, not the body
    expect(row.network).toBe(SUI_NETWORK);     // from config
    expect(row.release).toBe(RELEASE);         // from config
    expect(row.source).toBe('web');            // fixed for this endpoint
    expect(row.platform).toBe('desktop');      // derived from the UA, not the body's 'pwa'
    expect(row).not.toHaveProperty('ts');

    await app.close();
  });

  it('maps the ios + standalone hint to pwa, since the UA cannot tell them apart', async () => {
    const { app, call } = await buildApp();
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';

    await call('POST', '/a/e', { token: USER_TOKEN, body: one(), ua: iphone });
    expect(written.events[0]!.platform).toBe('ios');

    await call('POST', '/a/e', { token: USER_TOKEN, body: one({ standalone: true }), ua: iphone });
    expect(written.events[1]!.platform).toBe('pwa');

    await app.close();
  });

  it('rejects an unknown event name with 400 and writes nothing', async () => {
    const { app, call } = await buildApp();
    const res = await call('POST', '/a/e', { token: USER_TOKEN, body: one({ name: 'game.totally_made_up' }) });

    expect(res.status).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'UNKNOWN_EVENT' } });
    expect(written.events).toHaveLength(0);

    await app.close();
  });

  it('rejects the whole batch when any one name is unknown, so cardinality cannot leak through a batch', async () => {
    const { app, call } = await buildApp();
    const res = await call('POST', '/a/e', {
      token: USER_TOKEN,
      body: { events: [{ name: 'hub.view', sessionId: 's_1' }, { name: 'attacker.' + 'x'.repeat(30), sessionId: 's_1' }] },
    });

    expect(res.status).toBe(400);
    expect(written.events).toHaveLength(0);

    await app.close();
  });

  it('allows the 7 pre-auth names anonymously, with no userId ever written', async () => {
    const { app, call } = await buildApp();
    for (const name of ['app.open', 'door.landing_view', 'door.gate_pass', 'door.gate_fail', 'door.start_tap', 'door.auth_start', 'door.auth_fail']) {
      const res = await call('POST', '/a/e', { body: { events: [{ name, sessionId: 's_pre', anonId: 'a_pre' }] } });
      expect(`${name} -> ${res.status}`).toBe(`${name} -> 202`);
    }

    expect(written.events).toHaveLength(7);
    for (const row of written.events) {
      expect(row.userId).toBeNull();
      expect(row.anonId).toBe('a_pre');
    }

    await app.close();
  });

  it('rejects an anonymous non-allowlisted name with 401', async () => {
    const { app, call } = await buildApp();
    // door.auth_ok is deliberately NOT pre-auth: it is the post-login event that carries the anonId.
    for (const name of ['game.play_tap', 'door.auth_ok', 'money.withdraw_done', 'admin.role_change']) {
      const res = await call('POST', '/a/e', { body: { events: [{ name, sessionId: 's_pre' }] } });
      expect(`${name} -> ${res.status}`).toBe(`${name} -> 401`);
    }
    expect(written.events).toHaveLength(0);

    await app.close();
  });

  it('rejects more than 20 events in one request', async () => {
    const { app, call } = await buildApp();
    const events = Array.from({ length: 21 }, () => ({ name: 'hub.view', sessionId: 's_1' }));
    const res = await call('POST', '/a/e', { token: USER_TOKEN, body: { events } });

    expect(res.status).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'TOO_MANY_EVENTS' } });
    expect(written.events).toHaveLength(0);

    // Exactly 20 is fine, so the boundary is where it says it is.
    const okRes = await call('POST', '/a/e', { token: USER_TOKEN, body: { events: events.slice(0, 20) } });
    expect(okRes.status).toBe(202);
    expect(written.events).toHaveLength(20);

    await app.close();
  });

  it('rejects depth-2 props rather than flattening them', async () => {
    const { app, call } = await buildApp();
    const res = await call('POST', '/a/e', { token: USER_TOKEN, body: one({ props: { game: 'lucky', nested: { deep: 1 } } }) });

    expect(res.status).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'BAD_PROPS' } });
    expect(written.events).toHaveLength(0);

    await app.close();
  });

  it('redacts a secret-shaped prop before it ever reaches a row', async () => {
    const { app, call } = await buildApp();
    await call('POST', '/a/e', { token: USER_TOKEN, body: one({ props: { access_token: 'super-secret-value', game: 'lucky' } }) });

    expect(written.events[0]!.props).toMatchObject({ access_token: '[redacted]', game: 'lucky' });

    await app.close();
  });

  it('rejects an event whose client clock is outside the 5-minute replay window', async () => {
    const { app, call } = await buildApp();
    const res = await call('POST', '/a/e', { token: USER_TOKEN, body: one({ ts: Date.now() - 6 * 60 * 1000 }) });

    expect(res.status).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'STALE_EVENT' } });

    await app.close();
  });

  it('records nothing once analytics.enabled is off, and still answers 202', async () => {
    settingRows.set('setting:analytics.enabled', 'false');
    clearSettingsCache();

    const { app, call } = await buildApp();
    const res = await call('POST', '/a/e', { token: USER_TOKEN, body: one() });

    expect(res.status).toBe(202);
    expect(written.events).toHaveLength(0);

    await app.close();
  });
});

describe('sealed ingest end to end (§4.4)', () => {
  it('hands out a session and ingests the envelopes sealed with it', async () => {
    const { app, call } = await buildApp();

    const hello = await call('POST', '/a/hello', {});
    expect(hello.status).toBe(200);
    const { sid } = (hello.json() as { data: { sid: string; key: string } }).data;
    expect(typeof sid).toBe('string');

    const sidBytes = fromB64url(sid);
    const records = await Promise.all([
      seal(sidBytes, JSON.stringify({ name: 'hub.view', sessionId: 's_1', anonId: 'a_1' })),
      seal(sidBytes, JSON.stringify({ name: 'game.play_tap', sessionId: 's_1', anonId: 'a_1', props: { game: 'lucky' } })),
    ]);

    const res = await call('POST', '/a/e', { token: USER_TOKEN, raw: frame(records) });
    expect(res.status).toBe(202);
    expect(written.events.map((e) => e.name)).toEqual(['hub.view', 'game.play_tap']);

    await app.close();
  });

  it('accepts the version-byte 0 plaintext fallback on the same endpoint', async () => {
    const { app, call } = await buildApp();
    const json = new TextEncoder().encode(JSON.stringify({ name: 'app.open', sessionId: 's_1', anonId: 'a_1' }));
    const record = new Uint8Array(1 + json.length);
    record[0] = 0;
    record.set(json, 1);

    const res = await call('POST', '/a/e', { raw: frame([record]) });
    expect(res.status).toBe(202);
    expect(written.events).toHaveLength(1);
    expect(written.events[0]!.name).toBe('app.open');

    await app.close();
  });

  it('refuses an envelope sealed for a different session', async () => {
    const { app, call } = await buildApp();
    const mine = fromB64url(issueSession().sid);
    const theirs = fromB64url(issueSession().sid);
    const record = await seal(mine, JSON.stringify({ name: 'hub.view', sessionId: 's_1' }));
    record.set(theirs, 1);

    const res = await call('POST', '/a/e', { token: USER_TOKEN, raw: frame([record]) });
    expect(res.status).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'BAD_ENVELOPE' } });
    expect(written.events).toHaveLength(0);

    await app.close();
  });
});

describe('destructive guardrails (§9.1)', () => {
  const patch = async (call: Call, body: Record<string, unknown>) => call('PATCH', '/admin/settings', { token: ADMIN_TOKEN, body });

  it('rejects a below-floor retention outright, with no confirmation offered', async () => {
    const { app, call } = await buildApp();
    const res = await patch(call, { key: 'retention.event_days', value: 1, confirm: 'delete 0 events' });
    expect(res.status).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_VALUE' } });
    await app.close();
  });

  it('rejects a narrowing change with no confirm at all', async () => {
    const { app, call } = await buildApp();
    const res = await patch(call, { key: 'retention.event_days', value: 90 });
    expect(res.status).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'CONFIRM_REQUIRED' } });
    await app.close();
  });

  it('rejects a mismatched confirmation, and there is no force flag to route around it', async () => {
    const { app, call } = await buildApp();
    for (const confirm of ['yes', 'delete everything', 'delete 0 plays']) {
      const res = await patch(call, { key: 'retention.event_days', value: 90, confirm });
      expect(`${confirm} -> ${res.status}`).toBe(`${confirm} -> 400`);
    }
    // And a force flag is simply not a thing the handler reads.
    const forced = await patch(call, { key: 'retention.event_days', value: 90, force: true });
    expect(forced.status).toBe(400);
    await app.close();
  });

  it('answers 409 "preview again" when the confirmed count has drifted over 10%', async () => {
    const { app, call } = await buildApp();
    // The fixture has zero prunable events, so any non-trivial confirmed count is stale by definition.
    const res = await patch(call, { key: 'retention.event_days', value: 90, confirm: 'delete 4200 events' });
    expect(res.status).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'PREVIEW_AGAIN' } });
    await app.close();
  });

  it('lets a widening change through with no confirmation, because it deletes nothing', async () => {
    const { app, call } = await buildApp();
    const res = await patch(call, { key: 'retention.event_days', value: 500 });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ data: { key: 'retention.event_days', value: 500 } });
    await app.close();
  });

  it('applies a narrowing change once the confirmation matches the recomputed count', async () => {
    const { app, call } = await buildApp();
    const preview = await call('GET', '/admin/settings/preview?key=retention.event_days&value=90', { token: ADMIN_TOKEN });
    const { confirm, widening } = (preview.json() as { data: { confirm: string; widening: boolean } }).data;
    expect(widening).toBe(false);

    const res = await patch(call, { key: 'retention.event_days', value: 90, confirm });
    expect(res.status).toBe(200);
    await app.close();
  });

  it('has no preview for a setting that deletes nothing', async () => {
    const { app, call } = await buildApp();
    const res = await call('GET', '/admin/settings/preview?key=rate.admin_max&value=30', { token: ADMIN_TOKEN });
    expect(res.status).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_DESTRUCTIVE' } });
    await app.close();
  });

  it('needs the typed confirm to purge one group\'s samples too', async () => {
    const { app, call } = await buildApp();
    const bare = await call('DELETE', `/admin/errors/${encodeURIComponent(GROUP.fingerprint)}/samples`, { token: ADMIN_TOKEN });
    expect(bare.status).toBe(400);

    const confirmed = await call('DELETE', `/admin/errors/${encodeURIComponent(GROUP.fingerprint)}/samples?confirm=${encodeURIComponent('delete 1 samples')}`, {
      token: ADMIN_TOKEN,
    });
    expect(confirmed.status).toBe(200);
    await app.close();
  });
});

describe('role changes (§9.1)', () => {
  it('refuses to move ADMIN through the API, in either direction', async () => {
    const { app, call } = await buildApp();
    for (const grant of [true, false]) {
      const res = await call('PATCH', '/admin/users/u_normal/roles', { token: ADMIN_TOKEN, body: { role: 'ADMIN', grant } });
      expect(`grant=${grant} -> ${res.status}`).toBe(`grant=${grant} -> 400`);
      expect(res.json()).toMatchObject({ error: { code: 'ADMIN_IS_SCRIPT_ONLY' } });
    }
    await app.close();
  });

  it('grants and revokes a non-ADMIN role', async () => {
    const { app, call } = await buildApp();
    const granted = await call('PATCH', '/admin/users/u_normal/roles', { token: ADMIN_TOKEN, body: { role: 'KOL', grant: true } });
    expect(granted.json()).toMatchObject({ data: { specialRoles: ['KOL'] } });

    const revoked = await call('PATCH', '/admin/users/u_normal/roles', { token: ADMIN_TOKEN, body: { role: 'KOL', grant: false } });
    expect(revoked.json()).toMatchObject({ data: { specialRoles: [] } });
    await app.close();
  });

  it('rejects a role that is not in SPECIAL_ROLES', async () => {
    const { app, call } = await buildApp();
    const res = await call('PATCH', '/admin/users/u_normal/roles', { token: ADMIN_TOKEN, body: { role: 'SUPERUSER', grant: true } });
    expect(res.status).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_ROLE' } });
    await app.close();
  });
});
