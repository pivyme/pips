// Error fingerprinting, redaction, payload caps, and the one write path. The whole point is that one bug
// shows up as ONE group: our messages carry play ids, amounts, and object ids, so grouping on message text
// gives 400 issues for one bug (L-021). See bigdev/plans/cont/03-ADMIN-DASHBOARD.md §3.
//
// captureError() is never on the critical path: it returns void, swallows everything, and is never awaited.

import { createHash } from 'node:crypto';

import type { Prisma } from '../../prisma/generated/client.js';
import { RELEASE } from '../config/release.ts';
import { SUI_NETWORK } from '../config/main-config.ts';
import { getSetting } from '../config/admin-settings.ts';
import { isEventName, type EventName } from '../config/analytics-catalog.ts';
import { prismaQuery } from './prisma.ts';
import { grpcErrorText } from './sui/client.ts';

export type ErrorKind = 'http' | 'worker' | 'chain' | 'client' | 'job';
export type ErrorLevel = 'fatal' | 'error' | 'warn';

// ---------------------------------------------------------------------------
// normalize (§3.1)
// ---------------------------------------------------------------------------

// Order matters: hex and ids are stripped before the numeric pass, or 0xdeadbeef and a cuid would be
// half-eaten by the digit rule. Abort codes are short (0-99) so the 3+ digit rule leaves them intact,
// which is what keeps `assert_backing 0` distinguishable from `assert_backing 3`.
export function normalize(message: string): string {
  // 1. percent-decode first: gRPC-web trailers arrive encoded and defeat every matcher (L-021).
  //    grpcErrorText does the decode and lowercases, which is also step 6.
  let s = grpcErrorText(message);
  // 2. hex addresses / object ids / digests
  s = s.replace(/0x[a-f0-9]{6,}/g, '<addr>');
  // 3. cuid + uuid
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>');
  s = s.replace(/\bc[a-z0-9]{20,30}\b/g, '<id>');
  // 4. standalone numbers of 3+ digits (amounts, timestamps, raw balances)
  s = s.replace(/\b\d{3,}\b/g, '<n>');
  // 4b. any number carrying a time unit ("try again in 35s"). Short counts survive step 4 so abort codes
  //     stay distinct, but a countdown in a user-facing message split one cooldown into six groups.
  s = s.replace(/\b\d+(ms|s|m|h|d)\b/g, '<n>$1');
  // 5. quoted strings
  s = s.replace(/"[^"]*"/g, '<str>').replace(/'[^']*'/g, '<str>');
  // 6. collapse whitespace (already lowercased by grpcErrorText)
  return s.replace(/\s+/g, ' ').trim();
}

// First stack frame that is not vendor code. Falls back to the top frame, then to an empty string.
export function topOwnFrame(stack?: string | null): string {
  if (!stack) return '';
  const lines = stack
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('at '));
  if (!lines.length) return '';
  const own = lines.find((l) => !l.includes('node_modules') && !l.includes('node:internal'));
  return trimFrame(own ?? lines[0]!);
}

