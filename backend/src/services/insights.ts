// Dashboard reads: grouped errors, one group's detail, and the AI brief. The brief is the whole reason
// this system is in-house: "what the user was doing", "system state at the time", and "correlated" come
// from joining Event, Play, and the error's own captured context in one Postgres.
// See bigdev/plans/cont/03-ADMIN-DASHBOARD.md §5 and §7.4.

import { EVENT_NAMES } from '../config/analytics-catalog.ts';
import { prismaQuery } from '../lib/prisma.ts';

export type ErrorStatus = 'open' | 'ack' | 'resolved' | 'ignored';
export const ERROR_STATUSES: ErrorStatus[] = ['open', 'ack', 'resolved', 'ignored'];

export interface ErrorGroupRow {
  fingerprint: string;
  title: string;
  culprit: string | null;
  kind: string;
  level: string;
  count: number;
  usersAffected: number;
  firstSeen: string;
  lastSeen: string;
  status: string;
  firstRelease: string | null;
  lastRelease: string | null;
  notes: string | null;
  /** Occurrences in the last 24h vs the 24h before it: 'up' | 'down' | 'flat'. */
  trend: 'up' | 'down' | 'flat';
  last24h: number;
}

export interface ErrorListFilters {
  status?: string;
  level?: string;
  kind?: string;
  network?: string;
  release?: string;
  limit?: number;
}

const DAY_MS = 86_400_000;

// Grouped list. Default is open bugs, newest first, which is the triage order: what is broken now.
export async function listErrorGroups(f: ErrorListFilters): Promise<ErrorGroupRow[]> {
  const limit = Math.min(200, Math.max(1, f.limit ?? 100));
  const where: Record<string, unknown> = {};
  if (f.status && f.status !== 'all') where.status = f.status;
  else if (!f.status) where.status = 'open';
  if (f.level) where.level = f.level;
  if (f.kind) where.kind = f.kind;
  // network and release live on the samples, so filter the groups through them.
  if (f.network || f.release) {
    where.samples = { some: { ...(f.network ? { network: f.network } : {}), ...(f.release ? { release: f.release } : {}) } };
  }

  const groups = await prismaQuery.errorGroup.findMany({ where, orderBy: { lastSeen: 'desc' }, take: limit });
  if (!groups.length) return [];

  const fps = groups.map((g) => g.fingerprint);
  const now = Date.now();
  const [recent, prior] = await Promise.all([
    prismaQuery.errorEvent.groupBy({
      by: ['fingerprint'],
      where: { fingerprint: { in: fps }, createdAt: { gte: new Date(now - DAY_MS) } },
      _count: { _all: true },
    }),
    prismaQuery.errorEvent.groupBy({
      by: ['fingerprint'],
      where: { fingerprint: { in: fps }, createdAt: { gte: new Date(now - 2 * DAY_MS), lt: new Date(now - DAY_MS) } },
      _count: { _all: true },
    }),
  ]);

  const recentBy = new Map(recent.map((r) => [r.fingerprint, r._count._all]));
  const priorBy = new Map(prior.map((r) => [r.fingerprint, r._count._all]));

  return groups.map((g) => {
    const a = recentBy.get(g.fingerprint) ?? 0;
    const b = priorBy.get(g.fingerprint) ?? 0;
    return {
      fingerprint: g.fingerprint,
      title: g.title,
      culprit: g.culprit,
      kind: g.kind,
      level: g.level,
      count: g.count,
      usersAffected: g.usersAffected,
      firstSeen: g.firstSeen.toISOString(),
      lastSeen: g.lastSeen.toISOString(),
      status: g.status,
      firstRelease: g.firstRelease,
      lastRelease: g.lastRelease,
      notes: g.notes,
      trend: a > b ? 'up' : a < b ? 'down' : 'flat',
      last24h: a,
    };
  });
}

export interface ErrorDetail {
  group: ErrorGroupRow;
  samples: Array<{
    id: string;
    message: string;
    stack: string | null;
    context: unknown;
    userId: string | null;
    sessionId: string | null;
    requestId: string | null;
    method: string | null;
    path: string | null;
    playId: string | null;
    release: string | null;
    network: string | null;
    createdAt: string;
  }>;
  /** Hourly occurrence buckets over the last 24h, oldest first, for the hand-rolled SVG chart. */
  occurrences: Array<{ t: number; n: number }>;
  users: Array<{ id: string; username: string | null }>;
  plays: Array<{ id: string; game: string; status: string; stake: string; createdAt: string }>;
}

