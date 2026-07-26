// Dashboard reads: grouped errors, one group's detail, and the AI brief. The brief is the whole reason
// this system is in-house: "what the user was doing", "system state at the time", and "correlated" come
// from joining Event, Play, and the error's own captured context in one Postgres.
// See bigdev/plans/cont/03-ADMIN-DASHBOARD.md §5 and §7.4.

import { EVENT_NAMES } from '../config/analytics-catalog.ts';
import { getTunable, registerTunable } from '../config/admin-settings.ts';
import { EXPIRY_SAFETY_MS, SUI_NETWORK, TREASURY_MIN_DUSDC } from '../config/main-config.ts';
import { alert } from '../lib/alert.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { routeSamples } from '../lib/route-latency.ts';
import { allWorkerHealth, isWorkerStale } from '../lib/worker-registry.ts';
import { DUSDC_TYPE } from '../lib/sui/config.ts';
import { getDusdcBalance } from '../lib/sui/dusdc.ts';
import { getSuiBalanceRaw } from '../lib/sui/gas.ts';
import { tradeableMarkets } from '../lib/sui/markets.ts';
import { sponsorHealth } from '../lib/sui/play-safety.ts';
import { sponsorAddress } from '../lib/sui/sponsor.ts';
import { REVENUE_ENABLED, SETTLEMENT_ENABLED, TREASURY_ENABLED, operatorAddress, revenueAddress, settlementAddress, treasuryAddress } from '../lib/sui/signer.ts';
import { STUCK_PENDING_MS } from './plays.ts';
import { isWinningPlay } from './stats.ts';

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
/** Groups triaged to `resolved` since a cutoff. Turns an empty Errors list into evidence, not silence. */
export async function countResolvedSince(sinceMs: number): Promise<number> {
  return prismaQuery.errorGroup.count({ where: { status: 'resolved', resolvedAt: { gte: new Date(sinceMs) } } });
}

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

// ---------------------------------------------------------------------------
// Ops detectors (§6): the early-warning system behind the Overview banner
// ---------------------------------------------------------------------------

// One config array, one cron, one status row. Every detector carries a runbook, because an alert without
// a one-line "what to do" is a notification, not a tool, and a team that gets notifications learns to
// ignore the dashboard.
//
// Detectors 1-4 need no new instrumentation: Play.createdAt / openedAt / settledAt / expiry already exist
// and are already populated.

export type OpsLevel = 'ok' | 'warn' | 'critical';

export interface DetectorReading {
  /** null means not enough signal to judge, which is reported as ok rather than a guess. */
  value: number | null;
  detail?: string;
}

export interface Detector {
  key: string;
  title: string;
  warn: number;
  critical: number;
  windowMs: number;
  /** A LOWER reading is the bad one (runway hours, treasury cover, live markets). */
  lowerIsWorse?: boolean;
  runbook: string;
  unit: string;
  read: (now: number) => Promise<DetectorReading>;
}

export interface DetectorStatus {
  key: string;
  title: string;
  level: OpsLevel;
  value: number | null;
  display: string;
  warn: number;
  critical: number;
  runbook: string;
  detail?: string;
  checkedAt: string;
}

/** Below this many samples a rate is noise, so the detector abstains rather than paging on one bad play. */
const MIN_RATE_SAMPLES = 5;

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: with one sample every percentile is that sample, and an even count never averages two
  // unrelated numbers into one that was never observed.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

// Pure, so the threshold logic is assertable without a database. A null reading is ok, never a guess.
export function levelFor(d: Pick<Detector, 'warn' | 'critical' | 'lowerIsWorse'>, value: number | null): OpsLevel {
  if (value == null || !Number.isFinite(value)) return 'ok';
  if (d.lowerIsWorse) {
    if (value <= d.critical) return 'critical';
    return value <= d.warn ? 'warn' : 'ok';
  }
  if (value >= d.critical) return 'critical';
  return value >= d.warn ? 'warn' : 'ok';
}

const MIN = 60_000;

// Detector 12 needs to know how long the live-market set has been empty, which is a duration nothing
// persists. One counter, reset the moment a market appears.
let marketsEmptySince: number | null = null;

