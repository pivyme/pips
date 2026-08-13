// Endpoint rotation: a wrong-network fallback answers reads against the wrong chain, and a cooled endpoint
// that never gets parked costs a doomed round trip per call. Both fail silently, so both get a test.

import { describe, expect, test } from 'bun:test';

import { createEndpointRing, parseEndpoints, redactEndpoint } from './client.ts';
import { NETWORK } from './config.ts';

const PUBLIC = NETWORK === 'mainnet' ? 'https://fullnode.mainnet.sui.io:443' : 'https://fullnode.testnet.sui.io:443';
const OTHER = NETWORK === 'mainnet' ? 'https://graphql.testnet.sui.io/graphql' : 'https://graphql.mainnet.sui.io/graphql';
const KEYED = 'https://api.example.com/node/v1/sui/deadbeef/graphql';

describe('parseEndpoints', () => {
  test('splits a comma list, trims, and drops trailing slashes', () => {
    expect(parseEndpoints(` ${PUBLIC}/ , ${KEYED} `, PUBLIC, 'test')).toEqual([PUBLIC, KEYED]);
  });

  test('keeps a keyless url that names no network', () => {
    expect(parseEndpoints(KEYED, PUBLIC, 'test')).toEqual([KEYED]);
  });

  test('drops an endpoint that names the other network', () => {
    expect(parseEndpoints(`${PUBLIC},${OTHER}`, PUBLIC, 'test')).toEqual([PUBLIC]);
  });

  test('falls back to the public endpoint when every url is wrong-network', () => {
    expect(parseEndpoints(OTHER, PUBLIC, 'test')).toEqual([PUBLIC]);
  });

  test('empty env resolves to the fallback', () => {
    expect(parseEndpoints('', PUBLIC, 'test')).toEqual([PUBLIC]);
  });
});

test('redactEndpoint keeps the origin and hides the api key path', () => {
  expect(redactEndpoint(KEYED)).toBe('https://api.example.com/…');
  expect(redactEndpoint(PUBLIC)).toBe('https://fullnode.' + NETWORK + '.sui.io');
  expect(redactEndpoint('not a url')).toBe('(malformed url)');
});

describe('createEndpointRing', () => {
  const list = ['https://a.example', 'https://b.example', 'https://c.example'];

  test('starts on the primary and rotates past a cooling endpoint', () => {
    const ring = createEndpointRing(list, 'test');
    expect(ring.pick()).toBe(0);
    ring.cool(0, 429);
    expect(ring.pick()).toBe(1);
    ring.cool(1, 429);
    expect(ring.pick()).toBe(2);
  });

  test('falls back to the primary when everything is cooling', () => {
    const ring = createEndpointRing(list, 'test');
    list.forEach((_, i) => ring.cool(i, 503));
    expect(ring.pick()).toBe(0);
  });

  test('counts retries and always allows a second attempt on a single endpoint', () => {
    const ring = createEndpointRing(['https://only.example'], 'test');
    expect(ring.attempts).toBe(2);
    ring.cool(0, 'connect');
    ring.cool(0, 'connect');
    expect(ring.count()).toBe(2);
    expect(ring.pick()).toBe(0);
  });

  // The 429 is a per-IP window, so re-sending inside it is a doomed round trip that also deepens the
  // throttle. With one endpoint configured that turned a busy minute into a self-inflicted outage.
  test('next() refuses to re-issue to an endpoint that already answered 429 on this call', () => {
    const ring = createEndpointRing(['https://only.example'], 'test');
    const spent = new Set<number>();
    expect(ring.next(spent)).toBe(0);
    spent.add(0);
    expect(ring.next(spent)).toBeNull();
  });

  test('next() fails over to the healthy endpoint, then gives up', () => {
    const ring = createEndpointRing(list, 'test');
    const spent = new Set<number>([0]);
    expect(ring.next(spent)).toBe(1);
    spent.add(1);
    expect(ring.next(spent)).toBe(2);
    spent.add(2);
    expect(ring.next(spent)).toBeNull();
  });

  test('next() still probes a cooling endpoint rather than stalling every read', () => {
    const ring = createEndpointRing(['https://only.example'], 'test');
    ring.cool(0, 429);
    expect(ring.next(new Set())).toBe(0);
  });
});
