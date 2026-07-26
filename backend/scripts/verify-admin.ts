// Live proof of the /admin gate, against the RUNNING backend and the REAL database. The unit test
// (routes/analyticsRoutes.test.ts) pins the same rule against a mocked prisma; this one proves it where it
// actually matters: a real JWT, a real role row, a real request, and a role change taking effect on the very
// next request rather than at the next login.
//
//   cd backend && bun scripts/verify-admin.ts [baseUrl]        # default http://localhost:3780
//
// What it asserts, throwing on the first mismatch:
//   1. Every registered /admin/* route answers 404 to an unauthenticated request.
//   2. Every one of them answers 404 to a real, signed-in, non-ADMIN user. Never 403: the response must not
//      admit the route exists.
//   3. Every one of them lets an ADMIN through (reads must be 200; the mutating ones are driven with a
//      deliberately unsatisfiable confirm, so passing the gate is proven without changing a row).
//   4. A brief is under 8KB and carries its required sections.
//   5. Revoking ADMIN locks the account out on the NEXT request, because roles are read per request and
//      never baked into the JWT.
//
// It creates one throwaway user, grants and revokes on that user only, and deletes it at the end, so the
// database is left exactly as it was found.

import '../dotenv.ts';

import Fastify from 'fastify';
import jwt from 'jsonwebtoken';

import { JWT_SECRET } from '../src/config/main-config.ts';
import { prismaQuery } from '../src/lib/prisma.ts';
import { analyticsRoutes } from '../src/routes/analyticsRoutes.ts';

const BASE = process.argv[2] ?? 'http://localhost:3780';
const MAX_BRIEF_BYTES = 8 * 1024;
// The sections that are unconditional in buildBrief(). Stack, context, and correlated are omitted when the
// group has none, so requiring them would make the check depend on which bug happened to be newest.
const BRIEF_SECTIONS = ['## Summary', '## Where', '## Message', '## What the user was doing', '## System state at the time', '## Where to look'];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// The route list comes from the plugin itself, never a hand-kept copy here: a route added later must not be
// able to skip this walk by being forgotten.
async function registeredAdminRoutes(): Promise<Array<{ method: string; url: string }>> {
  const app = Fastify({ logger: false });
  const out: Array<{ method: string; url: string }> = [];
  app.addHook('onRoute', (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const m of methods) if (m !== 'HEAD' && r.url.startsWith('/admin')) out.push({ method: m, url: r.url });
  });
  await app.register(analyticsRoutes);
  await app.ready();
  await app.close();
  return out;
}

interface Call {
  method: string;
  url: string;
  token?: string;
  body?: Record<string, unknown>;
}

async function call({ method, url, token, body }: Call): Promise<{ status: number; text: string }> {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}

// Concrete params per route. A walk that 404s because the fingerprint does not exist would look like the
// gate passing when it never ran, so the ids are real rows read out of the database.
function concrete(url: string, fingerprint: string, userId: string): string {
  const path = url.replace(':fingerprint', encodeURIComponent(fingerprint)).replace(':id', userId);
  if (url.endsWith('/settings/preview')) return `${path}?key=retention.event_days&value=400`;
  // A confirm string that can never match, so DELETE proves the gate and deletes nothing.
  if (url.endsWith('/samples')) return `${path}?confirm=${encodeURIComponent('delete nothing at all')}`;
  return path;
}

function payload(method: string, url: string): Record<string, unknown> | undefined {
  if (method !== 'PATCH') return undefined;
  // Narrowing retention with no confirm: refused by the §9.1 gate, which is the point. It reaches the
  // handler (so the admin gate passed) and changes nothing.
  if (url === '/admin/settings') return { key: 'retention.event_days', value: 60 };
  if (url.endsWith('/roles')) return { role: 'KOL', grant: true };
  return { status: 'ack' };
}

// Reads are a flat 200. The mutating routes are deliberately driven into their own 400, which still proves
// the only thing this script is about: the request got past adminMiddleware instead of being 404'd.
function adminExpectation(method: string, url: string): { codes: number[]; why: string } {
  if (method === 'GET') return { codes: [200], why: 'read' };
  if (url.endsWith('/samples')) return { codes: [400], why: 'confirm mismatch, nothing deleted' };
  if (url === '/admin/settings') return { codes: [400], why: 'confirm required, nothing written' };
  return { codes: [200], why: 'mutating, applied to the throwaway user only' };
}

// The real grant-role.ts, in its own process, exactly as a human would run it.
async function runScript(args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', new URL('grant-role.ts', import.meta.url).pathname, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: `${stdout}${stderr}`.trim() };
}

const stamp = Date.now();
const throwaway = await prismaQuery.user.create({
  data: {
    address: `0xverify_admin_${stamp}`,
    provider: 'dev',
    displayName: 'Verify Admin Probe',
  },
  select: { id: true },
});

let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  await prismaQuery.event.deleteMany({ where: { userId: throwaway.id } }).catch(() => {});
  await prismaQuery.user.delete({ where: { id: throwaway.id } }).catch(() => {});
}

