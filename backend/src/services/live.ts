// Who is in the app right now. Two tiers, deliberately: the in-memory presence set (exact, instant, but
// wiped by every restart) plus a database activity tail over a selectable window, so a deploy does not make
// the dashboard read zero while people are mid-round. Feeds GET /admin/live.
//
// Two things are read on their OWN clock, not the window's, because the window is a reporting range and
// they are facts about a person: what someone is doing expires in minutes, and their device does not
// expire at all. Deriving either from "did they emit an event inside the selected window" is what made a
// quiet player read as IDLE on an unknown device.

import { Prisma } from '../../prisma/generated/client.js';
import { prismaQuery } from '../lib/prisma.ts';
import { liveSessionCount, onlinePresence } from '../routes/streamRoutes.ts';

const MINUTE_MS = 60_000;
const MAX_ROWS = 100;
const DUSDC_UNIT = 1_000_000; // 6dp, per L-011

/** Windows the panel offers, in minutes. Anything else falls back to the default rather than being honoured. */
export const LIVE_WINDOWS_MIN = [30, 60, 1440, 10_080] as const;
export const DEFAULT_LIVE_WINDOW_MIN = 1440;

// "Doing" is what someone is on NOW: a 24h window must not report this morning's play as current activity.
const ACTIVITY_TTL_MS = 5 * MINUTE_MS;

// Device is a property of the player, so it is read over a week regardless of window. Bounded on purpose:
// an unbounded per-user lookup walks a heavy player's entire event history on every 5s refresh.
const PLATFORM_HORIZON_MS = 7 * 24 * 60 * MINUTE_MS;

const SETTLED_STATUSES = new Set(['won', 'lost', 'cashed_out']);

export type LiveChartUnit = 'minute' | 'hour';

export interface LivePresenceRow {
  userId: string;
  sessions: number;
  since: number;
  /** Derived from the stream connection's own UA, so a live row always knows the device. */
  platform: string | null;
}
export interface LiveUserRow {
  id: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  address: string;
}
/** One (user, status) rollup out of the Play groupBy. The window is aggregated in SQL, never row by row. */
export interface LivePlayAgg {
  userId: string;
  status: string;
  plays: number;
  entryCost: bigint;
  pnl: bigint;
  lastAt: number;
}
export interface LiveOpenPlay {
  userId: string;
  game: string;
  expiry: bigint;
}
export interface LiveEventRow {
  userId: string | null;
  name: string;
  props: unknown;
  ts: Date;
  platform: string;
}

export interface LiveRow {
  id: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  address: string;
  /** Holding an open /stream/live connection right now. False means "was here, tab is closed". */
  live: boolean;
  sessions: number;
  /** When their first still-open session connected. null once they are only in the activity tail. */
  since: number | null;
  lastSeenAt: number;
  /** Last thing they actually did, at any age. null = nothing on record, which is not the same as idle now. */
  lastActiveAt: number | null;
  doing: string;
  platform: string | null;
  plays: number;
  /** DUSDC actually committed this window (Σ entryCost), so a pending play contributes 0. */
  staked: number;
  /** Realized DUSDC PnL over plays that settled this window. Positive means the player is up. */
  pnl: number;
}

export interface LiveReport {
  online: { users: number; sessions: number };
  windowMin: number;
  /** Width of one bar in playsSeries. The axis is told what it is looking at instead of guessing. */
  bucketMs: number;
  unit: LiveChartUnit;
  rows: LiveRow[];
  /** Rows past the cap. Reported, never dropped silently. */
  truncated: number;
  playsSeries: Array<{ t: number; n: number }>;
  window: { players: number; plays: number; staked: number };
  generatedAt: string;
}

const dusdc = (raw: bigint): number => Number(raw) / DUSDC_UNIT;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Only a window we offer. A stray query string reads as the default rather than as a custom range. */
export function normalizeWindowMin(minutes: unknown): number {
  const n = Number(minutes);
  return (LIVE_WINDOWS_MIN as readonly number[]).includes(n) ? n : DEFAULT_LIVE_WINDOW_MIN;
}

/** Bar width per window, chosen so every range lands between 30 and ~170 bars. */
export function bucketMsFor(windowMin: number): number {
  if (windowMin <= 60) return MINUTE_MS;
  if (windowMin <= 1440) return 15 * MINUTE_MS;
  return 60 * MINUTE_MS;
}

export const chartUnitFor = (windowMin: number): LiveChartUnit => (windowMin <= 60 ? 'minute' : 'hour');