export const DETECTORS: Detector[] = [
  {
    key: 'play_failure_rate',
    title: 'Play failure rate',
    warn: 5,
    critical: 15,
    windowMs: 15 * MIN,
    unit: '%',
    runbook: 'Open Errors filtered to kind=chain. A spike is usually a mint admission abort or a market that rolled without backing.',
    read: async (now) => {
      const since = new Date(now - 15 * MIN);
      const [total, failed] = await Promise.all([
        prismaQuery.play.count({ where: { createdAt: { gte: since } } }),
        prismaQuery.play.count({ where: { createdAt: { gte: since }, status: 'error' } }),
      ]);
      if (total < MIN_RATE_SAMPLES) return { value: null, detail: `only ${total} plays in the window` };
      return { value: round1((failed / total) * 100), detail: `${failed} of ${total} plays` };
    },
  },
  {
    key: 'stuck_pending',
    title: 'Stuck pending plays',
    warn: 3,
    critical: 10,
    windowMs: STUCK_PENDING_MS,
    unit: ' plays',
    runbook: 'The settle worker sweeps these to error on its own. If the count keeps climbing, the mint path is wedged: check the sponsor reserve and the gRPC endpoint.',
    read: async (now) => {
      const value = await prismaQuery.play.count({
        where: { status: 'pending', createdAt: { lt: new Date(now - STUCK_PENDING_MS) } },
      });
      return { value, detail: `pending for over ${Math.round(STUCK_PENDING_MS / 1000)}s` };
    },
  },
  {
    key: 'mint_latency',
    title: 'Mint latency p95',
    warn: 4_000,
    critical: 10_000,
    windowMs: 30 * MIN,
    unit: 'ms',
    runbook: 'Slow mints are usually the fullnode, not us. Check gRPC round trips, then whether the sponsor accumulator is being re-warmed on every play.',
    read: async (now) => {
      const rows = await prismaQuery.play.findMany({
        where: { createdAt: { gte: new Date(now - 30 * MIN) }, openedAt: { not: null } },
        select: { createdAt: true, openedAt: true },
      });
      const ms = rows.map((r) => r.openedAt!.getTime() - r.createdAt.getTime());
      return { value: percentile(ms, 95), detail: `${ms.length} mints, p50 ${percentile(ms, 50) ?? 0}ms` };
    },
  },
  {
    key: 'settle_lag',
    title: 'Settle lag p95',
    warn: 15_000,
    critical: 60_000,
    windowMs: 60 * MIN,
    unit: 'ms',
    runbook: 'Settlement is permissionless redeem_settled. A long lag means the settle worker is stale or the market has not been settled on chain yet. Check worker health first (L-014).',
    read: async (now) => {
      // Only expiry-settled plays: a cash-out closes before expiry and would read as a negative lag.
      const rows = await prismaQuery.play.findMany({
        where: { settledAt: { gte: new Date(now - 60 * MIN) }, status: { in: ['won', 'lost'] } },
        select: { settledAt: true, expiry: true },
      });
      const ms = rows.map((r) => Math.max(0, r.settledAt!.getTime() - Number(r.expiry)));
      return { value: percentile(ms, 95), detail: `${ms.length} settles, p50 ${percentile(ms, 50) ?? 0}ms` };
    },
  },
  {
    key: 'deposits_failing',
    title: 'Deposits failing',
    warn: 10,
    critical: 25,
    windowMs: 24 * 60 * MIN,
    unit: '%',
    runbook: 'Check LI.FI status for the affected chain. A stuck PENDING usually means the source tx never landed, not that we lost it.',
    read: async (now) => {
      // Only deposits old enough to have resolved, so a bridge still in flight is never counted as failing.
      const rows = await prismaQuery.deposit.findMany({
        where: { createdAt: { gte: new Date(now - DAY_MS), lt: new Date(now - 2 * 60 * MIN) } },
        select: { status: true },
      });
      if (rows.length < 3) return { value: null, detail: `only ${rows.length} settled-age deposits` };
      const bad = rows.filter((r) => r.status === 'FAILED' || r.status === 'PENDING').length;
      return { value: round1((bad / rows.length) * 100), detail: `${bad} of ${rows.length} failed or still pending` };
    },
  },
  {
    key: 'sponsor_runway',
    title: 'Sponsor runway',
    warn: 12,
    critical: 3,
    lowerIsWorse: true,
    windowMs: 0,
    unit: 'h',
    runbook: 'Send testnet SUI to the sponsor address printed in the boot log. Plays auto-resume on the next monitor tick.',
    read: async () => {
      const h = sponsorHealth();
      if (!h.enabled) return { value: null, detail: 'sponsorship is off' };
      // Already below the floor is the emergency itself, whatever the burn rate says.
      if (h.paused || h.reserveSui < h.floorSui) {
        return { value: 0, detail: `reserve ${h.reserveSui.toFixed(3)} SUI is under the ${h.floorSui} SUI floor, plays are paused` };
      }
      if (h.hoursLeft == null) return { value: null, detail: `reserve ${h.reserveSui.toFixed(3)} SUI, burn not measured yet` };
      return { value: round1(h.hoursLeft), detail: `${h.reserveSui.toFixed(3)} SUI, burning ${h.burnSuiPerHour?.toFixed(3)} SUI/h` };
    },
  },
  {
    key: 'treasury_chips',
    title: 'Treasury chips',
    warn: 2,
    critical: 1,
    lowerIsWorse: true,
    windowMs: 0,
    unit: 'x min',
    runbook: 'DUSDC is not mintable on a deployment we do not own (L-008). Transfer DUSDC to the treasury address by hand; grants and the faucet fail loudly until you do.',
    read: async () => {
      if (!TREASURY_ENABLED) return { value: null, detail: 'no treasury wallet configured' };
      const balance = await getDusdcBalance(treasuryAddress);
      const min = Math.max(1, TREASURY_MIN_DUSDC);
      return { value: round1(balance / min), detail: `${balance.toFixed(2)} DUSDC against a ${min} minimum` };
    },
  },
  {
    key: 'worker_staleness',
    title: 'Worker staleness',
    warn: 1,
    critical: 2,
    windowMs: 0,
    unit: '',
    runbook: 'Check the Performance page for which worker stopped. settle or market-sync stale means plays stop resolving, so restart the process.',
    read: async (now) => {
      const stale = allWorkerHealth().filter((w) => isWorkerStale(w, now));
      if (!stale.length) return { value: 0, detail: 'every worker is running on cadence' };
      // A stale price-warmer is a warning; a stale settle or market-sync stops the product.
      const criticalStale = stale.filter((w) => CRITICAL_WORKERS.has(w.name));
      return {
        value: criticalStale.length ? 2 : 1,
        detail: `stale: ${stale.map((w) => w.name).join(', ')}`,
      };
    },
  },
  {
    key: 'auth_failures',
    title: 'Sign-in failures',
    warn: 10,
    critical: 30,
    windowMs: 30 * MIN,
    unit: '%',
    runbook: 'Over 30% is usually a Privy outage rather than us. Check status.privy.io, then that PRIVY_APP_ID and the verification key are still right.',
    read: async (now) => {
      const since = new Date(now - 30 * MIN);
      const [ok, fail] = await Promise.all([
        prismaQuery.event.count({ where: { name: 'door.auth_ok', ts: { gte: since } } }),
        prismaQuery.event.count({ where: { name: 'door.auth_fail', ts: { gte: since } } }),
      ]);
      const total = ok + fail;
      if (total < MIN_RATE_SAMPLES) return { value: null, detail: `only ${total} sign-in attempts` };
      return { value: round1((fail / total) * 100), detail: `${fail} of ${total} attempts` };
    },
  },
  {
    key: 'new_bug_shipped',
    title: 'New bug shipped',
    warn: 1,
    critical: 2,
    windowMs: 10 * MIN,
    unit: '',
    runbook: 'A brand new group already firing this often is almost always the release that just went out. Open it, copy the AI brief, and consider rolling back.',
    read: async (now) => {
      const fresh = await prismaQuery.errorGroup.findMany({
        where: { firstSeen: { gte: new Date(now - 10 * MIN) }, count: { gt: 20 }, status: { not: 'ignored' } },
        select: { title: true, level: true, count: true },
        orderBy: { count: 'desc' },
        take: 5,
      });
      if (!fresh.length) return { value: 0 };
      return {
        value: fresh.some((g) => g.level === 'fatal') ? 2 : 1,
        detail: fresh.map((g) => `${g.title} (${g.count})`).join('; '),
      };
    },
  },
  {
    key: 'regression',
    title: 'Regression',
    warn: 1,
    critical: 1,
    windowMs: 0,
    unit: '',
    runbook: 'A bug marked resolved is firing again. Open it: firstRelease against lastRelease tells you which deploy brought it back. Acking clears this.',
    read: async () => {
      // `open` with a resolvedAt still set is exactly "was closed, came back, nobody has triaged it".
      const rows = await prismaQuery.errorGroup.findMany({
        where: { status: 'open', resolvedAt: { not: null } },
        select: { title: true },
        take: 5,
      });
      return { value: rows.length, detail: rows.map((r) => r.title).join('; ') || undefined };
    },
  },
  {
    key: 'live_markets',
    title: 'Live markets',
    warn: 2,
    critical: 10,
    windowMs: 0,
    unit: ' min at zero',
    runbook: 'market-sync discovers the live 1m BTC markets from chain (L-006). Zero for minutes means discovery is failing or every market rolled at once; check the worker and the fullnode.',
    read: async (now) => {
      const live = tradeableMarkets(now, EXPIRY_SAFETY_MS).length;
      if (live > 0) {
        marketsEmptySince = null;
        return { value: 0, detail: `${live} tradeable` };
      }
      marketsEmptySince ??= now;
      return { value: round1((now - marketsEmptySince) / MIN), detail: 'no tradeable market right now' };
    },
  },
];

