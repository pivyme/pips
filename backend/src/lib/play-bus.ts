// In-process event bus for play status transitions, keyed by play id. The play lifecycle publishes the
// instant a status write commits (mint open/error, cash-out, settle) and the play SSE subscribes to its
// id, so pending->open (and the settle reveal) land in one RTT instead of waiting out a poll interval.
//
// The publisher hands the freshly committed row through the bus, so the SSE pushes it straight to the
// socket with NO database round trip on the hot path (the whole point is speed; a re-read would add a
// remote-DB RTT to every detection). A publish that carries no row (a bulk sweep that has no single row
// cheaply in hand) still fires; the SSE falls back to reading the one row itself.
//
// In-process only, and that is fine (TRADE_REALTIME.md §6): the background mint always runs in the same
// process as the client's SSE, so the entry push, the whole point, is always instant. On the deployed
// single box the settle worker is also in-process (instant settle push); a split local-dev topology
// (local follower + deployed operator) simply falls back to the SSE's own safety-poll cadence, exactly
// like before. If API and operator are ever split in prod, upgrade this to Postgres LISTEN/NOTIFY.

import type { Play } from '../../prisma/generated/client.js';

type Listener = (row?: Play) => void;

const listeners = new Map<string, Set<Listener>>();

// Notify every subscriber of a play id. Call strictly AFTER the status write commits, never before, or a
// subscriber pushes a stale row. Pass the committed row so the SSE skips a DB read; omit it (bulk sweeps)
// and the SSE reads the row itself. Fires synchronously; listeners are cheap (they schedule an async
// send) and a throwing listener never breaks the publisher or its siblings.
export function publishPlay(playId: string, row?: Play): void {
  const set = listeners.get(playId);
  if (!set) return;
  for (const cb of [...set]) {
    try {
      cb(row);
    } catch {
      // A listener must never take down the publisher or the other listeners.
    }
  }
}

// Subscribe to a play id. Returns an unsubscribe; call it on socket close or the listener set leaks.
export function onPlay(playId: string, cb: Listener): () => void {
  let set = listeners.get(playId);
  if (!set) {
    set = new Set();
    listeners.set(playId, set);
  }
  set.add(cb);
  return () => {
    const s = listeners.get(playId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) listeners.delete(playId);
  };
}