/** Zero-filled bars across the window, so a quiet bucket reads as 0 rather than as a gap. */
export function fillBuckets(
  counts: Array<{ t: number; n: number }>,
  now: number,
  windowMs: number,
  bucketMs: number,
): Array<{ t: number; n: number }> {
  const total = Math.max(1, Math.round(windowMs / bucketMs));
  const end = Math.floor(now / bucketMs) * bucketMs;
  const start = end - (total - 1) * bucketMs;
  const out = Array.from({ length: total }, (_, i) => ({ t: start + i * bucketMs, n: 0 }));
  for (const c of counts) {
    const i = Math.floor((c.t - start) / bucketMs);
    if (i >= 0 && i < total) out[i]!.n += c.n;
  }
  return out;
}

function propString(props: unknown, key: string): string | null {
  if (!props || typeof props !== 'object') return null;
  const v = (props as Record<string, unknown>)[key];
  return typeof v === 'string' && v ? v : null;
}

/** The one-line "what are they looking at", read off their most recent event. Falls back to the namespace. */
export function describeActivity(name: string, props: unknown): string {
  const game = propString(props, 'game');
  switch (name) {
    case 'game.open':
    case 'game.play_tap':
    case 'game.play_open':
    case 'game.knob_change':
    case 'game.stake_change':
    case 'game.cashout_tap':
    case 'game.cashout_done':
    case 'game.settled':
    case 'game.restore':
      return game ? game.toUpperCase() : 'PLAYING';
    case 'hub.view':
    case 'hub.game_tile_tap':
    case 'hub.inplay_resume':
      return 'HUB';
    case 'menu.open':
      return 'MENU';
    case 'menu.section': {
      const section = propString(props, 'section');
      return section ? `MENU · ${section.toUpperCase()}` : 'MENU';
    }
    case 'arcade.start':
    case 'arcade.end':
      return game ? `ARCADE · ${game.toUpperCase()}` : 'ARCADE';
    case 'custom.studio_open':
    case 'custom.skin_preview':
    case 'custom.skin_apply':
      return 'CUSTOMIZE';
    default: {
      const ns = name.split('.')[0] ?? name;
      return ns.toUpperCase();
    }
  }
}

export interface AssembleInput {
  presence: LivePresenceRow[];
  users: LiveUserRow[];
  plays: LivePlayAgg[];
  openPlays: LiveOpenPlay[];
  /** Newest first, at most one per user. */
  events: LiveEventRow[];
  now: number;
}

export function assembleRows(input: AssembleInput): { rows: LiveRow[]; truncated: number } {
  const { presence, users, plays, openPlays, events, now } = input;

  const userById = new Map(users.map((u) => [u.id, u]));
  const presenceById = new Map(presence.map((p) => [p.userId, p]));

  const agg = new Map<string, { plays: number; staked: bigint; pnl: bigint; lastAt: number }>();
  for (const p of plays) {
    const e = agg.get(p.userId) ?? { plays: 0, staked: 0n, pnl: 0n, lastAt: 0 };
    e.plays += p.plays;
    e.staked += p.entryCost;
    if (SETTLED_STATUSES.has(p.status)) e.pnl += p.pnl;
    e.lastAt = Math.max(e.lastAt, p.lastAt);
    agg.set(p.userId, e);
  }

  const openByUser = new Map<string, LiveOpenPlay>();
  for (const o of openPlays) if (!openByUser.has(o.userId)) openByUser.set(o.userId, o);

  // Events arrive newest first, so the first one per user is their latest.
  const lastEvent = new Map<string, LiveEventRow>();
  for (const ev of events) {
    if (!ev.userId || lastEvent.has(ev.userId)) continue;
    lastEvent.set(ev.userId, ev);
  }

  const ids = new Set<string>([...presenceById.keys(), ...agg.keys()]);
  const rows: LiveRow[] = [];
  for (const id of ids) {
    const user = userById.get(id);
    if (!user) continue; // pruned or deleted between the presence read and the user read
    const p = presenceById.get(id);
    const a = agg.get(id);
    const ev = lastEvent.get(id);
    const open = openByUser.get(id);

    const lastActiveAt = Math.max(a?.lastAt ?? 0, ev?.ts.getTime() ?? 0) || null;
    const lastSeenAt = p ? now : (lastActiveAt ?? 0);
    // An event older than the TTL is history, not an activity: it names the device, never the doing.
    const current = ev && now - ev.ts.getTime() <= ACTIVITY_TTL_MS ? ev : null;
    const doing = open ? `IN PLAY · ${open.game.toUpperCase()}` : current ? describeActivity(current.name, current.props) : 'IDLE';

    rows.push({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      address: user.address,
      live: !!p,
      sessions: p?.sessions ?? 0,
      since: p?.since ?? null,
      lastSeenAt,
      lastActiveAt,
      doing,
      platform: ev?.platform ?? p?.platform ?? null,
      plays: a?.plays ?? 0,
      staked: round2(dusdc(a?.staked ?? 0n)),
      pnl: round2(dusdc(a?.pnl ?? 0n)),
    });
  }

  rows.sort((x, y) => (x.live === y.live ? y.lastSeenAt - x.lastSeenAt : x.live ? -1 : 1));
  return { rows: rows.slice(0, MAX_ROWS), truncated: Math.max(0, rows.length - MAX_ROWS) };
}