try {
  const token = jwt.sign({ userId: throwaway.id }, JWT_SECRET, { expiresIn: '10m' });
  const routes = await registeredAdminRoutes();
  assert(routes.length >= 5, `expected the admin plugin to register routes, found ${routes.length}`);
  assert(routes.some((r) => r.url === '/admin/ping'), 'GET /admin/ping is missing from the registered routes');

  const group = await prismaQuery.errorGroup.findFirst({ orderBy: { lastSeen: 'desc' }, select: { fingerprint: true } });
  assert(group, 'no ErrorGroup rows to brief. Run the app until one error is captured, then re-run this script');
  const fingerprint = group.fingerprint;

  const ping = await call({ method: 'GET', url: '/admin/ping' });
  assert(ping.status === 404, `the server at ${BASE} is not reachable or not gating: GET /admin/ping returned ${ping.status}`);

  // 1 + 2: locked out, and never with a 403.
  for (const actor of ['anonymous', 'signed-in non-admin'] as const) {
    for (const r of routes) {
      const res = await call({
        method: r.method,
        url: concrete(r.url, fingerprint, throwaway.id),
        token: actor === 'anonymous' ? undefined : token,
        body: payload(r.method, r.url),
      });
      assert(res.status === 404, `${actor}: ${r.method} ${r.url} returned ${res.status}, expected 404`);
      assert(!res.text.includes('FORBIDDEN'), `${actor}: ${r.method} ${r.url} admitted the route exists`);
    }
  }
  console.log(`locked out: ${routes.length} routes x 2 actors, all 404`);

  // 3: the same account, same token, one role row later.
  await prismaQuery.user.update({ where: { id: throwaway.id }, data: { specialRoles: ['ADMIN'] } });
  for (const r of routes) {
    const expect = adminExpectation(r.method, r.url);
    const res = await call({
      method: r.method,
      url: concrete(r.url, fingerprint, throwaway.id),
      token,
      body: payload(r.method, r.url),
    });
    assert(
      expect.codes.includes(res.status),
      `admin: ${r.method} ${r.url} returned ${res.status}, expected ${expect.codes.join('/')} (${expect.why}): ${res.text.slice(0, 200)}`
    );
  }
  console.log(`admitted: ${routes.length} routes, every one past the gate on the same token`);

  // 4: the brief, which is the one artifact a human copies into a chat window.
  const brief = await call({ method: 'GET', url: `/admin/errors/${encodeURIComponent(fingerprint)}/brief`, token });
  assert(brief.status === 200, `brief returned ${brief.status}`);
  const bytes = new TextEncoder().encode(brief.text).length;
  assert(bytes <= MAX_BRIEF_BYTES, `brief is ${bytes} bytes, over the ${MAX_BRIEF_BYTES} cap`);
  for (const section of BRIEF_SECTIONS) assert(brief.text.includes(section), `brief is missing the "${section}" section`);
  console.log(`brief: ${bytes} bytes, all ${BRIEF_SECTIONS.length} sections present`);

  // 5: a revoke has to bite on the next request, not the next login.
  await prismaQuery.user.update({ where: { id: throwaway.id }, data: { specialRoles: [] } });
  const after = await call({ method: 'GET', url: '/admin/ping', token });
  assert(after.status === 404, `after revoke: GET /admin/ping returned ${after.status}, expected 404`);
  console.log('revoked: the very next request on the same token is already 404');

  // 6: grant-role.ts is the ONLY thing that can move ADMIN, so run the real script rather than trusting it.
  // Which branch of its last-ADMIN floor we get to see depends on how many admins the database already has.
  const others = await prismaQuery.user.count({ where: { specialRoles: { has: 'ADMIN' }, id: { not: throwaway.id } } });
  const granted = await runScript([throwaway.id, 'ADMIN']);
  assert(granted.code === 0, `grant-role.ts grant exited ${granted.code}: ${granted.out}`);
  const opened = await call({ method: 'GET', url: '/admin/ping', token });
  assert(opened.status === 200, `after the script grant: GET /admin/ping returned ${opened.status}, expected 200`);

  const revoked = await runScript([throwaway.id, 'ADMIN', '--revoke']);
  if (others === 0) {
    // The throwaway is the only admin alive, so the floor must hold: refusing is the whole point.
    assert(revoked.code === 1, `grant-role.ts revoked the LAST admin (exit ${revoked.code}): ${revoked.out}`);
    assert(revoked.out.includes('last ADMIN'), `the refusal did not name the reason: ${revoked.out}`);
    console.log('grant-role: granted, then REFUSED to revoke the last ADMIN, which is the floor firing live');
  } else {
    assert(revoked.code === 0, `grant-role.ts revoke exited ${revoked.code}: ${revoked.out}`);
    const closed = await call({ method: 'GET', url: '/admin/ping', token });
    assert(closed.status === 404, `after the script revoke: GET /admin/ping returned ${closed.status}, expected 404`);
    console.log(`grant-role: granted and revoked for real, ${others} other admin(s) kept the floor from firing`);
  }

  console.log(`verify-admin passed against ${BASE}`);
} finally {
  await cleanup();
}

process.exit(0);
