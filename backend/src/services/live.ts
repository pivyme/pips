// Who is in the app right now. Two tiers, deliberately: the in-memory presence set (exact, instant, but
// wiped by every restart) plus a 30-minute activity tail read from Postgres, so a deploy does not make
// the dashboard read zero while people are mid-round. Feeds GET /admin/live.

import { prismaQuery } from '../lib/prisma.ts';
import { liveSessionCount, onlinePresence } from '../routes/streamRoutes.ts';

export const LIVE_WINDOW_MS = 30 * 60_000;
const MINUTE_MS = 60_000;
const MAX_ROWS = 100;
const DUSDC_UNIT = 1_000_000; // 6dp, per L-011
const MAX_EVENT_SCAN = 400;

const SETTLED_STATUSES = new Set(['won', 'lost', 'cashed_out']);

export interface LivePresenceRow {
  userId: string;
  sessions: number;
  since: number;
}
export interface LiveUserRow {
  id: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  address: string;
}
export interface LivePlayRow {
  userId: string;
  game: string;
  status: string;
  entryCost: bigint;
  pnl: bigint | null;
  createdAt: Date;
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
  rows: LiveRow[];
  /** Rows past the cap. Reported, never dropped silently. */
  truncated: number;
  playsPerMinute: Array<{ t: number; n: number }>;
  window: { players: number; plays: number; staked: number };
  generatedAt: string;
}

const dusdc = (raw: bigint): number => Number(raw) / DUSDC_UNIT;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Per-minute counts across the window, zero-filled so a quiet minute reads as 0 rather than as a gap. */
export function minuteSeries(dates: Date[], now: number, windowMs: number = LIVE_WINDOW_MS): Array<{ t: number; n: number }> {
  const buckets = Math.max(1, Math.round(windowMs / MINUTE_MS));
  const end = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const start = end - (buckets - 1) * MINUTE_MS;
  const out = Array.from({ length: buckets }, (_, i) => ({ t: start + i * MINUTE_MS, n: 0 }));
  for (const d of dates) {
    const i = Math.floor((d.getTime() - start) / MINUTE_MS);
    if (i >= 0 && i < buckets) out[i]!.n += 1;
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
  plays: LivePlayRow[];
  openPlays: LiveOpenPlay[];
  /** Newest first. */
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
    e.plays += 1;
    e.staked += p.entryCost;
    if (SETTLED_STATUSES.has(p.status)) e.pnl += p.pnl ?? 0n;
    e.lastAt = Math.max(e.lastAt, p.createdAt.getTime());
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

    const lastSeenAt = p ? now : Math.max(a?.lastAt ?? 0, ev?.ts.getTime() ?? 0);
    const doing = open ? `IN PLAY · ${open.game.toUpperCase()}` : ev ? describeActivity(ev.name, ev.props) : 'IDLE';

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
      doing,
      platform: ev?.platform ?? null,
      plays: a?.plays ?? 0,
      staked: round2(dusdc(a?.staked ?? 0n)),
      pnl: round2(dusdc(a?.pnl ?? 0n)),
    });
  }

  rows.sort((x, y) => (x.live === y.live ? y.lastSeenAt - x.lastSeenAt : x.live ? -1 : 1));
  return { rows: rows.slice(0, MAX_ROWS), truncated: Math.max(0, rows.length - MAX_ROWS) };
}

export async function liveReport(now: number = Date.now()): Promise<LiveReport> {
  const since = new Date(now - LIVE_WINDOW_MS);
  const presence = onlinePresence();

  // Served by @@index([createdAt]) and @@index([status, expiry]).
  const [plays, openPlays] = await Promise.all([
    prismaQuery.play.findMany({
      where: { createdAt: { gte: since } },
      select: { userId: true, game: true, status: true, entryCost: true, pnl: true, createdAt: true },
    }),
    prismaQuery.play.findMany({ where: { status: 'open' }, select: { userId: true, game: true, expiry: true } }),
  ]);

  const ids = [...new Set([...presence.map((p) => p.userId), ...plays.map((p) => p.userId)])];

  // Event has no relation to User, so both of these are id-scoped reads joined in memory. Never scan Event
  // by a bare ts range: there is no lone ts index and the table is retained for a year.
  const [users, events] = await Promise.all([
    ids.length
      ? prismaQuery.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, username: true, displayName: true, avatarUrl: true, address: true },
        })
      : Promise.resolve([]),
    ids.length
      ? prismaQuery.event.findMany({
          where: { userId: { in: ids }, ts: { gte: since } },
          orderBy: { ts: 'desc' },
          take: MAX_EVENT_SCAN,
          select: { userId: true, name: true, props: true, ts: true, platform: true },
        })
      : Promise.resolve([]),
  ]);

  const { rows, truncated } = assembleRows({ presence, users, plays, openPlays, events, now });

  let staked = 0n;
  for (const p of plays) staked += p.entryCost;

  return {
    online: { users: presence.length, sessions: liveSessionCount() },
    windowMin: Math.round(LIVE_WINDOW_MS / 60_000),
    rows,
    truncated,
    playsPerMinute: minuteSeries(
      plays.map((p) => p.createdAt),
      now,
    ),
    window: {
      players: new Set(plays.map((p) => p.userId)).size,
      plays: plays.length,
      staked: round2(dusdc(staked)),
    },
    generatedAt: new Date(now).toISOString(),
  };
}
