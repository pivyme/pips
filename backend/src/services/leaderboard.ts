// Three leaderboards, global PnL / per-game / minigame high scores, all keyed to username or displayName,
// never a wallet address. Read-only except submitMinigameScore; minigame submissions are validated server-side via openMinigameRun + checkRun (below).

import crypto from 'node:crypto';

import jwt from 'jsonwebtoken';

import { prismaQuery } from '../lib/prisma.ts';
import { JWT_SECRET, MINIGAME_MIN_RUN_MS, MINIGAME_RUN_TTL_S } from '../config/main-config.ts';
import { fromDusdcRaw } from '../lib/sui/math.ts';
import { effectiveAvatar } from '../utils/miscUtils.ts';
import type {
  FullLeaderboardDTO,
  GameLeaderboardDTO,
  GlobalLeaderboardDTO,
  LeaderboardPnlEntryDTO,
  Minigame,
  MinigameLeaderboardDTO,
  MinigameSubmitDTO,
} from '../types/api.ts';

const TOP = 10;
const SETTLED = ['won', 'lost', 'cashed_out'];
const money = (raw: bigint): string => fromDusdcRaw(raw).toFixed(2);
const nameFields = { id: true, username: true, displayName: true, twitterUsername: true, avatarUrl: true } as const;
const noAvatar = { avatarUrl: null }; // fallback when a user row is missing

// The X badge shows a player's linked, OAuth-verified X handle (lowercased), or null if none. It sits next
// to the real handle on the client, so it never implies the PIPS @username is the X account. Read at query
// time (never denormalized), so a handle change never drifts from the badge.
const twitterHandle = (u: { twitterUsername: string | null }): string | null =>
  u.twitterUsername ? u.twitterUsername.toLowerCase() : null;

// Global PnL board: gainers (net-positive) and rekt (net-negative, worst first), plus the caller's own
// standing even off the top 10. Summed straight from the settled Play ledger, the same source as the stats card and per-game boards, so every PnL surface agrees.
export async function globalLeaderboard(userId: string): Promise<GlobalLeaderboardDTO> {
  const grouped = await prismaQuery.play.groupBy({
    by: ['userId'],
    where: { status: { in: SETTLED } },
    _sum: { pnl: true },
    _count: { _all: true },
  });
  const players = grouped.map((g) => ({ userId: g.userId, pnl: g._sum.pnl ?? 0n, games: g._count._all }));

  const gainers = players.filter((p) => p.pnl > 0n).sort((a, b) => (a.pnl < b.pnl ? 1 : a.pnl > b.pnl ? -1 : 0)).slice(0, TOP);
  const rekt = players.filter((p) => p.pnl < 0n).sort((a, b) => (a.pnl > b.pnl ? 1 : a.pnl < b.pnl ? -1 : 0)).slice(0, TOP);

  const ids = new Set([...gainers, ...rekt].map((p) => p.userId));
  ids.add(userId);
  const users = await prismaQuery.user.findMany({ where: { id: { in: [...ids] } }, select: nameFields });
  const byId = new Map(users.map((u) => [u.id, u]));

  const row = (p: (typeof players)[number], i: number): LeaderboardPnlEntryDTO => ({
    rank: i + 1,
    username: byId.get(p.userId)?.username ?? null,
    avatarUrl: effectiveAvatar(byId.get(p.userId) ?? noAvatar),
    netPnl: money(p.pnl),
    gamesPlayed: p.games,
    isYou: p.userId === userId,
    twitterHandle: twitterHandle(byId.get(p.userId) ?? { twitterUsername: null }),
  });

  const me = players.find((p) => p.userId === userId);
  const myPnl = me?.pnl ?? 0n;
  const gainerRank = myPnl > 0n ? players.filter((p) => p.pnl > myPnl).length + 1 : null;
  const rektRank = myPnl < 0n ? players.filter((p) => p.pnl < myPnl).length + 1 : null;

  return {
    gainers: gainers.map(row),
    rekt: rekt.map(row),
    you: { gainerRank, rektRank, netPnl: money(myPnl), gamesPlayed: me?.games ?? 0 },
  };
}

// Per-game leaderboard: sums settled PnL per player for one game, split into top gainers (net-positive) and
// top REKT (net-negative, deepest first). Aggregated in JS off a single groupBy, so no aggregate-orderBy assumptions.
export async function gameLeaderboard(game: string, userId: string): Promise<GameLeaderboardDTO> {
  const grouped = await prismaQuery.play.groupBy({
    by: ['userId'],
    where: { game, status: { in: SETTLED } },
    _sum: { pnl: true },
    _count: { _all: true },
  });

  const rows = grouped.map((g) => ({ userId: g.userId, pnl: g._sum.pnl ?? 0n, plays: g._count._all }));
  const gainers = rows
    .filter((g) => g.pnl > 0n)
    .sort((a, b) => (a.pnl < b.pnl ? 1 : a.pnl > b.pnl ? -1 : 0))
    .slice(0, TOP);
  const rekt = rows
    .filter((g) => g.pnl < 0n)
    .sort((a, b) => (a.pnl > b.pnl ? 1 : a.pnl < b.pnl ? -1 : 0))
    .slice(0, TOP);

  // One name lookup across both boards (a player can only land on one side, so the ids never overlap).
  const ids = [...new Set([...gainers, ...rekt].map((r) => r.userId))];
  const users = await prismaQuery.user.findMany({ where: { id: { in: ids } }, select: nameFields });
  const byId = new Map(users.map((u) => [u.id, u]));

  const entry = (r: (typeof rows)[number], i: number) => {
    const u = byId.get(r.userId);
    return {
      rank: i + 1,
      username: u?.username ?? null,
      displayName: u?.displayName ?? 'Player',
      avatarUrl: effectiveAvatar(u ?? noAvatar),
      pnl: money(r.pnl), // signed: gainers positive, rekt negative
      plays: r.plays,
      isYou: r.userId === userId,
      twitterHandle: twitterHandle(u ?? { twitterUsername: null }),
    };
  };

  return { entries: gainers.map(entry), rekt: rekt.map(entry) };
}

