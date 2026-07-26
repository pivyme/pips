// The envelope (§4.4, Addendum A6 item 9). Four claims worth pinning, because each one is the difference
// between tamper-evidence and decoration:
//
//   1. a sealed record round trips
//   2. a record cannot be spliced into another session, or edited
//   3. an expired sid is rejected before any crypto runs, with no store to consult
//   4. version-byte 0 plaintext is accepted, so no browser without crypto.subtle loses its analytics

import { describe, expect, it } from 'bun:test';

import { ENVELOPE_VERSION, PLAINTEXT_VERSION, SESSION_TTL_MS, SID_BYTES, frame, fromB64url, issueSession, keyFor, open, seal, sidExpiryMs, unframe } from './envelope.ts';

const payload = JSON.stringify({ name: 'game.play_tap', props: { game: 'lucky', stake: 2 }, sessionId: 's_1', anonId: 'a_1' });

function sidOf(handshake = issueSession()): Uint8Array {
  return fromB64url(handshake.sid);
}

describe('handshake', () => {
  it('issues a 16-byte sid whose own bytes carry the expiry', () => {
    const now = Date.UTC(2026, 6, 27, 12, 0, 0);
    const h = issueSession(now);
    const sid = fromB64url(h.sid);

    expect(sid.length).toBe(SID_BYTES);
    expect(h.expiresAt).toBe(now + SESSION_TTL_MS);
    // The deadline is inside the sid and covered by the HMAC, which is what makes the server stateless.
    expect(sidExpiryMs(sid)).toBe(h.expiresAt);
  });

  it('derives the same key from the same sid, and a different one per session', () => {
    const a = sidOf();
    const b = sidOf();
    expect(keyFor(a).equals(keyFor(a))).toBe(true);
    expect(keyFor(a).equals(keyFor(b))).toBe(false);
  });
});

describe('seal / open', () => {
  it('round trips, and the wire record is [1B version][16B sid][12B nonce][ct+tag]', async () => {
    const sid = sidOf();
    const record = await seal(sid, payload);

    expect(record[0]).toBe(ENVELOPE_VERSION);
    expect([...record.subarray(1, 1 + SID_BYTES)]).toEqual([...sid]);
    // 1 + 16 + 12 header, then the ciphertext plus a 16-byte tag.
    expect(record.length).toBe(1 + SID_BYTES + 12 + payload.length + 16);
    // The payload is genuinely not on the wire.
    expect(Buffer.from(record).toString('utf8')).not.toContain('game.play_tap');

    const opened = await open(record);
    expect(opened).toMatchObject({ ok: true, sealed: true, plaintext: payload });
  });

  it('refuses a record spliced into another session', async () => {
    const mine = sidOf();
    const theirs = sidOf();
    const record = await seal(mine, payload);
    record.set(theirs, 1); // same ciphertext, someone else's sid

    expect(await open(record)).toMatchObject({ ok: false, reason: 'authentication failed' });
  });

  it('refuses a record with a single edited byte', async () => {
    const sid = sidOf();
    const record = await seal(sid, payload);
    const at = record.length - 20;
    record[at] = record[at]! ^ 0x01;

    expect(await open(record)).toMatchObject({ ok: false, reason: 'authentication failed' });
  });

  it('rejects an expired sid, and does so before any crypto', async () => {
    const now = Date.UTC(2026, 6, 27, 12, 0, 0);
    const expired = fromB64url(issueSession(now - SESSION_TTL_MS - 1000).sid);
    const record = await seal(expired, payload);

    // Same bytes, judged only by the clock: valid before the deadline, refused after it.
    expect(await open(record, now - SESSION_TTL_MS - 500)).toMatchObject({ ok: true, sealed: true });
    expect(await open(record, now)).toMatchObject({ ok: false, reason: 'session expired' });
  });

  it('accepts version-byte 0 plaintext, the fallback for no crypto.subtle', async () => {
    const body = new TextEncoder().encode(payload);
    const record = new Uint8Array(1 + body.length);
    record[0] = PLAINTEXT_VERSION;
    record.set(body, 1);

    expect(await open(record)).toMatchObject({ ok: true, sealed: false, plaintext: payload });
  });

  it('reports rather than throws on an unknown version, an empty body, or a truncated record', async () => {
    expect(await open(new Uint8Array([9, 1, 2, 3]))).toMatchObject({ ok: false });
    expect(await open(new Uint8Array())).toMatchObject({ ok: false, reason: 'empty record' });
    expect(await open(new Uint8Array([ENVELOPE_VERSION, 1, 2, 3]))).toMatchObject({ ok: false, reason: 'record too short' });
  });
});

describe('framing', () => {
  it('splits a batch back into the records it was built from', async () => {
    const sid = sidOf();
    const records = [await seal(sid, '{"a":1}'), await seal(sid, '{"b":2}'), await seal(sid, '{"c":3}')];
    const split = unframe(frame(records), 20);

    expect(split).not.toBeNull();
    expect(split).toHaveLength(3);
    for (const [i, record] of split!.entries()) {
      expect(await open(record)).toMatchObject({ ok: true, plaintext: ['{"a":1}', '{"b":2}', '{"c":3}'][i] });
    }
  });

  it('refuses framing that lies about its lengths instead of reading past the end', () => {
    expect(unframe(new Uint8Array([0xff, 0xff, 1, 2, 3]), 20)).toBeNull();
    expect(unframe(new Uint8Array([0, 0]), 20)).toBeNull();
    expect(unframe(new Uint8Array([0, 4, 1, 2]), 20)).toBeNull();
  });

  it('stops parsing once a body claims more records than we accept', () => {
    const records = Array.from({ length: 25 }, (_, i) => new Uint8Array([PLAINTEXT_VERSION, i]));
    const split = unframe(frame(records), 20);
    expect(split!.length).toBeGreaterThan(20);
  });
});