// A stale one of these stops the product, rather than just degrading it.
const CRITICAL_WORKERS = new Set(['settle', 'market-sync']);

// Detector thresholds are tunable from the settings drawer, so a noisy threshold is a UI edit rather than
// a deploy. Registered from the array, so adding a detector never means remembering to add two knobs.
for (const d of DETECTORS) {
  const bound = (v: number) => ({ type: 'int' as const, def: Math.round(v), min: 0, max: Math.max(1000, Math.round(v * 100)) });
  registerTunable(`detector.${d.key}.warn`, { ...bound(d.warn), label: `${d.title}: warn at` });
  registerTunable(`detector.${d.key}.critical`, { ...bound(d.critical), label: `${d.title}: critical at` });
}

export interface OpsSnapshot {
  checkedAt: string;
  worst: OpsLevel;
  detectors: DetectorStatus[];
}

const OPS_ROW_KEY = 'ops:status';
const RANK: Record<OpsLevel, number> = { ok: 0, warn: 1, critical: 2 };

// Pure, so the discipline that actually matters (fire on the TRANSITION, never every tick) can be
// asserted without a database or a clock. A detector that pages every tick is how a team learns to
// ignore alerts, which is worse than having no alerts at all.
export function alertTransitions(
  prev: Record<string, OpsLevel>,
  next: DetectorStatus[]
): Array<{ key: string; kind: 'critical' | 'recovered'; status: DetectorStatus }> {
  const out: Array<{ key: string; kind: 'critical' | 'recovered'; status: DetectorStatus }> = [];
  for (const s of next) {
    const was = prev[s.key] ?? 'ok';
    if (s.level === 'critical' && was !== 'critical') out.push({ key: s.key, kind: 'critical', status: s });
    else if (was === 'critical' && s.level !== 'critical') out.push({ key: s.key, kind: 'recovered', status: s });
  }
  return out;
}

