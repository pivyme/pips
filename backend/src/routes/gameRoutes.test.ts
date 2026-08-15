// The lab gate (04-GAMES-LAB.md §2). A lab game is ADMIN-only, and for everyone else it must be
// indistinguishable from a game that does not exist: 404, never 403, never 200.
//
// The client-side hiding in the cartridge grid is tidiness. This is the actual gate, so it is asserted
// on the real route through a real request, and it asserts the STATUS CODE, not merely "denied": a 403
// would confirm the surface exists, which is the whole thing the rule prevents.

import { describe, expect, it, mock } from 'bun:test';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';

const ADMIN = { id: 'u_admin', specialRoles: ['ADMIN'] };
const NORMAL = { id: 'u_normal', specialRoles: [] };

mock.module('../lib/prisma.ts', () => ({
  prismaQuery: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === ADMIN.id ? ADMIN : where.id === NORMAL.id ? NORMAL : null,
    },
    errorLog: { create: async () => ({}) },
  },
}));

// The gate runs before any of these, so the play path itself never has to be real here.
mock.module('../services/plays.ts', () => ({
  createPlay: async () => ({ play: { id: 'play_test' } }),
  cashoutPlay: async () => ({ play: { id: 'play_test' }, unlocked: [] }),
  listPlays: async () => [],
  getPlay: async () => null,
}));

const { gameRoutes } = await import('./gameRoutes.ts');
const { JWT_SECRET } = await import('../config/main-config.ts');

const tokenFor = (userId: string): string => jwt.sign({ userId }, JWT_SECRET);

async function play(game: string, userId: string | null): Promise<{ status: number; code: string | null }> {
  const app = Fastify({ logger: false });
  await app.register(gameRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/games/${game}/play`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(userId ? { authorization: `Bearer ${tokenFor(userId)}` } : {}) },
      body: JSON.stringify({ stake: '1.50' }),
    });
    const body = (await res.json()) as { error?: { code?: string } };
    return { status: res.status, code: body.error?.code ?? null };
  } finally {
    await app.close();
  }
}

const LAB_GAMES = ['pin', 'snipe', 'press', 'rush', 'breakout'];

describe('lab games are ADMIN-only at the API', () => {
  // Every built game, not a sample: a gate that holds for four of five leaks the fifth.
  it.each(LAB_GAMES)('answers 404 for %s, the same as a game that does not exist', async (game) => {
    const lab = await play(game, NORMAL.id);
    const nonsense = await play('not-a-game', NORMAL.id);
    expect(lab.status).toBe(404);
    expect(lab.status).not.toBe(403);
    expect(lab).toEqual(nonsense);
  });

  it.each(LAB_GAMES)('lets an ADMIN reach %s', async (game) => {
    const { status } = await play(game, ADMIN.id);
    expect(status).not.toBe(404);
  });

  it('leaves a public game alone for a normal user', async () => {
    // Reaches param validation, which is proof the gate let it through rather than proof of a play.
    const { status, code } = await play('range', NORMAL.id);
    expect(status).not.toBe(404);
    expect(code).toBe('INVALID_PARAMS');
  });

  it('answers 401 with no token, so the gate never runs on an anonymous request', async () => {
    const { status } = await play('pin', null);
    expect(status).toBe(401);
  });
});
