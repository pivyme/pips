// The grouping, redaction, and cap contract from 03-ADMIN-DASHBOARD.md §3. These are the assertions that
// keep the dashboard honest: if fingerprinting drifts, one bug fans out into hundreds of rows and the
// dashboard silently under-reports, which looks exactly like a healthy product.

import { describe, expect, it } from 'bun:test';

import {
  MAX_MESSAGE_LEN,
  MAX_PROPS_BYTES,
  MAX_STACK_BYTES,
  capMessage,
  capProps,
  capStack,
  fingerprint,
  normalize,
  redact,
  scrubText,
  topOwnFrame,
} from './analytics.ts';

const ABORT = (module: string, fn: string, code: number, extra = '') =>
  `MoveAbort(MoveLocation { module: ModuleId { address: 0xdb3ef5a5aabbccdd112233445566778899aabbccddeeff00112233445566446e, name: ${module} }, ` +
  `function: 12, instruction: 41, function_name: ${fn} }, ${code})${extra}`;

describe('normalize (§3.1)', () => {
  it('strips hex addresses, ids, long numbers, and quoted strings', () => {
    const a = normalize('play clzt1a2b3c4d5e6f7g8h9i0j failed for 0xdeadbeefcafe with 1500000 at "lucky"');
    const b = normalize('play clqq9z8y7x6w5v4u3t2s1r0q failed for 0xfeedface1234 with 2750000 at "range"');
    expect(a).toBe(b);
    expect(a).toContain('<addr>');
    expect(a).toContain('<id>');
    expect(a).toContain('<n>');
    expect(a).toContain('<str>');
  });

  it('normalizes uuids', () => {
    const a = normalize('session 3f2504e0-4f89-11d3-9a0c-0305e82c3301 expired');
    const b = normalize('session 9c858901-8a57-4791-81fe-4c455b099bc9 expired');
    expect(a).toBe(b);
    expect(a).toBe('session <id> expired');
  });

  it('leaves abort codes intact so two codes stay distinguishable', () => {
    expect(normalize('assert_backing abort 0')).toBe('assert_backing abort 0');
    expect(normalize('assert_backing abort 0')).not.toBe(normalize('assert_backing abort 3'));
    // ...but a 3+ digit amount in the same message still collapses.
    expect(normalize('abort 0 stake 1500000')).toBe(normalize('abort 0 stake 2750000'));
  });

  it('percent-decodes first, so an encoded gRPC message matches its decoded twin', () => {
    const encoded = 'MoveAbort%20%28MoveLocation%20%7B%20name%3A%20expiry_cash%20%7D%2C%200%29';
    expect(normalize(encoded)).toBe(normalize('MoveAbort (MoveLocation { name: expiry_cash }, 0)'));
  });

  it('collapses whitespace and lowercases', () => {
    expect(normalize('  Gas   Object\n NOT  found ')).toBe('gas object not found');
  });
});

describe('topOwnFrame (§3.1)', () => {
  it('picks the first frame outside node_modules', () => {
    const stack = [
      'Error: boom',
      '    at request (/app/node_modules/@mysten/sui/dist/grpc.js:12:9)',
      '    at commitPlay (/app/backend/src/services/plays.ts:235:11)',
      '    at handler (/app/backend/src/routes/gameRoutes.ts:88:5)',
    ].join('\n');
    expect(topOwnFrame(stack)).toBe('src/services/plays.ts:235 commitPlay');
  });

  it('falls back to the top frame when every frame is vendor code', () => {
    const stack = ['Error: boom', '    at a (/app/node_modules/x/y.js:1:1)'].join('\n');
    expect(topOwnFrame(stack)).toContain('y.js:1');
  });

  it('returns an empty string with no stack', () => {
    expect(topOwnFrame(undefined)).toBe('');
    expect(topOwnFrame(null)).toBe('');
  });
});