// Minigame high scores: one best-score row per player, ordered desc.
export async function minigameLeaderboard(game: Minigame, userId: string): Promise<MinigameLeaderboardDTO> {
  const [rows, mine] = await Promise.all([
    prismaQuery.minigameScore.findMany({
      where: { game },
      orderBy: { score: 'desc' },
      take: TOP,
      include: { user: { select: nameFields } },
    }),
    prismaQuery.minigameScore.findUnique({ where: { userId_game: { userId, game } } }),
  ]);

  return {
    entries: rows.map((r, i) => ({
      rank: i + 1,
      username: r.user.username,
      displayName: r.user.displayName,
      avatarUrl: effectiveAvatar(r.user),
      score: r.score,
      isYou: r.userId === userId,
      twitterHandle: twitterHandle(r.user),
    })),
    best: mine?.score ?? 0,
  };
}

// Records a finished run, keeping the player's best (a lower score is a no-op), and reports the refreshed top 10 plus where this run lands globally.
export async function submitMinigameScore(userId: string, game: Minigame, score: number): Promise<MinigameSubmitDTO> {
  const existing = await prismaQuery.minigameScore.findUnique({ where: { userId_game: { userId, game } } });
  const prevBest = existing?.score ?? 0;
  const best = Math.max(prevBest, score);
  if (score > prevBest) {
    await prismaQuery.minigameScore.upsert({
      where: { userId_game: { userId, game } },
      create: { userId, game, score },
      update: { score },
    });
  }

  const above = await prismaQuery.minigameScore.count({ where: { game, score: { gt: best } } });
  const rank = above + 1;
  const { entries } = await minigameLeaderboard(game, userId);
  return { entries, rank, best, isBest: score > prevBest && rank === 1, prevBest };
}

// The menu leaderboard is now PnL-only (Gainers/REKT), so this is just the global board: one groupBy, not
// six. The in-game overlays still hit gameLeaderboard/minigameLeaderboard directly.
export async function fullLeaderboard(userId: string): Promise<FullLeaderboardDTO> {
  return { global: await globalLeaderboard(userId) };
}

// === Minigame run validation ============================================================

// Per-game score bound coefficients used by checkRun.
const SCORE_BOUND: Record<Minigame, { a: number; b: number; slack: number }> = {
  'flappy-piper': { a: 2, b: 0, slack: 3 },
  'line-rider': { a: 70, b: 60, slack: 20 },
};

// jti -> expiry epoch ms, so a token is honored once. Pruned opportunistically.
const usedRuns = new Map<string, number>();
function pruneUsed(now: number): void {
  if (usedRuns.size < 4096) return;
  for (const [jti, exp] of usedRuns) if (exp <= now) usedRuns.delete(jti);
}

interface RunClaims {
  sub: string;
  game: Minigame;
  typ: 'run';
  iat: number; // seconds
  jti: string;
}

// Open a run and return the token required to submit its score.
export function openMinigameRun(userId: string, game: Minigame): string {
  return jwt.sign({ typ: 'run', game }, JWT_SECRET, {
    subject: userId,
    jwtid: crypto.randomUUID(),
    expiresIn: MINIGAME_RUN_TTL_S,
  } as jwt.SignOptions);
}

// A rejection carries a `reason` for server-side logging only; the route returns one generic error so a failed submit doesn't reveal which check tripped.
export type RunCheck = { ok: true } | { ok: false; reason: string };

// Validate a submitted run. Returns a typed result; the route maps any failure to a single response.
export function checkRun(userId: string, game: Minigame, score: number, runToken: unknown): RunCheck {
  if (typeof runToken !== 'string' || runToken.length === 0) {
    return { ok: false, reason: 'no-token' };
  }

  let claims: RunClaims;
  try {
    claims = jwt.verify(runToken, JWT_SECRET) as RunClaims;
  } catch (err) {
    return { ok: false, reason: err instanceof jwt.TokenExpiredError ? 'expired' : 'bad-token' };
  }

  const now = Date.now();
  pruneUsed(now);

  if (claims.typ !== 'run' || claims.sub !== userId || claims.game !== game) {
    return { ok: false, reason: 'mismatch' };
  }
  if (usedRuns.has(claims.jti)) {
    return { ok: false, reason: 'reused' };
  }
  usedRuns.set(claims.jti, (claims.iat + MINIGAME_RUN_TTL_S) * 1000);

  const elapsedMs = now - claims.iat * 1000;
  if (elapsedMs < MINIGAME_MIN_RUN_MS) {
    return { ok: false, reason: 'too-short' };
  }

  const { a, b, slack } = SCORE_BOUND[game];
  const t = elapsedMs / 1000;
  if (score > a * t + b * t * t + slack) {
    return { ok: false, reason: 'out-of-bounds' };
  }

  return { ok: true };
}