export async function getErrorDetail(fingerprint: string): Promise<ErrorDetail | null> {
  const rows = await listErrorGroups({ status: 'all', limit: 200 });
  const group = rows.find((r) => r.fingerprint === fingerprint) ?? (await oneGroupRow(fingerprint));
  if (!group) return null;

  const samples = await prismaQuery.errorEvent.findMany({
    where: { fingerprint },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  const userIds = [...new Set(samples.map((s) => s.userId).filter((v): v is string => !!v))];
  const playIds = [...new Set(samples.map((s) => s.playId).filter((v): v is string => !!v))];

  const [users, plays] = await Promise.all([
    userIds.length ? prismaQuery.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } }) : [],
    playIds.length
      ? prismaQuery.play.findMany({
          where: { id: { in: playIds } },
          select: { id: true, game: true, status: true, stake: true, createdAt: true },
        })
      : [],
  ]);

  return {
    group,
    samples: samples.map((s) => ({
      id: s.id,
      message: s.message,
      stack: s.stack,
      context: s.context,
      userId: s.userId,
      sessionId: s.sessionId,
      requestId: s.requestId,
      method: s.method,
      path: s.path,
      playId: s.playId,
      release: s.release,
      network: s.network,
      createdAt: s.createdAt.toISOString(),
    })),
    occurrences: hourlyBuckets(samples.map((s) => s.createdAt)),
    users: users.map((u) => ({ id: u.id, username: u.username })),
    plays: plays.map((p) => ({
      id: p.id,
      game: p.game,
      status: p.status,
      stake: p.stake.toString(),
      createdAt: p.createdAt.toISOString(),
    })),
  };
}

// A group that fell outside the list query (e.g. an ignored one past the limit) still has a detail page.
async function oneGroupRow(fingerprint: string): Promise<ErrorGroupRow | null> {
  const g = await prismaQuery.errorGroup.findUnique({ where: { fingerprint } });
  if (!g) return null;
  return {
    fingerprint: g.fingerprint,
    title: g.title,
    culprit: g.culprit,
    kind: g.kind,
    level: g.level,
    count: g.count,
    usersAffected: g.usersAffected,
    firstSeen: g.firstSeen.toISOString(),
    lastSeen: g.lastSeen.toISOString(),
    status: g.status,
    firstRelease: g.firstRelease,
    lastRelease: g.lastRelease,
    notes: g.notes,
    trend: 'flat',
    last24h: 0,
  };
}

// 24 hourly buckets ending now. Samples are capped at 20 per group, so this describes the retained
// window, not the true rate; the group's count is the number that never lies.
function hourlyBuckets(dates: Date[]): Array<{ t: number; n: number }> {
  const now = Date.now();
  const out: Array<{ t: number; n: number }> = [];
  for (let h = 23; h >= 0; h--) {
    const start = now - (h + 1) * 3_600_000;
    const end = now - h * 3_600_000;
    out.push({ t: end, n: dates.filter((d) => d.getTime() >= start && d.getTime() < end).length });
  }
  return out;
}

export async function setErrorStatus(fingerprint: string, status: ErrorStatus, notes?: string | null): Promise<ErrorGroupRow | null> {
  const exists = await prismaQuery.errorGroup.findUnique({ where: { fingerprint }, select: { fingerprint: true } });
  if (!exists) return null;
  await prismaQuery.errorGroup.update({
    where: { fingerprint },
    data: {
      status,
      resolvedAt: status === 'resolved' ? new Date() : null,
      ...(notes !== undefined ? { notes } : {}),
    },
  });
  return oneGroupRow(fingerprint);
}

// ---------------------------------------------------------------------------
// The AI brief (§5)
// ---------------------------------------------------------------------------

const BRIEF_MAX_BYTES = 8192;

