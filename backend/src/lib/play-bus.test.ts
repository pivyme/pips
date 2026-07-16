// Play-bus contract, hermetic (imports only a type, erased at build, no DB/env needed). Locks the
// guarantees the play SSE relies on: publish delivers and carries the row (skips a DB read), unsubscribe frees the id, and a throwing listener never blocks its siblings.

import { describe, expect, it } from 'bun:test';

import type { Play } from '../../prisma/generated/client.js';
import { onPlay, publishPlay } from './play-bus.ts';

describe('play-bus', () => {
  it('delivers a publish to every live subscriber of that id', () => {
    let a = 0;
    let b = 0;
    const unA = onPlay('p1', () => a++);
    const unB = onPlay('p1', () => b++);
    publishPlay('p1');
    expect(a).toBe(1);
    expect(b).toBe(1);
    unA();
    unB();
  });

  it('hands the committed row through to subscribers, or undefined when omitted', () => {
    const got: Array<Play | undefined> = [];
    const un = onPlay('p1', (row) => got.push(row));
    const committed = { id: 'p1', status: 'open' } as Play;
    publishPlay('p1', committed);
    publishPlay('p1'); // a bulk sweep with no row in hand
    expect(got).toEqual([committed, undefined]); // reads straight off the row, else falls back to a DB read
    un();
  });

  it('scopes delivery to the published id only', () => {
    let hit = 0;
    const un = onPlay('p1', () => hit++);
    publishPlay('p2');
    expect(hit).toBe(0);
    publishPlay('p1');
    expect(hit).toBe(1);
    un();
  });

  it('stops delivery after unsubscribe', () => {
    let hit = 0;
    const un = onPlay('p1', () => hit++);
    publishPlay('p1');
    un();
    publishPlay('p1');
    expect(hit).toBe(1); // only the pre-unsub publish landed
  });

  it('is a no-op to publish an id with no subscribers', () => {
    expect(() => publishPlay('never-watched')).not.toThrow();
  });

  it('isolates a throwing listener so the others still fire', () => {
    let good = 0;
    const unBad = onPlay('p1', () => {
      throw new Error('listener blew up');
    });
    const unGood = onPlay('p1', () => good++);
    expect(() => publishPlay('p1')).not.toThrow();
    expect(good).toBe(1);
    unBad();
    unGood();
  });

  it('a listener unsubscribing mid-publish does not corrupt the current fan-out', () => {
    // publishPlay iterates a snapshot, so a listener that unsubscribes itself during delivery is safe.
    let hits = 0;
    let un2: () => void = () => {};
    const un1 = onPlay('p1', () => {
      hits++;
      un2(); // remove the sibling from inside the callback
    });
    un2 = onPlay('p1', () => hits++);
    publishPlay('p1');
    expect(hits).toBe(2); // both still fired this round despite the mid-fan-out removal
    publishPlay('p1');
    expect(hits).toBe(3); // next round: only the surviving listener
    un1();
  });
});