// "at commitPlay (/abs/path/backend/src/services/plays.ts:235:11)" -> "src/services/plays.ts:235 commitPlay"
//
// The leading `.*` is GREEDY on purpose, so it backtracks to the LAST src/ or scripts/ segment. The
// container runs out of /src/app, and a non-greedy match latched onto that first `src/` and kept the
// rest, so prod reported `src/app/src/middlewares/auth.ts` where local reported `src/middlewares/auth.ts`:
// one bug, two fingerprints, split by where it happened to run.
function trimFrame(frame: string): string {
  const m = /^at\s+(?:async\s+)?([^\s(]+)?\s*\(?([^\s()]+?):(\d+):\d+\)?$/.exec(frame);
  if (!m) return frame.replace(/^at\s+/, '').slice(0, 200);
  const [, fn, file, line] = m;
  const short = (file ?? '').replace(/^.*((?:backend|web)\/)?(src\/|scripts\/)/, '$2');
  return `${short}:${line}${fn && fn !== short ? ` ${fn}` : ''}`;
}

// ---------------------------------------------------------------------------
// Known Sui classes (§3.1)
// ---------------------------------------------------------------------------

// Hardcoded so 400 near-identical aborts collapse into 5 rows a human can act on. Matched on the
// decoded, lowercased message, before the generic path.
interface SuiClass {
  test: RegExp;
  fingerprint: string;
  title: string;
  level: ErrorLevel;
}

const SUI_CLASSES: SuiClass[] = [
  {
    // expiry_cash::assert_backing abort 0: the rolled market's payout backing is unfunded.
    test: /(expiry_cash|assert_backing|einsufficientbacking)/,
    fingerprint: 'chain.backing_unfunded',
    title: 'Rolled market backing unfunded (retry folds in plp::rebalance_expiry_cash)',
    level: 'error',
  },
  {
    test: /invalid withdraw reservation/,
    fingerprint: 'chain.sponsor_reservation_wedge',
    title: 'Sponsor balance below PLAY_GAS_BUDGET',
    level: 'error',
  },
  {
    test: /gas object not found in effects/,
    fingerprint: 'chain.settle_gas_object',
    title: 'Serial executor vs address-balance gas',
    level: 'error',
  },
];

// Admission aborts are EXPECTED: we retry at 1x by design (L-012). They are counted and charted at warn
// and never paged, because anything that pages for normal behaviour trains us to ignore the dashboard.
const ADMISSION_CODES: Array<[RegExp, string]> = [
  [/eleverageaboveadmission|einvalidleverage/, 'leverage'],
  [/eentryprobabilityoutofbounds/, 'probability'],
  [/enetpremiumbelowminimum/, 'premium'],
  [/eorderbelowliquidationthreshold/, 'liquidation'],
];

// redeem_settled on an already-closed position aborts with code 1. Terminal, not retryable: the payout
// landed on chain and we lost the DB write, so reconcileAlreadyRedeemed recovers the true number.
const SETTLE_ABORT_1 = /(redeem_settled|remove_position|redeem)/;

interface MoveAbortParts {
  module: string;
  fn: string;
  code: string;
}

// Two shapes reach us and both must parse, or every distinct abort collapses into one useless group.
// Rust debug: MoveAbort(MoveLocation { module: ModuleId { address: <addr>, name: expiry_cash },
//   function: 12, instruction: 41, function_name: assert_backing }, 0)
// gRPC json:  {"$kind":"MoveAbort","message":"MoveAbort in 3rd command, abort code: 1, in
//   '<addr>::predict_account::position_opened_at_ms' (instruction 16)","MoveAbort":{"abortCode":"1",
//   "location":{"module":"predict_account","functionName":"position_opened_at_ms"}}}
export function parseMoveAbort(decoded: string): MoveAbortParts | null {
  if (!decoded.includes('moveabort')) return null;
  // The quoted '<addr>::module::function' path is the one part of the json shape that is prose, not
  // structure, so it survives a wire-format change and backs up the explicit keys.
  const path = /'0x[0-9a-f]+::([a-z0-9_]+)::([a-z0-9_]+)'/.exec(decoded);
  const module =
    /name:\s*([a-z0-9_]+)/.exec(decoded)?.[1] ?? /"module"\s*:\s*"([a-z0-9_]+)"/.exec(decoded)?.[1] ?? path?.[1] ?? 'unknown';
  const fn =
    /function_name:\s*([a-z0-9_]+)/.exec(decoded)?.[1] ??
    /"functionname"\s*:\s*"([a-z0-9_]+)"/.exec(decoded)?.[1] ??
    path?.[2] ??
    'unknown';
  const code =
    /"abortcode"\s*:\s*"?(\d+)"?/.exec(decoded)?.[1] ??
    /abort code:\s*(\d+)/.exec(decoded)?.[1] ??
    /,\s*(\d+)\s*\)\s*$/.exec(decoded.trim())?.[1] ??
    /\}\s*,\s*(\d+)/.exec(decoded)?.[1] ??
    '0';
  return { module, fn, code };
}

export interface Classified {
  fingerprint: string;
  title: string;
  level: ErrorLevel;
}