// Maps a culprit file to the neighbours worth opening with it, plus the lessons that already cover the
// area. Small and static on purpose: a wrong pointer costs more than a missing one.
const NEIGHBOURS: Array<{ test: RegExp; files: string[]; lessons: string[] }> = [
  {
    test: /plays\.ts|predict-real\.ts|execute\.ts/,
    files: ['backend/src/services/plays.ts', 'backend/src/lib/sui/predict-real.ts', 'backend/src/lib/sui/execute.ts'],
    lessons: ['L-011 (min net premium)', 'L-012 (mint-and-snap pricing)', 'pips-mint-backing-abort'],
  },
  {
    test: /settle\.ts|redeem/,
    files: ['backend/src/workers/settle.ts', 'backend/src/services/plays.ts', 'backend/src/lib/sui/execute.ts'],
    lessons: ['L-014 (serial executor vs address-balance gas)', 'pips-settle-abort1'],
  },
  {
    test: /sponsor\.ts|play-safety\.ts/,
    files: ['backend/src/lib/sui/sponsor.ts', 'backend/src/lib/sui/play-safety.ts'],
    lessons: ['L-008 (finite testnet SUI)', 'pips-sponsor-reservation-wedge', 'pips-sponsor-accumulator'],
  },
  {
    test: /market-sync|config-real\.ts/,
    files: ['backend/src/workers/market-sync.ts', 'backend/src/lib/sui/config-real.ts'],
    lessons: ['L-006 (no discovery API, read the chain)'],
  },
];

export async function buildBrief(fingerprint: string): Promise<string | null> {
  const detail = await getErrorDetail(fingerprint);
  if (!detail) return null;
  const { group, samples } = detail;
  const newest = samples[0];

  const rate = group.last24h ? `${(group.last24h / 24).toFixed(1)}/hour over the retained samples` : 'no samples in the last 24h';
  const games = tally(detail.plays.map((p) => p.game));
  const surfaces = tally(samples.map((s) => (s.path ? `${s.method ?? 'GET'} ${s.path}` : (s.context as Record<string, unknown> | null)?.worker ? `worker ${String((s.context as Record<string, unknown>).worker)}` : 'internal')));

  const parts: string[] = [];
  parts.push(`# PIPS error: ${group.title}`);
  parts.push('');
  parts.push('## Summary');
  parts.push(`- Fingerprint: ${group.fingerprint}`);
  parts.push(`- Kind: ${group.kind} | Level: ${group.level} | Status: ${group.status}`);
  parts.push(`- Occurrences: ${group.count} across ${group.usersAffected} users`);
  parts.push(`- First seen: ${fmt(group.firstSeen)} (release ${group.firstRelease ?? 'unknown'})`);
  parts.push(`- Last seen:  ${fmt(group.lastSeen)} (release ${group.lastRelease ?? 'unknown'})`);
  parts.push(`- Rate: ${rate}, trending ${group.trend.toUpperCase()}`);
  parts.push(`- Network: ${newest?.network ?? 'unknown'}`);
  parts.push('');
  parts.push('## Where');
  parts.push(`- Culprit: ${group.culprit ?? 'unknown'}`);
  parts.push(`- Surface: ${surfaces || 'unknown'}`);
  if (games) parts.push(`- Affected games: ${games}`);
  parts.push('');

  if (newest?.stack) {
    parts.push('## Stack (most recent occurrence, own-code frames marked >)');
    parts.push(markOwnFrames(newest.stack));
    parts.push('');
  }

  parts.push('## Message');
  parts.push(newest?.message ?? group.title);
  parts.push('');

  const ctx = newest?.context;
  if (ctx && typeof ctx === 'object') {
    parts.push('## Context (redacted)');
    parts.push(JSON.stringify(ctx));
    parts.push('');
  }

  parts.push('## What the user was doing (last 5 events before the error)');
  const trail = newest ? await eventTrail(newest.sessionId, newest.userId, newest.createdAt) : [];
  if (!trail.length) parts.push('- No tracked events for this session.');
  else parts.push(...trail);
  parts.push('');

  parts.push('## System state at the time');
  const sys = systemLines(ctx);
  if (!sys.length) parts.push('- Not captured for this occurrence.');
  else parts.push(...sys);
  parts.push('');

  const correlated = await correlatedGroups(group.fingerprint, new Date(group.lastSeen));
  if (correlated.length) {
    parts.push('## Correlated');
    parts.push(`Also firing in this window: ${correlated.join(', ')}`);
    parts.push('');
  }

  parts.push('## Where to look');
  const hit = NEIGHBOURS.find((n) => n.test.test(group.culprit ?? '')) ?? NEIGHBOURS.find((n) => n.test.test(group.fingerprint));
  for (const f of hit?.files ?? []) parts.push(`- ${f}`);
  if (hit?.lessons.length) parts.push(`- Known lessons: ${hit.lessons.join(', ')}`);
  if (!hit) parts.push(`- ${group.culprit ?? 'no culprit frame recorded'}`);

  return clampBytes(parts.join('\n'), BRIEF_MAX_BYTES);
}

