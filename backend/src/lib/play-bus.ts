// In-process event bus for play status transitions, keyed by play id: publishes the instant a status
// write commits, so the play SSE gets pending->open (and settle) in one RTT instead of a poll interval. In-process only works because the mint always runs in the SSE's process; if API/operator ever split, upgrade to Postgres LISTEN/NOTIFY.

import type { Play } from '../../prisma/generated/client.js';

type Listener = (row?: Play) => void;

const listeners = new Map<string, Set<Listener>>();

// Notifies every subscriber of a play id; call strictly AFTER the status write commits, never before, or
// a subscriber pushes a stale row. Pass the committed row to skip a DB read (bulk sweeps omit it and the SSE reads the row itself); fires synchronously, a throwing listener never breaks its siblings.
export function publishPlay(playId: string, row?: Play): void {
  const set = listeners.get(playId);
  if (!set) return;
  for (const cb of [...set]) {
    try {
      cb(row);
    } catch {
      // swallowed: a throwing listener must not break the others
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
