// Error fingerprinting, redaction, and payload caps. The whole point is that one bug shows up as ONE
// group: our messages carry play ids, amounts, and object ids, so grouping on message text gives 400
// issues for one bug (L-021). See bigdev/plans/cont/03-ADMIN-DASHBOARD.md §3.
//
// Nothing in this file touches the DB or throws. captureError() (the write path) lands in the next phase
// and is built on these.

import { createHash } from 'node:crypto';

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
function trimFrame(frame: string): string {
  const m = /^at\s+(?:async\s+)?([^\s(]+)?\s*\(?([^\s()]+?):(\d+):\d+\)?$/.exec(frame);
  if (!m) return frame.replace(/^at\s+/, '').slice(0, 200);
  const [, fn, file, line] = m;
  const short = (file ?? '').replace(/^.*?((?:backend|web)\/)?(src\/|scripts\/)/, '$2');
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

// MoveAbort(MoveLocation { module: ModuleId { address: <addr>, name: expiry_cash },
//   function: 12, instruction: 41, function_name: assert_backing }, 0)
export function parseMoveAbort(decoded: string): MoveAbortParts | null {
  if (!decoded.includes('moveabort')) return null;
  const module = /name:\s*([a-z0-9_]+)/.exec(decoded)?.[1] ?? 'unknown';
  const fn = /function_name:\s*([a-z0-9_]+)/.exec(decoded)?.[1] ?? 'unknown';
  const code = /,\s*(\d+)\s*\)\s*$/.exec(decoded.trim())?.[1] ?? /\}\s*,\s*(\d+)/.exec(decoded)?.[1] ?? '0';
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
  // is excluded by requiring a mixed-alphabet run).
  [/\b(?=[A-Za-z0-9+/]{40,})(?=[^\s]*[A-Z])(?=[^\s]*[a-z])(?=[^\s]*\d)[A-Za-z0-9+/]{40,}={0,2}\b/g, '[redacted-key]'],
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