// The five tracked actions leading into the error. Prefers the session (exact), falls back to the user.
async function eventTrail(sessionId: string | null, userId: string | null, at: string): Promise<string[]> {
  const when = new Date(at);
  const where = sessionId ? { sessionId, ts: { lte: when } } : userId ? { userId, ts: { lte: when } } : null;
  if (!where) return [];
  const events = await prismaQuery.event.findMany({ where, orderBy: { ts: 'desc' }, take: 5 });
  return events.reverse().map((e, i) => {
    const ago = Math.round((when.getTime() - e.ts.getTime()) / 1000);
    const props = e.props ? ` ${JSON.stringify(e.props)}` : '';
    return `${i + 1}. -${String(Math.floor(ago / 60)).padStart(2, '0')}:${String(ago % 60).padStart(2, '0')}  ${e.name}${props}`;
  });
}

// The system snapshot captureError folded into context at error time, rendered as prose.
function systemLines(ctx: unknown): string[] {
  if (!ctx || typeof ctx !== 'object') return [];
  const c = ctx as Record<string, unknown>;
  const out: string[] = [];
  if (c.sponsor_sui !== undefined) {
    out.push(`- Sponsor SUI: ${String(c.sponsor_sui)} (floor ${String(c.sponsor_floor_sui ?? '?')}, paused ${String(c.sponsor_paused ?? '?')})`);
  }
  if (c.sponsor_checked_s_ago !== undefined) out.push(`- Sponsor reading age: ${String(c.sponsor_checked_s_ago)}s`);
  return out;
}

// Other groups that also fired in the 15 minutes around this one: the "what else broke at the same time"
// question a vendor cannot answer, because it does not have our other tables either.
async function correlatedGroups(fingerprint: string, at: Date): Promise<string[]> {
  const rows = await prismaQuery.errorEvent.groupBy({
    by: ['fingerprint'],
    where: {
      fingerprint: { not: fingerprint },
      createdAt: { gte: new Date(at.getTime() - 900_000), lte: new Date(at.getTime() + 900_000) },
    },
    _count: { _all: true },
    orderBy: { _count: { fingerprint: 'desc' } },
    take: 3,
  });
  return rows.map((r) => `${r.fingerprint} (+${r._count._all})`);
}

function markOwnFrames(stack: string): string {
  return stack
    .split('\n')
    .slice(0, 12)
    .map((l) => (l.includes('node_modules') || l.includes('node:internal') || !l.trim().startsWith('at ') ? `  ${l.trim()}` : `> ${l.trim()}`))
    .join('\n');
}

function tally(values: string[]): string {
  if (!values.length) return '';
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, n]) => `${k} (${n})`)
    .join(', ');
}

function fmt(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

// Cut on a line boundary so a truncated brief is still valid markdown, and say that it was cut.
function clampBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  const note = '\n\n_(brief truncated at 8KB)_';
  const budget = max - Buffer.byteLength(note, 'utf8');
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = Buffer.byteLength(line, 'utf8') + 1;
    if (used + cost > budget) break;
    kept.push(line);
    used += cost;
  }
  return kept.join('\n') + note;
}

// ---------------------------------------------------------------------------
// Usage (§7.4): what people actually use
// ---------------------------------------------------------------------------

// The math lives in pure functions below, and the fetches are a thin shell over them. That is deliberate:
// an aggregate that is wrong looks exactly like a healthy product, so the arithmetic has to be assertable
// against hand-computed fixtures without a database in the way (Addendum A6 item 10).

/** The one funnel that matters, and most of it happens before a JWT exists (§4.3). */
export const FUNNEL_STEPS: Array<{ key: string; label: string; event: string | null }> = [
  { key: 'landing', label: 'Landed', event: 'door.landing_view' },
  { key: 'gate', label: 'Passed the code gate', event: 'door.gate_pass' },
  { key: 'start', label: 'Tapped START', event: 'door.start_tap' },
  { key: 'auth', label: 'Signed in', event: 'door.auth_ok' },
  { key: 'onboard', label: 'Onboarded', event: 'door.onboard_done' },
  { key: 'play', label: 'First play', event: null }, // from Play, the only step Event cannot answer
];

