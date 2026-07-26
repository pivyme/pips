// The opaque ingest envelope (§4.4). Plain JSON in the network tab is free intel: anyone with devtools
// reads our event catalog, our funnel, and our stack traces, and can replay a captured request.
//
// Be honest about what this buys. The client runs on the user's machine, so nothing here makes ingest
// AUTHENTICATED, and it is not meant to. Authenticity is still the JWT for authed events and the
// 7-name/10-per-min cap for anonymous ones. What this buys: nothing legible on the wire, and a captured
// payload that cannot be edited or replayed. That is the right amount of effort for analytics.
//
// Stateless by construction: the key is recomputed from the sid, so any instance opens any envelope, a
// restart invalidates nothing, and an expired session is rejected with zero lookups. No store, no Redis.

import { createHmac } from 'node:crypto';

import { JWT_SECRET } from '../config/main-config.ts';

export const ENVELOPE_VERSION = 1;
export const PLAINTEXT_VERSION = 0;

// Wire record: [1B version][16B sid][12B nonce][ciphertext + 16B tag]. The sid is 16 raw bytes carrying its
// own expiry (10 random + 6 big-endian ms), so the server can rederive the key and check the deadline from
// the bytes alone. 80 bits of randomness is plenty for a session id whose only job is keying obfuscation.
export const SID_BYTES = 16;
const SID_RANDOM_BYTES = 10; // the remaining 6 bytes are the expiry, big-endian ms
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Replay window on the plaintext ts. Caps replay of a captured request, no seq store needed. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

// One derivation from JWT_SECRET, cached: the ingest key line is a different purpose than session signing,
// so it never touches the raw secret directly.
let ingestRoot: Buffer | null = null;
function root(): Buffer {
  ingestRoot ??= createHmac('sha256', JWT_SECRET).update('ingest').digest();
  return ingestRoot;
}

export function sidExpiryMs(sid: Uint8Array): number {
  let ms = 0;
  for (let i = SID_RANDOM_BYTES; i < SID_BYTES; i++) ms = ms * 256 + sid[i]!;
  return ms;
}

/** The per-session key, recomputed rather than stored. */
export function keyFor(sid: Uint8Array): Buffer {
  return createHmac('sha256', root()).update(sid).digest();
}

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromB64url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

export interface Handshake {
  sid: string;
  key: string;
  expiresAt: number;
}

// The trick that makes this worth doing: the key is issued at runtime over TLS, never baked into the
// bundle. A static key in the JS is decoration.
export function issueSession(now = Date.now()): Handshake {
  const sid = new Uint8Array(SID_BYTES);
  crypto.getRandomValues(sid.subarray(0, SID_RANDOM_BYTES));
  const expiresAt = now + SESSION_TTL_MS;
  let rest = expiresAt;
  for (let i = SID_BYTES - 1; i >= SID_RANDOM_BYTES; i--) {
    sid[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return { sid: b64url(sid), key: Buffer.from(keyFor(sid)).toString('base64'), expiresAt };
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as unknown as ArrayBuffer, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Seal one record. Server-side this exists so the round trip is testable end to end. */
export async function seal(sid: Uint8Array, plaintext: string): Promise<Uint8Array> {
  const nonce = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(nonce);
  const key = await aesKey(keyFor(sid));
  const ct = new Uint8Array(
    // sid as AAD, so a captured envelope cannot be spliced into another session.
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as unknown as ArrayBuffer, additionalData: sid as unknown as ArrayBuffer, tagLength: TAG_BYTES * 8 }, key, new TextEncoder().encode(plaintext))
  );

  const out = new Uint8Array(1 + SID_BYTES + NONCE_BYTES + ct.length);
  out[0] = ENVELOPE_VERSION;
  out.set(sid, 1);
  out.set(nonce, 1 + SID_BYTES);
  out.set(ct, 1 + SID_BYTES + NONCE_BYTES);
  return out;
}

export type OpenResult = { ok: true; plaintext: string; sealed: boolean } | { ok: false; reason: string };

// Opens one record. Fails soft in the sense that it never throws, only reports why.
export async function open(record: Uint8Array, now = Date.now()): Promise<OpenResult> {
  if (!record.length) return { ok: false, reason: 'empty record' };

  const version = record[0];

  // Version 0 is the plaintext fallback: no crypto.subtle (insecure context, old browser), a failed
  // handshake, or a key that expired mid-session. Analytics never breaks itself over crypto.
  if (version === PLAINTEXT_VERSION) {
    return { ok: true, plaintext: new TextDecoder().decode(record.subarray(1)), sealed: false };
  }
  if (version !== ENVELOPE_VERSION) return { ok: false, reason: `unsupported envelope version ${String(version)}` };
  if (record.length < 1 + SID_BYTES + NONCE_BYTES + TAG_BYTES) return { ok: false, reason: 'record too short' };

  const sid = record.subarray(1, 1 + SID_BYTES);
  // Checked before any crypto: an expired session costs one comparison, not a decrypt.
  if (sidExpiryMs(sid) < now) return { ok: false, reason: 'session expired' };

  const nonce = record.subarray(1 + SID_BYTES, 1 + SID_BYTES + NONCE_BYTES);
  const ct = record.subarray(1 + SID_BYTES + NONCE_BYTES);

  try {
    const key = await aesKey(keyFor(sid));
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce as unknown as ArrayBuffer, additionalData: sid as unknown as ArrayBuffer, tagLength: TAG_BYTES * 8 },
      key,
      ct as unknown as ArrayBuffer
    );
    return { ok: true, plaintext: new TextDecoder().decode(plain), sealed: true };
  } catch {
    // A wrong sid, a tampered byte, or a spliced envelope all land here. Same answer for all of them.
    return { ok: false, reason: 'authentication failed' };
  }
}

// The batch is a concatenation of length-prefixed records, because sealing happens per event AT QUEUE TIME
// (§4.4 point 5): crypto.subtle is async and iOS can freeze a backgrounding page before an encrypt promise
// resolves, so the flush must be pure synchronous concatenation with ready bytes for sendBeacon.
export const LENGTH_PREFIX_BYTES = 2;
const MAX_RECORD_BYTES = 65_535;

export function frame(records: Uint8Array[]): Uint8Array {
  const total = records.reduce((n, r) => n + LENGTH_PREFIX_BYTES + r.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const r of records) {
    out[at] = (r.length >> 8) & 0xff;
    out[at + 1] = r.length & 0xff;
    out.set(r, at + LENGTH_PREFIX_BYTES);
    at += LENGTH_PREFIX_BYTES + r.length;
  }
  return out;
}

export function unframe(body: Uint8Array, maxRecords: number): Uint8Array[] | null {
  const out: Uint8Array[] = [];
  let at = 0;
  while (at < body.length) {
    if (at + LENGTH_PREFIX_BYTES > body.length) return null;
    const len = (body[at]! << 8) | body[at + 1]!;
    if (len === 0 || len > MAX_RECORD_BYTES) return null;
    const end = at + LENGTH_PREFIX_BYTES + len;
    if (end > body.length) return null;
    out.push(body.subarray(at + LENGTH_PREFIX_BYTES, end));
    at = end;
    // Bail rather than parse the rest: a body claiming more records than we accept is not worth the work.
    if (out.length > maxRecords) return out;
  }
  return out;
}