describe('the five known Sui classes collapse to their fingerprint (§3.1)', () => {
  it('assert_backing abort 0 -> chain.backing_unfunded', () => {
    const f = fingerprint({ kind: 'chain', message: ABORT('expiry_cash', 'assert_backing', 0) });
    expect(f.fingerprint).toBe('chain.backing_unfunded');
    expect(f.level).toBe('error');
    expect(f.title).toContain('backing unfunded');
  });

  it('settle MoveAbort 1 -> chain.settle_already_redeemed', () => {
    const f = fingerprint({
      kind: 'chain',
      message: ABORT('order', 'redeem_settled', 1),
    });
    expect(f.fingerprint).toBe('chain.settle_already_redeemed');
    expect(f.level).toBe('error');
  });

  it('Invalid withdraw reservation -> chain.sponsor_reservation_wedge', () => {
    const f = fingerprint({ kind: 'chain', message: 'Error: Invalid withdraw reservation for 0xabcdef123456' });
    expect(f.fingerprint).toBe('chain.sponsor_reservation_wedge');
  });

  it('Gas object not found in effects -> chain.settle_gas_object', () => {
    const f = fingerprint({ kind: 'chain', message: 'Gas object not found in effects' });
    expect(f.fingerprint).toBe('chain.settle_gas_object');
  });

  it('admission aborts are warn, never error, and split by code', () => {
    const lev = fingerprint({ kind: 'chain', message: 'MoveAbort ... ELeverageAboveAdmission ...' });
    const prob = fingerprint({ kind: 'chain', message: 'MoveAbort ... EEntryProbabilityOutOfBounds ...' });
    const prem = fingerprint({ kind: 'chain', message: 'MoveAbort ... ENetPremiumBelowMinimum ...' });

    expect(lev.fingerprint).toBe('chain.mint_admission_leverage');
    expect(prob.fingerprint).toBe('chain.mint_admission_probability');
    expect(prem.fingerprint).toBe('chain.mint_admission_premium');
    // Expected behaviour: we retry at 1x by design, so this must never page.
    for (const f of [lev, prob, prem]) expect(f.level).toBe('warn');
  });
});

