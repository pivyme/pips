// Leaderboards. Three boards, all keyed to the user so every row reads off a username (or the
// generated displayName as a fallback), never a wallet address:
//   - global    : Top 10 Gainers / Top 10 REKT, summed from settled Play records (the source of truth).
//   - per-game  : Top 10 winners of Lucky or Range, summed from settled Play records.
//   - minigame  : Top 10 high scores of Line Rider / Flappy Piper, off MinigameScore.
// Read-only and cheap (localnet scale); nothing here writes except submitMinigameScore.

import { prismaQuery } from '../lib/prisma.ts';
import { fromDusdcRaw } from '../lib/sui/math.ts';
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
const nameFields = { id: true, username: true, displayName: true } as const;

// Global PnL board: gainers (net-positive) and rekt (net-negative, worst first), plus the caller's
// own standing so they always see where they sit even when off the top 10. Summed straight from the
// settled Play ledger (same source as the stats card and per-game boards), so every PnL surface
// agrees and none drifts off a stale counter.
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
    displayName: byId.get(p.userId)?.displayName ?? 'Player',
    netPnl: money(p.pnl),
    gamesPlayed: p.games,
    isYou: p.userId === userId,
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

// Per-game leaderboard: sum settled PnL per player for one game, then split into the top gainers
// (net-positive, most profit first) and the top REKT (net-negative, deepest in the red first).
// Aggregated in JS off a single groupBy (localnet scale), so no aggregate-orderBy assumptions.
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
      pnl: money(r.pnl), // signed: gainers positive, rekt negative
      plays: r.plays,
      isYou: r.userId === userId,
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
      score: r.score,
      isYou: r.userId === userId,
    })),
    best: mine?.score ?? 0,
  };
}

// Record a finished run. Keeps the player's best (a lower score is a no-op), then reports the
// refreshed top 10 and where this run lands globally, mirroring the old local SubmitResult shape.
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

// Every board in one round-trip, run in parallel. Powers the menu leaderboard so switching tabs is
// instant (no per-tab fetch). The in-game overlays still call the focused functions above.
export async function fullLeaderboard(userId: string): Promise<FullLeaderboardDTO> {
  const [global, lucky, range, lineRider, candleHop] = await Promise.all([
    globalLeaderboard(userId),
    gameLeaderboard('lucky', userId),
    gameLeaderboard('range', userId),
    minigameLeaderboard('line-rider', userId),
    minigameLeaderboard('candle-hop', userId),
  ]);
  return {
    global,
    games: { lucky: lucky.entries, range: range.entries },
    minigames: { 'line-rider': lineRider, 'candle-hop': candleHop },
  };
}