// The five known classes, checked before the generic path. Returns null when nothing matches.
export function classifySui(message: string): Classified | null {
  const m = grpcErrorText(message);
  if (!m) return null;

  for (const [test, code] of ADMISSION_CODES) {
    if (test.test(m)) {
      return {
        fingerprint: `chain.mint_admission_${code}`,
        title: `Expected admission abort (${code}), retried at 1x`,
        level: 'warn',
      };
    }
  }

  for (const c of SUI_CLASSES) {
    if (c.test.test(m)) return { fingerprint: c.fingerprint, title: c.title, level: c.level };
  }

  const abort = parseMoveAbort(m);
  if (abort && abort.code === '1' && SETTLE_ABORT_1.test(m)) {
    return {
      fingerprint: 'chain.settle_already_redeemed',
      title: 'Lost cash-out DB write, terminal not retryable',
      level: 'error',
    };
  }

  // Unknown Move abort: fingerprint on module::function::code alone, discarding the ids and amounts
  // that make every occurrence of one bug look distinct.
  if (abort) {
    return {
      fingerprint: `chain.${sha(`${abort.module}::${abort.fn}::${abort.code}`)}`,
      title: `MoveAbort ${abort.module}::${abort.fn} ${abort.code}`,
      level: 'error',
    };
  }

  return null;
}

function sha(input: string): string {
  // 64 bits of sha256 is collision-safe for thousands of distinct bugs and keeps the id readable in a URL.
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// fingerprint (§3.1)
// ---------------------------------------------------------------------------

export interface FingerprintInput {
  kind: ErrorKind;
  message: string;
  code?: string | null;
  stack?: string | null;
  /** Manual override, e.g. captureError(err, { fingerprint: 'chain.something' }). Always wins. */
  fingerprint?: string | null;
  title?: string | null;
  level?: ErrorLevel | null;
}

export function fingerprint(input: FingerprintInput): Classified & { culprit: string } {
  const culprit = topOwnFrame(input.stack);

  if (input.fingerprint) {
    return {
      fingerprint: input.fingerprint,
      title: input.title || firstLine(input.message) || input.fingerprint,
      level: input.level || 'error',
      culprit,
    };
  }

  // Sui override runs BEFORE the generic path: it is what collapses 400 issues into 1.
  const sui = classifySui(input.message);
  if (sui) return { ...sui, level: input.level || sui.level, culprit };

  const hash = sha(`${input.kind}|${input.code ?? ''}|${normalize(input.message)}|${culprit}`);
  return {
    fingerprint: `${input.kind}.${hash}`,
    title: input.title || firstLine(input.message) || `${input.kind} error`,
    level: input.level || 'error',
    culprit,
  };
}

function firstLine(message: string): string {
  return (message || '').split('\n')[0]!.trim().slice(0, 160);
}

// ---------------------------------------------------------------------------
// Redaction (§3.4)
// ---------------------------------------------------------------------------

const SECRET_KEY = /token|secret|_pk$|privatekey|mnemonic|seed|authorization|password|apikey|cookie/i;

// Value-shaped secrets, for the message and stack where there is no key to inspect.
const VALUE_SCRUBS: Array<[RegExp, string]> = [
  [/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted-jwt]'],
  [/Bearer\s+\S+/gi, 'Bearer [redacted]'],
  // Suspicious-length base64: long enough to be a key, never a word or a Sui address (0x-prefixed hex
  // is excluded by requiring a mixed-alphabet run). Every lookahead is bounded to the candidate run
  // itself, never `[^\s]*`: an absolute stack path is a 40+ char run of [A-Za-z0-9/] and an unbounded
  // digit lookahead was being satisfied by the trailing `:113:43`, so every long path on the dashboard
  // came back as `/[redacted-key]-ws.ts`. Two digits, not one, so a path with a digit in a folder name
  // stays readable while a random 40-char key (~6 digits) still matches.
  // A trailing `\b` here would never fire after `=` (it is not a word char), leaving orphan padding
  // behind, so the tail is a negative lookahead instead.
  [/\b(?=(?:[A-Za-z0-9+/]*\d){2})(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g, '[redacted-key]'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[redacted-email]'],
];

export function scrubText(text: string): string {
  let s = text;
  for (const [re, to] of VALUE_SCRUBS) s = s.replace(re, to);
  return s;
}

// Redact by key, then scrub every string value by shape. A secret that reaches the table is already
// leaked, so this runs on write, never on read.
export function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEY.test(k)) {
      out[k] = '[redacted]';
      continue;
    }
    out[k] = typeof v === 'string' ? scrubText(v) : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Payload caps (§3.3)
// ---------------------------------------------------------------------------

export const MAX_KEYS = 16;
export const MAX_KEY_LEN = 40;
export const MAX_VALUE_LEN = 200;
export const MAX_PROPS_BYTES = 2048;
export const MAX_MESSAGE_LEN = 500;
export const MAX_STACK_BYTES = 8192;

const VALID_KEY = /^[a-z0-9_.]+$/;

export type CapResult =
  | { ok: true; props: Record<string, unknown> }
  | { ok: false; reason: string };

// `strict` is the ingest path: a client sending depth-2 props gets a 400 rather than a silent trim, so a
// bad call site is visible instead of quietly half-recorded. Non-strict (server-side context) drops the
// offending key and keeps going, because an error report is worth more than its context object.
export function capProps(input: unknown, opts: { strict?: boolean } = {}): CapResult {
  if (input === undefined || input === null) return { ok: true, props: {} };
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'props must be a plain object' };

  const entries = Object.entries(input as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  let kept = 0;

  for (const [rawKey, value] of entries) {
    const key = rawKey.toLowerCase();
    if (key.length > MAX_KEY_LEN || !VALID_KEY.test(key)) {
      if (opts.strict) return { ok: false, reason: `invalid prop key "${rawKey}"` };
      continue;
    }

    // Depth 1 only. Rejected, never flattened: a flattened blob is unbounded cardinality wearing a
    // depth-1 costume.
    if (value !== null && typeof value === 'object') {
      if (opts.strict) return { ok: false, reason: `prop "${rawKey}" is nested; props are depth 1 only` };
      continue;
    }

    // Extra keys are dropped, not rejected (§3.3), so one chatty call site never loses its whole payload.
    if (kept >= MAX_KEYS) continue;

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        if (opts.strict) return { ok: false, reason: `prop "${rawKey}" is not a finite number` };
        continue;
      }
      out[key] = value;
    } else if (typeof value === 'boolean' || value === null) {
      out[key] = value;
    } else {
      out[key] = String(value).slice(0, MAX_VALUE_LEN);
    }
    kept++;
  }

  return { ok: true, props: capBytes(out) };
}