export const TRADING_GAMES = ['lucky', 'range', 'moonshot'] as const;

export interface FunnelStepRow {
  key: string;
  label: string;
  subjects: number;
  dropPct: number;
  /** Nobody reached this step at all, which usually means it is not active (the code gate is off). */
  skipped: boolean;
}

export interface UsageEventRow {
  name: string;
  anonId?: string | null;
  userId?: string | null;
  props?: unknown;
}

// One person, whether or not they had a session at the time. The client sends the same anonId before and
// after login, so the pre-auth funnel joins to the user at QUERY time with no backfill write.
function subjectKey(row: { anonId?: string | null; userId?: string | null }): string | null {
  if (row.anonId) return row.anonId;
  return row.userId ? `u:${row.userId}` : null;
}

// Sequential subset, not per-step totals: step N counts only subjects who also cleared every step before it.
// Totals would let someone who arrived already signed in inflate a later step and produce a NEGATIVE
// drop-off, which is the sort of number that gets believed.
export function computeFunnel(events: UsageEventRow[], playUserIds: string[]): FunnelStepRow[] {
  const byStep = new Map<string, Set<string>>();
  const anonByUser = new Map<string, string>();

  for (const e of events) {
    if (e.anonId && e.userId) anonByUser.set(e.userId, e.anonId);
    const key = subjectKey(e);
    if (!key) continue;
    let set = byStep.get(e.name);
    if (!set) byStep.set(e.name, (set = new Set()));
    set.add(key);
  }

  const playKeys = new Set(playUserIds.map((id) => anonByUser.get(id) ?? `u:${id}`));

  const rows: FunnelStepRow[] = [];
  let cohort: Set<string> | null = null;
  let lastCounted = 0;

  for (const step of FUNNEL_STEPS) {
    const observed = step.event ? (byStep.get(step.event) ?? new Set<string>()) : playKeys;

    // A step nobody reached is pass-through, not a cliff. Reporting 100% drop-off for a feature that is
    // switched off (the access gate) would be a confident lie about where users leave.
    if (!observed.size) {
      rows.push({ key: step.key, label: step.label, subjects: cohort?.size ?? 0, dropPct: 0, skipped: true });
      continue;
    }

    const carried: string[] = cohort === null ? [...observed] : [...cohort].filter((k) => observed.has(k));
    cohort = new Set(carried);
    const dropPct = lastCounted ? round1(((lastCounted - cohort.size) / lastCounted) * 100) : 0;
    rows.push({ key: step.key, label: step.label, subjects: cohort.size, dropPct, skipped: false });
    lastCounted = cohort.size;
  }

  return rows;
}

export interface GameConversionRow {
  game: string;
  opens: number;
  plays: number;
  conversionPct: number;
}

// Opens vs play taps per game. The interesting number is not the volume, it is which game people open and
// then walk away from.
export function computeGameConversion(events: UsageEventRow[]): GameConversionRow[] {
  const opens = new Map<string, number>();
  const plays = new Map<string, number>();

  for (const e of events) {
    const game = propString(e.props, 'game');
    if (!game) continue;
    const bucket = e.name === 'game.open' ? opens : e.name === 'game.play_tap' ? plays : null;
    if (bucket) bucket.set(game, (bucket.get(game) ?? 0) + 1);
  }

  const games = [...new Set([...TRADING_GAMES, ...opens.keys(), ...plays.keys()])];
  return games
    .map((game) => {
      const o = opens.get(game) ?? 0;
      const p = plays.get(game) ?? 0;
      return { game, opens: o, plays: p, conversionPct: o ? round1((p / o) * 100) : 0 };
    })
    .sort((a, b) => b.opens - a.opens);
}

/** Menu sections ranked, which is the same question as the ascending event list at a finer grain. */
export function computeMenuSections(events: UsageEventRow[]): Array<{ section: string; count: number }> {
  const tally = new Map<string, number>();
  for (const e of events) {
    const section = propString(e.props, 'section');
    if (section) tally.set(section, (tally.get(section) ?? 0) + 1);
  }
  return [...tally.entries()].map(([section, count]) => ({ section, count })).sort((a, b) => b.count - a.count || a.section.localeCompare(b.section));
}

export interface CohortRow {
  date: string;
  signups: number;
  d1: number;
  d7: number;
  d1Pct: number;
  d7Pct: number;
}