/** Plays per bar, bucketed in SQL. A week of plays must never be pulled row by row to be counted. */
async function playBuckets(since: Date, bucketMs: number): Promise<Array<{ t: number; n: number }>> {
  // bucketMs is one of our own constants off the window allowlist, never client input.
  const width = Prisma.raw(String(Math.round(bucketMs)));
  const rows = await prismaQuery.$queryRaw<Array<{ t: bigint; n: bigint }>>`
    SELECT (floor(extract(epoch from "createdAt") * 1000 / ${width}) * ${width})::bigint AS t, count(*)::bigint AS n
    FROM "Play"
    WHERE "createdAt" >= ${since}
    GROUP BY 1
  `;
  return rows.map((r) => ({ t: Number(r.t), n: Number(r.n) }));
}

/** The newest event per user, one row each. A global newest-N starves everyone behind the busiest player. */
async function latestEvents(ids: string[], floor: Date): Promise<LiveEventRow[]> {
  if (!ids.length) return [];
  return prismaQuery.$queryRaw<LiveEventRow[]>`
    SELECT DISTINCT ON ("userId") "userId", name, props, ts, platform
    FROM "Event"
    WHERE "userId" IN (${Prisma.join(ids)}) AND ts >= ${floor}
    ORDER BY "userId", ts DESC
  `;
}

export async function liveReport(windowMin: number = DEFAULT_LIVE_WINDOW_MIN, now: number = Date.now()): Promise<LiveReport> {
  const win = normalizeWindowMin(windowMin);
  const windowMs = win * MINUTE_MS;
  const bucketMs = bucketMsFor(win);
  const since = new Date(now - windowMs);
  const presence = onlinePresence();

  // Served by @@index([createdAt]) and @@index([status, expiry]). The rollup is one groupBy, so a wide
  // window costs the same round trip as a narrow one.
  const [grouped, openPlays, buckets] = await Promise.all([
    prismaQuery.play.groupBy({
      by: ['userId', 'status'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { entryCost: true, pnl: true },
      _max: { createdAt: true },
    }),
    prismaQuery.play.findMany({ where: { status: 'open' }, select: { userId: true, game: true, expiry: true } }),
    playBuckets(since, bucketMs),
  ]);

  const plays: LivePlayAgg[] = grouped.map((g) => ({
    userId: g.userId,
    status: g.status,
    plays: g._count._all,
    entryCost: g._sum.entryCost ?? 0n,
    pnl: g._sum.pnl ?? 0n,
    lastAt: g._max.createdAt?.getTime() ?? 0,
  }));

  const ids = [...new Set([...presence.map((p) => p.userId), ...plays.map((p) => p.userId)])];

  // Event has no relation to User, so both of these are id-scoped reads joined in memory.
  const [users, events] = await Promise.all([
    ids.length
      ? prismaQuery.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, username: true, displayName: true, avatarUrl: true, address: true },
        })
      : Promise.resolve([]),
    latestEvents(ids, new Date(now - Math.max(windowMs, PLATFORM_HORIZON_MS))),
  ]);

  const { rows, truncated } = assembleRows({ presence, users, plays, openPlays, events, now });

  let staked = 0n;
  let played = 0;
  for (const p of plays) {
    staked += p.entryCost;
    played += p.plays;
  }

  return {
    online: { users: presence.length, sessions: liveSessionCount() },
    windowMin: win,
    bucketMs,
    unit: chartUnitFor(win),
    rows,
    truncated,
    playsSeries: fillBuckets(buckets, now, windowMs, bucketMs),
    window: {
      players: new Set(plays.map((p) => p.userId)).size,
      plays: played,
      staked: round2(dusdc(staked)),
    },
    generatedAt: new Date(now).toISOString(),
  };
}