// Total-size backstop: 16 keys of 200 chars can still be 3KB. Drops from the end until it fits and flags
// the truncation, so a reader never mistakes a trimmed payload for the whole story.
function capBytes(props: Record<string, unknown>): Record<string, unknown> {
  if (byteLen(JSON.stringify(props)) <= MAX_PROPS_BYTES) return props;

  const out: Record<string, unknown> = { _truncated: true };
  for (const [k, v] of Object.entries(props)) {
    const next = { ...out, [k]: v };
    if (byteLen(JSON.stringify(next)) > MAX_PROPS_BYTES) break;
    out[k] = v;
  }
  return out;
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export function capMessage(message: string): string {
  return scrubText(message || '').slice(0, MAX_MESSAGE_LEN);
}

export function capStack(stack?: string | null): string | null {
  if (!stack) return null;
  const scrubbed = scrubText(stack);
  return byteLen(scrubbed) <= MAX_STACK_BYTES ? scrubbed : Buffer.from(scrubbed, 'utf8').subarray(0, MAX_STACK_BYTES).toString('utf8');
}

// ---------------------------------------------------------------------------
// captureError (§3.2), the one write path
// ---------------------------------------------------------------------------

// Break-glass override. Set only if analytics is somehow hurting prod and you cannot reach the dashboard
// to flip the setting. Unset in normal operation, which is why it is the one env var this feature adds.
export const ANALYTICS_OFF = process.env.PIPS_ANALYTICS_OFF === '1';

// Cheap system state, sampled at error time rather than re-read at brief time. play-safety registers the
// provider at boot so this module keeps no Sui imports beyond grpcErrorText and can never fail to load.
type SystemStateFn = () => Record<string, unknown>;
let systemState: SystemStateFn | null = null;

export function registerSystemState(fn: SystemStateFn): void {
  systemState = fn;
}

export interface CaptureOptions {
  kind?: ErrorKind;
  level?: ErrorLevel;
  /** Manual fingerprint override, e.g. 'chain.sponsor_reservation_wedge'. */
  fingerprint?: string;
  title?: string;
  code?: string | null;
  /** Overrides err.message; handleError carries its own human message. */
  message?: string;
  stack?: string | null;
  context?: Record<string, unknown> | null;
  userId?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  method?: string | null;
  path?: string | null;
  playId?: string | null;
  release?: string | null;
  network?: string | null;
  /** Client reports carry their own capture time; everything else uses the server clock. */
  source?: 'backend' | 'web';
}

// Fire-and-forget. Returns void so no call site can await it, and the whole body is guarded twice: once
// here for anything thrown synchronously, once on the promise for anything the DB rejects. A locked Event
// table must never break a play (§13 rule 1).
export function captureError(err: unknown, opts: CaptureOptions = {}): void {
  if (ANALYTICS_OFF) return;
  try {
    const p = writeCapture(err, opts).catch(() => {});
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  } catch {
    // unreachable in practice; the belt to writeCapture's braces
  }
}

// In-flight captures, so shutdown can drain them (a crash capture is the one write worth waiting on) and
// a test can observe the result of a fire-and-forget call.
const inflight = new Set<Promise<void>>();

// Daily row budget for error samples. On breach we stop recording and say so once, loudly: silently
// dropping is how a dashboard ends up under-reporting and looking healthy. Counted at most once a minute
// so the check itself is never the expensive part.
let budgetAt = 0;
let budgetHit = false;

export async function errorBudgetExceeded(): Promise<boolean> {
  const now = Date.now();
  if (now - budgetAt < 60_000) return budgetHit;
  budgetAt = now;
  try {
    const max = await getSetting('analytics.error_daily_max');
    const since = new Date(now - 86_400_000);
    const used = await prismaQuery.errorEvent.count({ where: { createdAt: { gte: since } } });
    const wasHit = budgetHit;
    budgetHit = used >= max;
    if (budgetHit && !wasHit) {
      const { alert } = await import('./alert.ts');
      alert('critical', 'error sample budget exhausted, new samples are being dropped', { used, max }, 'budget:error_daily_max');
    }
  } catch {
    // A failed budget read must not become a reason to stop recording errors.
    budgetHit = false;
  }
  return budgetHit;
}

// Daily row budget for events. Same shape as the error budget: on breach we sample rather than stop, say so
// once, loudly, and keep serving. A silent drop is how a dashboard ends up under-reporting.
let eventBudgetAt = 0;
let eventBudgetHit = false;

export async function eventBudgetExceeded(): Promise<boolean> {
  const now = Date.now();
  if (now - eventBudgetAt < 60_000) return eventBudgetHit;
  eventBudgetAt = now;
  try {
    const max = await getSetting('analytics.daily_max');
    const used = await prismaQuery.event.count({ where: { ts: { gte: new Date(now - 86_400_000) } } });
    const wasHit = eventBudgetHit;
    eventBudgetHit = used >= max;
    if (eventBudgetHit && !wasHit) {
      const { alert } = await import('./alert.ts');
      alert('critical', 'event budget exhausted, ingest is sampling', { used, max }, 'budget:analytics_daily_max');
    }
  } catch {
    eventBudgetHit = false;
  }
  return eventBudgetHit;
}

/** Past the budget we keep 1 in 10 rather than going dark, so trends stay visible while the table cools. */
export const BUDGET_SAMPLE_RATE = 0.1;

export async function flushCaptures(): Promise<void> {
  while (inflight.size) await Promise.all([...inflight]);
}

// ---------------------------------------------------------------------------
// track (§4.1), the server-observed half of the catalog
// ---------------------------------------------------------------------------

export interface TrackOptions {
  anonId?: string | null;
  sessionId?: string;
  platform?: string;
  props?: Record<string, unknown> | null;
}

// Server-side twin of the client's track(). Same contract: returns void, never throws, never awaited on a
// request path. For the handful of events only the server can observe (a landed deposit, an audit trail).
export function track(userId: string | null, name: EventName | string, opts: TrackOptions = {}): void {
  if (ANALYTICS_OFF) return;
  try {
    const p = writeEvent(userId, name, opts).catch(() => {});
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  } catch {
    // unreachable in practice; the belt to writeEvent's braces
  }
}

async function writeEvent(userId: string | null, name: string, opts: TrackOptions): Promise<void> {
  if (!isEventName(name)) return;
  if (!(await getSetting('analytics.enabled'))) return;
  if ((await eventBudgetExceeded()) && Math.random() > BUDGET_SAMPLE_RATE) return;

  const capped = capProps(redact(opts.props ?? {}));
  await prismaQuery.event.create({
    data: {
      name,
      userId,
      anonId: opts.anonId ?? null,
      sessionId: opts.sessionId ?? 'server',
      props: capped.ok && Object.keys(capped.props).length ? (capped.props as Prisma.InputJsonValue) : undefined,
      platform: opts.platform ?? 'server',
      source: 'backend',
      release: RELEASE,
      network: SUI_NETWORK,
    },
  });
}

// Distinct-user tracking. The samples table is capped, so it cannot answer "have we seen this user on this
// bug", and a per-group user table is not worth a fourth model. This process-local set is the increment
// guard: exact within a process, and at worst it recounts a user once after a restart.
const seenUsers = new Set<string>();

async function writeCapture(err: unknown, opts: CaptureOptions): Promise<void> {
  const rawMessage = opts.message ?? (err instanceof Error ? err.message : String(err ?? 'unknown error'));
  const rawStack = opts.stack ?? (err instanceof Error ? err.stack : null);

  const kind = opts.kind ?? 'job';
  const cls = fingerprint({
    kind,
    message: rawMessage,
    code: opts.code,
    stack: rawStack,
    fingerprint: opts.fingerprint,
    title: opts.title,
    level: opts.level,
  });

  const release = opts.release ?? RELEASE;
  const network = opts.network ?? SUI_NETWORK;
  const now = new Date();

  const context = buildContext(opts.context);

  const prior = await prismaQuery.errorGroup.findUnique({
    where: { fingerprint: cls.fingerprint },
    select: { status: true, title: true },
  });

  // A resolved bug firing again is a regression: reopen it and say so, because a silently reopened group
  // reads as an old bug nobody has looked at.
  const regression = prior?.status === 'resolved';
  const status = regression || prior?.status === 'ack' ? 'open' : prior?.status;

  const newUser = opts.userId ? !seenUsers.has(`${cls.fingerprint}|${opts.userId}`) : false;
  if (newUser && opts.userId) {
    if (seenUsers.size > 20_000) seenUsers.clear();
    seenUsers.add(`${cls.fingerprint}|${opts.userId}`);
  }

  await prismaQuery.errorGroup.upsert({
    where: { fingerprint: cls.fingerprint },
    create: {
      fingerprint: cls.fingerprint,
      title: cls.title,
      culprit: cls.culprit || null,
      kind,
      level: cls.level,
      count: 1,
      usersAffected: opts.userId ? 1 : 0,
      firstSeen: now,
      lastSeen: now,
      firstRelease: release,
      lastRelease: release,
    },
    update: {
      count: { increment: 1 },
      ...(newUser ? { usersAffected: { increment: 1 } } : {}),
      lastSeen: now,
      lastRelease: release,
      // A regression keeps its resolvedAt: `open` with a resolvedAt is the only queryable trace that this
      // group had been closed and came back, which is what detector 11 watches. Triaging it clears the mark.
      ...(status && status !== prior?.status ? { status, ...(regression ? {} : { resolvedAt: null }) } : {}),
    },
  });

  await prismaQuery.errorEvent.create({
    data: {
      fingerprint: cls.fingerprint,
      message: capMessage(rawMessage),
      stack: capStack(rawStack),
      context,
      userId: opts.userId ?? null,
      sessionId: opts.sessionId ?? null,
      requestId: opts.requestId ?? null,
      method: opts.method ?? null,
      path: opts.path ?? null,
      playId: opts.playId ?? null,
      release,
      network,
    },
  });

  await pruneSamples(cls.fingerprint);

  if (regression) {
    const { alert } = await import('./alert.ts');
    alert('critical', `regression: ${cls.title} fired again after being resolved`, { fingerprint: cls.fingerprint, release }, `regression:${cls.fingerprint}`);
  }
}

// Redacted, capped, and stamped with whatever system state is cheap right now.
function buildContext(context?: Record<string, unknown> | null): Prisma.InputJsonValue | undefined {
  const base: Record<string, unknown> = { ...(context ?? {}) };
  if (systemState) {
    try {
      Object.assign(base, systemState());
    } catch {
      // a broken provider must never cost us the error report
    }
  }
  if (!Object.keys(base).length) return undefined;
  const capped = capProps(redact(base));
  return capped.ok ? (capped.props as Prisma.InputJsonValue) : undefined;
}

// The trick that makes 10,000 occurrences cost 21 rows: the group holds the true count, the samples table
// holds only the newest N. Age-based retention (§9) is a backstop, this does the real work.
async function pruneSamples(fp: string): Promise<void> {
  const keep = await getSetting('retention.samples_per_group');
  const stale = await prismaQuery.errorEvent.findMany({
    where: { fingerprint: fp },
    orderBy: { createdAt: 'desc' },
    skip: keep,
    select: { id: true },
  });
  if (!stale.length) return;
  await prismaQuery.errorEvent.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
}