// D1/D7 off tracked activity: a user counts as retained on day N if they fired any event in that 24h
// window, measured from the START OF THEIR SIGNUP DAY so every cohort member shares one clock.
export function computeCohorts(
  users: Array<{ id: string; createdAt: Date }>,
  activity: Array<{ userId: string | null; ts: Date }>
): CohortRow[] {
  const active = new Map<string, Date[]>();
  for (const a of activity) {
    if (!a.userId) continue;
    const list = active.get(a.userId);
    if (list) list.push(a.ts);
    else active.set(a.userId, [a.ts]);
  }

  const cohorts = new Map<string, { signups: number; d1: number; d7: number }>();
  for (const user of users) {
    const day = dayStart(user.createdAt);
    const key = isoDay(user.createdAt);
    const row = cohorts.get(key) ?? { signups: 0, d1: 0, d7: 0 };
    row.signups += 1;
    const stamps = active.get(user.id) ?? [];
    if (stamps.some((t) => inWindow(t, day + DAY_MS))) row.d1 += 1;
    if (stamps.some((t) => inWindow(t, day + 7 * DAY_MS))) row.d7 += 1;
    cohorts.set(key, row);
  }

  return [...cohorts.entries()]
    .map(([date, r]) => ({ date, ...r, d1Pct: pct(r.d1, r.signups), d7Pct: pct(r.d7, r.signups) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function inWindow(at: Date, from: number): boolean {
  const t = at.getTime();
  return t >= from && t < from + DAY_MS;
}

function dayStart(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function pct(n: number, of: number): number {
  return of ? round1((n / of) * 100) : 0;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function propString(props: unknown, key: string): string | null {
  if (!props || typeof props !== 'object') return null;
  const value = (props as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

export interface UsageReport {
  windowDays: number;
  events: Array<{ name: string; count: number }>;
  funnel: FunnelStepRow[];
  games: GameConversionRow[];
  menu: Array<{ section: string; count: number }>;
  cohorts: CohortRow[];
  totalEvents: number;
}

// Every name in the catalog appears, zero-count ones included, because a feature with NO events is the most
// rarely used thing we have and it belongs at the very top of an ascending list. Without it the list only
// ranks what is already working.
export async function usageReport(windowDays: number): Promise<UsageReport> {
  const since = new Date(Date.now() - windowDays * DAY_MS);
  const funnelNames = FUNNEL_STEPS.map((s) => s.event).filter((n): n is string => !!n);

  const [grouped, funnelEvents, gameEvents, menuEvents, plays, users, activity] = await Promise.all([
    prismaQuery.event.groupBy({ by: ['name'], where: { ts: { gte: since } }, _count: { _all: true } }),
    prismaQuery.event.findMany({ where: { name: { in: funnelNames }, ts: { gte: since } }, select: { name: true, anonId: true, userId: true } }),
    prismaQuery.event.findMany({ where: { name: { in: ['game.open', 'game.play_tap'] }, ts: { gte: since } }, select: { name: true, props: true } }),
    prismaQuery.event.findMany({ where: { name: 'menu.section', ts: { gte: since } }, select: { name: true, props: true } }),
    prismaQuery.play.findMany({ where: { createdAt: { gte: since } }, select: { userId: true }, distinct: ['userId'] }),
    prismaQuery.user.findMany({ where: { createdAt: { gte: since } }, select: { id: true, createdAt: true } }),
    prismaQuery.event.findMany({ where: { ts: { gte: since }, userId: { not: null } }, select: { userId: true, ts: true } }),
  ]);

  const counts = new Map(grouped.map((g) => [g.name, g._count._all]));
  const events: Array<{ name: string; count: number }> = EVENT_NAMES.map((name) => ({ name: name as string, count: counts.get(name) ?? 0 }));
  // Anything counted but no longer in the catalog still shows, so a removed event does not vanish silently.
  for (const [name, count] of counts) if (!events.some((e) => e.name === name)) events.push({ name, count });
  events.sort((a, b) => a.count - b.count || a.name.localeCompare(b.name));

  return {
    windowDays,
    events,
    funnel: computeFunnel(funnelEvents, plays.map((p) => p.userId)),
    games: computeGameConversion(gameEvents),
    menu: computeMenuSections(menuEvents),
    cohorts: computeCohorts(users, activity),
    totalEvents: [...counts.values()].reduce((a, b) => a + b, 0),
  };
}