describe('fingerprint (§3.1)', () => {
  it('collapses 100 occurrences of one abort into one fingerprint', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(
        fingerprint({
          kind: 'chain',
          message: ABORT('expiry_cash', 'assert_backing', 0, ` play clx${i}aaaaaaaaaaaaaaaaaaaa stake ${1_000_000 + i}`),
        }).fingerprint
      );
    }
    expect(seen.size).toBe(1);
  });

  it('groups a percent-encoded gRPC message with its decoded twin', () => {
    const decoded = 'transaction failed: object 0xaabbccddeeff is not available for consumption';
    const encoded = encodeURIComponent(decoded);
    const a = fingerprint({ kind: 'chain', message: decoded, stack: 'Error\n    at f (/app/backend/src/lib/sui/execute.ts:10:1)' });
    const b = fingerprint({ kind: 'chain', message: encoded, stack: 'Error\n    at f (/app/backend/src/lib/sui/execute.ts:10:1)' });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('keeps genuinely different bugs apart', () => {
    const a = fingerprint({ kind: 'http', message: 'user not found' });
    const b = fingerprint({ kind: 'http', message: 'market not found' });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('splits the same message across kinds and call sites', () => {
    const msg = 'timeout waiting for chain';
    const stackA = 'Error\n    at a (/app/backend/src/workers/settle.ts:12:1)';
    const stackB = 'Error\n    at b (/app/backend/src/services/plays.ts:99:1)';
    expect(fingerprint({ kind: 'worker', message: msg, stack: stackA }).fingerprint).not.toBe(
      fingerprint({ kind: 'chain', message: msg, stack: stackA }).fingerprint
    );
    expect(fingerprint({ kind: 'worker', message: msg, stack: stackA }).fingerprint).not.toBe(
      fingerprint({ kind: 'worker', message: msg, stack: stackB }).fingerprint
    );
  });

  it('honours the manual override and reports the culprit', () => {
    const f = fingerprint({
      kind: 'chain',
      message: 'anything at all',
      fingerprint: 'chain.something',
      stack: 'Error\n    at commitPlay (/app/backend/src/services/plays.ts:235:11)',
    });
    expect(f.fingerprint).toBe('chain.something');
    expect(f.culprit).toBe('src/services/plays.ts:235 commitPlay');
  });
});

describe('redaction (§3.4)', () => {
  it('redacts every key pattern in the list', () => {
    const out = redact({
      accesstoken: 'abc',
      client_secret: 'shh',
      operator_pk: 'suiprivkey1...',
      privatekey: 'x',
      mnemonic: 'word word word',
      seed: 'y',
      authorization: 'Bearer zzz',
      password: 'hunter2',
      apikey: 'k',
      cookie: 'sid=1',
      playid: 'clx123',
    });
    for (const k of ['accesstoken', 'client_secret', 'operator_pk', 'privatekey', 'mnemonic', 'seed', 'authorization', 'password', 'apikey', 'cookie']) {
      expect(out[k]).toBe('[redacted]');
    }
    // Public values survive: a play id is what makes a report useful.
    expect(out.playid).toBe('clx123');
  });

  it('scrubs value-shaped secrets even when the key looks innocent', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const out = redact({ note: `token is ${jwt}`, hdr: 'Bearer sk_live_abcdef0123456789' });
    expect(out.note).not.toContain('eyJ');
    expect(out.note).toContain('[redacted-jwt]');
    expect(out.hdr).toBe('Bearer [redacted]');
  });

  it('scrubs a secret hiding in the stack, not just the message', () => {
    const stack = 'Error: boom\n    at load (/app/src/signer.ts:1:1) key=eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(capStack(stack)).toContain('[redacted-jwt]');
    expect(capStack(stack)).not.toContain('eyJhbGciOi');
  });

  it('scrubs email addresses but keeps Sui addresses and digests', () => {
    expect(scrubText('signup from user@example.com failed')).toBe('signup from [redacted-email] failed');
    const sui = '0xf86d0f8b1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a31756';
    expect(scrubText(`wrapper ${sui} missing`)).toContain(sui);
  });

  // Found on the live dashboard, where every worker stack read `at <anonymous> (/[redacted-key]-ws.ts:113:43)`.
  // An absolute path is a 40+ char run of [A-Za-z0-9/], and the digit lookahead was unbounded, so the
  // trailing `:113:43` satisfied it and the base64 rule swallowed the path. A mangled path is not a
  // cosmetic problem: topOwnFrame is how a group is named and how an engineer finds the code.
  it('keeps a long absolute stack path readable, since it is not a secret', () => {
    const frame = '    at handler (/Users/kelvinadithya/Desktop/DEVELOPMENT/PIPS/backend/src/lib/binance-ws.ts:113:43)';
    expect(scrubText(frame)).toBe(frame);
    expect(scrubText(frame)).not.toContain('[redacted-key]');
    // A digit in a folder name must not bring the false positive back.
    const withDigit = '    at t (/home/deploy2/apps/pips-backend/src/services/plays.ts:88:7)';
    expect(scrubText(withDigit)).toBe(withDigit);
  });

  it('still scrubs a real base64 key, including one with a slash in it', () => {
    const key = 'aB3xK9mQ2vB7nP4tL6wZ8yR1cD5eF0gH/jK2lM4nO6pQ8rS=';
    expect(scrubText(`loaded ${key} at boot`)).toBe('loaded [redacted-key] at boot');
  });
});

describe('payload caps (§3.3)', () => {
  it('rejects a nested object on the strict path instead of flattening it', () => {
    const r = capProps({ game: 'lucky', meta: { a: 1 } }, { strict: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('depth 1');
  });

  it('drops the nested key on the lenient path so the rest of the context survives', () => {
    const r = capProps({ game: 'lucky', meta: { a: 1 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.props).toEqual({ game: 'lucky' });
  });

  it('drops keys past the 16th rather than rejecting the payload', () => {
    const input: Record<string, number> = {};
    for (let i = 0; i < 20; i++) input[`k${i}`] = i;
    const r = capProps(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.props).length).toBe(16);
      expect(r.props.k0).toBe(0);
      expect(r.props.k16).toBeUndefined();
    }
  });

  it('truncates a 201 char value to 200', () => {
    const r = capProps({ note: 'x'.repeat(201) });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.props.note as string).length).toBe(200);
  });

  it('rejects an over-long or malformed key on the strict path', () => {
    expect(capProps({ ['a'.repeat(41)]: 1 }, { strict: true }).ok).toBe(false);
    expect(capProps({ 'bad-key!': 1 }, { strict: true }).ok).toBe(false);
    expect(capProps({ good_key: 1 }, { strict: true }).ok).toBe(true);
  });

  it('rejects a non-finite number on the strict path', () => {
    expect(capProps({ n: Number.NaN }, { strict: true }).ok).toBe(false);
    expect(capProps({ n: Number.POSITIVE_INFINITY }, { strict: true }).ok).toBe(false);
    expect(capProps({ n: 1.5 }, { strict: true }).ok).toBe(true);
  });

  it('truncates past 2KB total and flags it, so a trimmed payload is never mistaken for the whole story', () => {
    const input: Record<string, string> = {};
    for (let i = 0; i < 16; i++) input[`k${i}`] = 'y'.repeat(200);
    const r = capProps(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.props._truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(r.props), 'utf8')).toBeLessThanOrEqual(MAX_PROPS_BYTES);
    }
  });

  it('rejects a non-object props payload', () => {
    expect(capProps([1, 2, 3]).ok).toBe(false);
    expect(capProps('nope').ok).toBe(false);
    expect(capProps(undefined).ok).toBe(true);
  });

  it('cuts a 501 char message to 500 and an oversized stack to 8KB', () => {
    expect(capMessage('m'.repeat(501)).length).toBe(MAX_MESSAGE_LEN);
    const stack = capStack('s'.repeat(MAX_STACK_BYTES + 1));
    expect(stack).not.toBeNull();
    expect(Buffer.byteLength(stack!, 'utf8')).toBeLessThanOrEqual(MAX_STACK_BYTES);
    expect(capStack(null)).toBeNull();
  });
});