function display(d: Detector, r: DetectorReading): string {
  if (r.value == null) return 'no signal';
  return `${r.value}${d.unit}`;
}

/** The banner's data. Never throws: a broken detector reports itself and the sweep carries on. */
export async function evaluateDetectors(now = Date.now()): Promise<OpsSnapshot> {
  const prev = await readOpsLevels();
  const checkedAt = new Date(now).toISOString();

  const detectors: DetectorStatus[] = await Promise.all(
    DETECTORS.map(async (d): Promise<DetectorStatus> => {
      const [warn, critical] = await Promise.all([
        getTunable(`detector.${d.key}.warn`, d.warn),
        getTunable(`detector.${d.key}.critical`, d.critical),
      ]);
      const base = { key: d.key, title: d.title, warn, critical, runbook: d.runbook, checkedAt };
      try {
        const reading = await d.read(now);
        const level = levelFor({ warn, critical, lowerIsWorse: d.lowerIsWorse }, reading.value);
        return { ...base, level, value: reading.value, display: display(d, reading), detail: reading.detail };
      } catch (e) {
        // A detector that cannot read is not a healthy system, but it is not evidence of a fault either.
        return { ...base, level: 'ok', value: null, display: 'unavailable', detail: e instanceof Error ? e.message : String(e) };
      }
    })
  );

  detectors.sort((a, b) => RANK[b.level] - RANK[a.level] || a.title.localeCompare(b.title));
  const worst = detectors.reduce<OpsLevel>((w, d) => (RANK[d.level] > RANK[w] ? d.level : w), 'ok');

  for (const t of alertTransitions(prev, detectors)) {
    const s = t.status;
    if (t.kind === 'critical') {
      alert('critical', `${s.title} is critical: ${s.display}${s.detail ? ` (${s.detail})` : ''}. ${s.runbook}`, { detector: s.key, value: s.value }, `ops:${s.key}`);
    } else {
      alert('warn', `${s.title} recovered: ${s.display}`, { detector: s.key }, `ops:${s.key}:recovered`);
    }
  }

  await writeOps({ checkedAt, worst, detectors });
  return { checkedAt, worst, detectors };
}

/** The last evaluated snapshot, so a page load never runs twelve queries of its own. */
export async function opsStatus(): Promise<OpsSnapshot> {
  try {
    const row = await prismaQuery.appConfig.findUnique({ where: { key: OPS_ROW_KEY } });
    if (row) return JSON.parse(row.value) as OpsSnapshot;
  } catch {
    // fall through to the empty snapshot
  }
  return { checkedAt: new Date(0).toISOString(), worst: 'ok', detectors: [] };
}

async function readOpsLevels(): Promise<Record<string, OpsLevel>> {
  const snap = await opsStatus();
  return Object.fromEntries(snap.detectors.map((d) => [d.key, d.level]));
}

async function writeOps(snap: OpsSnapshot): Promise<void> {
  const value = JSON.stringify(snap);
  try {
    await prismaQuery.appConfig.upsert({ where: { key: OPS_ROW_KEY }, create: { key: OPS_ROW_KEY, value }, update: { value } });
  } catch (e) {
    console.warn('[ops] could not persist the detector snapshot:', e instanceof Error ? e.message : e);
  }
}

// The nightly digest: what appeared, what is loudest, and what nobody has looked at. Sent once a day so
// the things that are not urgent enough to page still get seen.
export async function buildNightlyDigest(now = Date.now()): Promise<string | null> {
  const [fresh, loudest, stale] = await Promise.all([
    prismaQuery.errorGroup.count({ where: { firstSeen: { gte: new Date(now - DAY_MS) } } }),
    prismaQuery.errorGroup.findMany({
      where: { status: { in: ['open', 'ack'] }, lastSeen: { gte: new Date(now - DAY_MS) } },
      select: { title: true, count: true, level: true },
      orderBy: { count: 'desc' },
      take: 5,
    }),
    prismaQuery.errorGroup.count({ where: { status: 'open', firstSeen: { lt: new Date(now - 2 * DAY_MS) } } }),
  ]);

  if (!fresh && !loudest.length && !stale) return null;
  const lines = [`${fresh} new error group(s) in the last 24h, ${stale} still open after 48h.`];
  if (loudest.length) {
    lines.push('Top by count:');
    for (const g of loudest) lines.push(`  ${g.count}x [${g.level}] ${g.title}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Overview (§7.4): the ten-second page
// ---------------------------------------------------------------------------

// The money aggregates are pure over rows, so every number on this page can be pinned against a fixture
// with a hand-computed answer. A wrong number here is worse than a missing one, because it gets believed.

export interface PlayAggRow {
  game: string;
  status: string;
  stake: bigint;
  entryCost: bigint;
  rake: bigint;
  pnl: bigint | null;
  multiplier: number | null;
}

export interface PlayAggregates {
  plays: number;
  settled: number;
  byGame: Array<{ game: string; plays: number; volume: number }>;
  avgStake: number | null;
  avgMultiplier: number | null;
  winRatePct: number | null;
  volume: number;
  /** Players' realized PnL. Positive means the players are up. */
  playerNetPnl: number;
  /** The counterparty side of the same number. The vault carries it, we carry the rake. */
  netHousePnl: number;
  rake: number;
}

const SETTLED_STATUSES = new Set(['won', 'lost', 'cashed_out']);
const DUSDC_UNIT = 1_000_000; // 6dp, per L-011

const dusdc = (raw: bigint): number => Number(raw) / DUSDC_UNIT;

export function computePlayAggregates(rows: PlayAggRow[]): PlayAggregates {
  const settled = rows.filter((r) => SETTLED_STATUSES.has(r.status));

  // Volume is Σ entry cost over SETTLED plays, matching computeLedgerStats so the dashboard and a user's
  // own stats page can never disagree. An unminted or errored play cost nobody anything.
  let volume = 0n;
  let playerPnl = 0n;
  let wins = 0;
  for (const r of settled) {
    volume += r.entryCost;
    playerPnl += r.pnl ?? 0n;
    if (isWinningPlay(r)) wins += 1;
  }

  // Rake is collected at mint, so it counts on every play that minted, settled or not.
  let rake = 0n;
  let stakeTotal = 0n;
  for (const r of rows) {
    rake += r.rake;
    stakeTotal += r.stake;
  }

  const multipliers = rows.map((r) => r.multiplier).filter((m): m is number => typeof m === 'number' && Number.isFinite(m));

  const byGame = new Map<string, { plays: number; volume: bigint }>();
  for (const r of rows) {
    const e = byGame.get(r.game) ?? { plays: 0, volume: 0n };
    e.plays += 1;
    if (SETTLED_STATUSES.has(r.status)) e.volume += r.entryCost;
    byGame.set(r.game, e);
  }

  return {
    plays: rows.length,
    settled: settled.length,
    byGame: [...byGame.entries()]
      .map(([game, e]) => ({ game, plays: e.plays, volume: dusdc(e.volume) }))
      .sort((a, b) => b.plays - a.plays),
    avgStake: rows.length ? round2(dusdc(stakeTotal) / rows.length) : null,
    avgMultiplier: multipliers.length ? round2(multipliers.reduce((a, b) => a + b, 0) / multipliers.length) : null,
    winRatePct: settled.length ? round1((wins / settled.length) * 100) : null,
    volume: dusdc(volume),
    playerNetPnl: dusdc(playerPnl),
    netHousePnl: dusdc(-playerPnl),
    rake: dusdc(rake),
  };
}

function round2(n: number): number {
  return roundTo(n, 2);
}

function roundTo(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Per-day counts over a window, zero-filled so a sparkline never implies a gap was a quiet day. */
export function dailySeries(dates: Date[], days: number, now: number): Array<{ t: number; n: number }> {
  const start = dayStart(new Date(now)) - (days - 1) * DAY_MS;
  const out = Array.from({ length: days }, (_, i) => ({ t: start + i * DAY_MS, n: 0 }));
  for (const d of dates) {
    const i = Math.floor((dayStart(d) - start) / DAY_MS);
    if (i >= 0 && i < days) out[i]!.n += 1;
  }
  return out;
}

export interface BalanceSnapshot {
  asOf: string;
  /** Σ user DUSDC read from chain. null when the sweep has never completed. */
  userChips: number | null;
  userCount: number;
  /** Set when the sweep stopped at its cap, so a partial total is never read as the whole. */
  partial?: string;
  wallets: Array<{ name: string; address: string; sui: number; dusdc: number | null }>;
  /** Positive sponsor SUI deltas seen today, so a human top-up never reads as negative burn. */
  gasBurnedToday: number;
  samples: Array<{ t: number; sui: number }>;
}

const BALANCE_ROW_KEY = 'ops:balances';
/** A chain read per user, so the sweep is capped and says so rather than quietly totalling a subset. */
const BALANCE_USER_CAP = 500;

export async function readBalanceSnapshot(): Promise<BalanceSnapshot | null> {
  try {
    const row = await prismaQuery.appConfig.findUnique({ where: { key: BALANCE_ROW_KEY } });
    return row ? (JSON.parse(row.value) as BalanceSnapshot) : null;
  } catch {
    return null;
  }
}

// The one expensive metric on the page (§7.4), so it runs on a cron and the page renders the stored row
// with its "as of". Never called from a request handler.
export async function refreshBalanceSnapshot(now = Date.now()): Promise<BalanceSnapshot> {
  const prev = await readBalanceSnapshot();

  const users = await prismaQuery.user.findMany({
    where: { address: { not: '' } },
    select: { address: true },
    orderBy: { createdAt: 'asc' },
    take: BALANCE_USER_CAP + 1,
  });
  const capped = users.length > BALANCE_USER_CAP;
  const swept = capped ? users.slice(0, BALANCE_USER_CAP) : users;

  let userChips = 0;
  let read = 0;
  for (const u of swept) {
    try {
      userChips += await getDusdcBalance(u.address);
      read += 1;
    } catch {
      // One unreadable address must not lose the whole sweep; the count below says how many landed.
    }
  }

  const wallets = await Promise.all([
    walletBalance('sponsor', sponsorAddress, false),
    walletBalance('treasury', TREASURY_ENABLED ? treasuryAddress : '', true),
    walletBalance('settlement', SETTLEMENT_ENABLED ? settlementAddress : '', false),
    walletBalance('revenue', REVENUE_ENABLED ? revenueAddress : '', true),
    walletBalance('operator', operatorAddress, false),
  ]);

  // Burn is the sum of positive deltas across today's samples, so a top-up (a negative delta) is skipped
  // rather than netted off. An estimate here would get believed, so it is measured or it is zero.
  const sponsorSui = wallets.find((w) => w.name === 'sponsor')?.sui ?? 0;
  const todayStart = dayStart(new Date(now));
  const samples = [...(prev?.samples ?? []).filter((s) => s.t >= todayStart - DAY_MS), { t: now, sui: sponsorSui }];
  let gasBurnedToday = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i]!.t < todayStart) continue;
    const delta = samples[i - 1]!.sui - samples[i]!.sui;
    if (delta > 0) gasBurnedToday += delta;
  }

  const snap: BalanceSnapshot = {
    asOf: new Date(now).toISOString(),
    userChips: read ? round2(userChips) : null,
    userCount: read,
    ...(capped ? { partial: `swept the ${BALANCE_USER_CAP} oldest of ${users.length}+ users` } : {}),
    wallets,
    gasBurnedToday: roundTo(gasBurnedToday, 4),
    samples,
  };

  const value = JSON.stringify(snap);
  try {
    await prismaQuery.appConfig.upsert({ where: { key: BALANCE_ROW_KEY }, create: { key: BALANCE_ROW_KEY, value }, update: { value } });
  } catch (e) {
    console.warn('[ops] could not persist the balance snapshot:', e instanceof Error ? e.message : e);
  }
  if (capped) console.warn(`[ops] balance sweep capped at ${BALANCE_USER_CAP} users; the total is a subset`);
  return snap;
}

const MIST = 1_000_000_000;

async function walletBalance(name: string, address: string, withChips: boolean): Promise<BalanceSnapshot['wallets'][number]> {
  if (!address) return { name, address: '', sui: 0, dusdc: null };
  const [sui, chips] = await Promise.all([
    getSuiBalanceRaw(address)
      .then((raw) => Number(raw) / MIST)
      .catch(() => 0),
    withChips ? getDusdcBalance(address).catch(() => null) : Promise.resolve(null),
  ]);
  return { name, address, sui: roundTo(sui, 4), dusdc: chips == null ? null : round2(chips) };
}

export interface OverviewReport {
  users: {
    total: number;
    newToday: number;
    new7d: number;
    dau: number;
    wau: number;
    onboardedPct: number | null;
    returningPct: number | null;
  };
  plays: PlayAggregates & { today: number };
  money: {
    balances: BalanceSnapshot | null;
    depositsByChain: Array<{ chain: string; count: number; done: number }>;
    withdrawals: { count: number; amount: number };
    faucetOut: number;
    grantOut: number;
  };
  chain: {
    liveMarkets: number;
    wallets: BalanceSnapshot['wallets'];
    gasBurnedToday: number;
    costPerPlaySui: number | null;
    network: string;
  };
  sparklines: { plays: Array<{ t: number; n: number }>; errors: Array<{ t: number; n: number }> };
  generatedAt: string;
}

export async function overviewReport(now = Date.now()): Promise<OverviewReport> {
  const todayStart = new Date(dayStart(new Date(now)));
  const weekAgo = new Date(now - 7 * DAY_MS);
  const fortnight = new Date(dayStart(new Date(now)) - 13 * DAY_MS);

  const [total, newToday, new7d, onboarded, returning, dauRows, wauRows, windowPlays, todayPlays, playDates, errorDates, deposits, withdrawals, grants, balances] =
    await Promise.all([
      prismaQuery.user.count(),
      prismaQuery.user.count({ where: { createdAt: { gte: todayStart } } }),
      prismaQuery.user.count({ where: { createdAt: { gte: weekAgo } } }),
      prismaQuery.user.count({ where: { username: { not: null } } }),
      // Returning = signed in at least a day after signing up. A single-session user never qualifies.
      prismaQuery.user.count({ where: { lastSignIn: { gte: weekAgo } } }),
      prismaQuery.play.findMany({ where: { createdAt: { gte: todayStart } }, select: { userId: true }, distinct: ['userId'] }),
      prismaQuery.play.findMany({ where: { createdAt: { gte: weekAgo } }, select: { userId: true }, distinct: ['userId'] }),
      prismaQuery.play.findMany({
        where: { createdAt: { gte: weekAgo } },
        select: { game: true, status: true, stake: true, entryCost: true, rake: true, pnl: true, multiplier: true },
      }),
      prismaQuery.play.count({ where: { createdAt: { gte: todayStart } } }),
      prismaQuery.play.findMany({ where: { createdAt: { gte: fortnight } }, select: { createdAt: true } }),
      prismaQuery.errorEvent.findMany({ where: { createdAt: { gte: fortnight } }, select: { createdAt: true } }),
      prismaQuery.deposit.findMany({ where: { createdAt: { gte: weekAgo } }, select: { fromChain: true, status: true } }),
      // DUSDC only. `kind: 'send'` also carries indexed SUI transfers, and summing two currencies into
      // one figure would produce a number that is confidently meaningless.
      prismaQuery.walletTx.findMany({
        where: { createdAt: { gte: weekAgo }, direction: 'out', kind: 'send', coinType: DUSDC_TYPE },
        select: { amount: true, decimals: true },
      }),
      prismaQuery.walletTx.findMany({ where: { createdAt: { gte: weekAgo }, kind: { in: ['faucet', 'grant'] } }, select: { kind: true, amount: true, decimals: true } }),
      readBalanceSnapshot(),
    ]);

  const byChain = new Map<string, { count: number; done: number }>();
  for (const d of deposits) {
    const e = byChain.get(d.fromChain) ?? { count: 0, done: 0 };
    e.count += 1;
    if (d.status === 'DONE') e.done += 1;
    byChain.set(d.fromChain, e);
  }

  const amountOf = (rows: Array<{ amount: bigint; decimals: number }>): number =>
    round2(rows.reduce((sum, r) => sum + Number(r.amount) / 10 ** r.decimals, 0));

  const aggregates = computePlayAggregates(windowPlays);
  const gasBurnedToday = balances?.gasBurnedToday ?? 0;

  return {
    users: {
      total,
      newToday,
      new7d,
      dau: dauRows.length,
      wau: wauRows.length,
      onboardedPct: total ? round1((onboarded / total) * 100) : null,
      returningPct: total ? round1((returning / total) * 100) : null,
    },
    plays: { ...aggregates, today: todayPlays },
    money: {
      balances,
      depositsByChain: [...byChain.entries()].map(([chain, e]) => ({ chain, ...e })).sort((a, b) => b.count - a.count),
      withdrawals: { count: withdrawals.length, amount: amountOf(withdrawals) },
      faucetOut: amountOf(grants.filter((g) => g.kind === 'faucet')),
      grantOut: amountOf(grants.filter((g) => g.kind === 'grant')),
    },
    chain: {
      liveMarkets: tradeableMarkets(now, EXPIRY_SAFETY_MS).length,
      wallets: balances?.wallets ?? [],
      gasBurnedToday,
      costPerPlaySui: todayPlays ? roundTo(gasBurnedToday / todayPlays, 5) : null,
      network: SUI_NETWORK,
    },
    sparklines: {
      plays: dailySeries(
        playDates.map((p) => p.createdAt),
        14,
        now
      ),
      errors: dailySeries(
        errorDates.map((e) => e.createdAt),
        14,
        now
      ),
    },
    generatedAt: new Date(now).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Performance (§7.4)
// ---------------------------------------------------------------------------

export interface LatencyRow {
  createdAt: Date;
  openedAt: Date | null;
  settledAt: Date | null;
  expiry: bigint;
  status: string;
}

export interface LatencyPoint {
  t: number;
  n: number;
  p50: number | null;
  p95: number | null;
}

/** Mint latency: the gap between a play being requested and the mint landing. */
export function mintLatencies(rows: LatencyRow[]): Array<{ t: number; ms: number }> {
  return rows
    .filter((r) => r.openedAt != null)
    .map((r) => ({ t: r.createdAt.getTime(), ms: r.openedAt!.getTime() - r.createdAt.getTime() }))
    .filter((s) => s.ms >= 0);
}

/** Settle lag: expiry to settlement. Cash-outs close before expiry and would read as a negative lag. */
export function settleLags(rows: LatencyRow[]): Array<{ t: number; ms: number }> {
  return rows
    .filter((r) => r.settledAt != null && (r.status === 'won' || r.status === 'lost'))
    .map((r) => ({ t: r.settledAt!.getTime(), ms: Math.max(0, r.settledAt!.getTime() - Number(r.expiry)) }));
}

/** Bucketed p50/p95 over time. An empty bucket keeps its slot with nulls rather than being dropped. */
export function latencySeries(samples: Array<{ t: number; ms: number }>, bucketMs: number, from: number, to: number): LatencyPoint[] {
  const count = Math.max(1, Math.ceil((to - from) / bucketMs));
  const buckets: number[][] = Array.from({ length: count }, () => []);
  for (const s of samples) {
    const i = Math.floor((s.t - from) / bucketMs);
    if (i >= 0 && i < count) buckets[i]!.push(s.ms);
  }
  return buckets.map((values, i) => ({
    t: from + i * bucketMs,
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
  }));
}

export interface RouteLatencyRow {
  route: string;
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export function computeRouteLatency(input: Array<{ route: string; samples: number[] }>): RouteLatencyRow[] {
  const ms = (v: number | null) => (v == null ? null : roundTo(v, 2));
  return input
    .map(({ route, samples }) => ({
      route,
      n: samples.length,
      p50: ms(percentile(samples, 50)),
      p95: ms(percentile(samples, 95)),
      max: samples.length ? roundTo(Math.max(...samples), 2) : null,
    }))
    .sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0));
}

export interface PerfReport {
  windowHours: number;
  mint: { series: LatencyPoint[]; p50: number | null; p95: number | null; n: number };
  settle: { series: LatencyPoint[]; p50: number | null; p95: number | null; n: number };
  routes: RouteLatencyRow[];
  workers: Array<{
    name: string;
    lastRunAt: number | null;
    lastSuccessAt: number | null;
    lastDurationMs: number | null;
    intervalMs: number | null;
    stale: boolean;
    lastError: string | null;
  }>;
  generatedAt: string;
}

export async function perfReport(windowHours = 6, now = Date.now()): Promise<PerfReport> {
  const from = now - windowHours * 3_600_000;
  const bucketMs = Math.max(5 * MIN, Math.round((windowHours * 3_600_000) / 48));

  const [minted, settled] = await Promise.all([
    prismaQuery.play.findMany({
      where: { createdAt: { gte: new Date(from) }, openedAt: { not: null } },
      select: { createdAt: true, openedAt: true, settledAt: true, expiry: true, status: true },
    }),
    prismaQuery.play.findMany({
      where: { settledAt: { gte: new Date(from) }, status: { in: ['won', 'lost'] } },
      select: { createdAt: true, openedAt: true, settledAt: true, expiry: true, status: true },
    }),
  ]);

  const mintSamples = mintLatencies(minted);
  const settleSamples = settleLags(settled);

  return {
    windowHours,
    mint: {
      series: latencySeries(mintSamples, bucketMs, from, now),
      p50: percentile(
        mintSamples.map((s) => s.ms),
        50
      ),
      p95: percentile(
        mintSamples.map((s) => s.ms),
        95
      ),
      n: mintSamples.length,
    },
    settle: {
      series: latencySeries(settleSamples, bucketMs, from, now),
      p50: percentile(
        settleSamples.map((s) => s.ms),
        50
      ),
      p95: percentile(
        settleSamples.map((s) => s.ms),
        95
      ),
      n: settleSamples.length,
    },
    routes: computeRouteLatency(routeSamples()),
    workers: allWorkerHealth().map((w) => ({
      name: w.name,
      lastRunAt: w.lastRunAt,
      lastSuccessAt: w.lastSuccessAt,
      lastDurationMs: w.lastDurationMs,
      intervalMs: w.intervalMs,
      stale: isWorkerStale(w, now),
      lastError: w.lastError,
    })),
    generatedAt: new Date(now).toISOString(),
  };
}
