// The spendable-balance policy behind /auth/me: wallet DUSDC + the wrapper's internal chips, how often we
// re-read the chain for it, and what to report when one of those two reads fails.
//
// It lives here rather than in services/auth.ts for two reasons: the chain reads are injected (so it tests
// without mocking the chain), and auth.ts is wholesale-replaced by a mock in analyticsRoutes.test.ts, which
// would take any export of it down with it.

import { isChainUnavailableError } from './client.ts';

/** `stale` means the number is a last-known total, not a fresh read, so the client keeps what it has. */
export type Spendable = { raw: bigint; stale: boolean };

// Last good total per user. The fullnode rate-limits us under load, and a throwing balance read used to
// 500 all of /me ("Could not load profile" mid-session), so we serve the last known number instead.
// Bounded by age, because a stale balance shown forever is its own kind of wrong.
const lastSpendable = new Map<string, { raw: bigint; at: number; dirty?: boolean }>();
const STALE_MAX_MS = 120_000;
const CACHE_MAX = 5_000;

// A hit this young skips the chain entirely. /me is polled per tab and each call costs two reads, against a
// public fullnode that allows roughly three a second for the whole box. Every event that moves a balance
// (play, cash-out, settle, faucet, withdraw) invalidates, so this only ever collapses redundant polls.
const FRESH_MS = 5_000;

// One read in flight per user: concurrent /me calls share it instead of each opening their own pair.
const inflight = new Map<string, Promise<Spendable>>();

function remember(key: string, raw: bigint): void {
  if (lastSpendable.size >= CACHE_MAX) lastSpendable.clear();
  lastSpendable.set(key, { raw, at: Date.now() });
}

// Force the next read to hit the chain, without discarding the number: chips just moved, so the cached
// total is out of date, but it is still a better answer than 0 if that read comes back throttled.
export function invalidateSpendable(key: string): void {
  const known = lastSpendable.get(key);
  if (known) known.dirty = true;
}

// A wrapper that is genuinely gone reads as 0 chips (nobody has played yet, or it was re-derived out from
// under us). Any other failure is transient, and there we fall back to the last known total rather than
// invent a 0, which to the user reads as "your money vanished". Null means we have nothing to show at all.
export function resolveSpendable(
  key: string,
  wallet: PromiseSettledResult<bigint>,
  manager: PromiseSettledResult<bigint>,
): Spendable | null {
  const chips = manager.status === 'fulfilled' ? manager.value : isChainUnavailableError(manager.reason) ? 0n : null;

  if (wallet.status === 'fulfilled' && chips !== null) {
    const raw = wallet.value + chips;
    remember(key, raw);
    return { raw, stale: false };
  }

  const known = lastSpendable.get(key);
  if (known && Date.now() - known.at < STALE_MAX_MS) return { raw: known.raw, stale: true };
  return null;
}

// Read-through balance for every user DTO: cached for FRESH_MS, coalesced while in flight, and never
// throwing. Identity comes from the JWT and the balance is decoration the next poll corrects, so a
// throttled fullnode must not cost someone their session; an unknown balance is reported stale, never as a
// confident 0. The play path reads its own balance and does not come through here.
export async function readSpendable(
  key: string,
  readWallet: () => Promise<bigint>,
  readManager: () => Promise<bigint>,
): Promise<Spendable> {
  const hit = lastSpendable.get(key);
  if (hit && !hit.dirty && Date.now() - hit.at < FRESH_MS) return { raw: hit.raw, stale: false };

  const running = inflight.get(key);
  if (running) return running;

  const pending = (async (): Promise<Spendable> => {
    const [wallet, manager] = await Promise.allSettled([readWallet(), readManager()]);
    return resolveSpendable(key, wallet, manager) ?? { raw: 0n, stale: true };
  })().finally(() => inflight.delete(key));

  inflight.set(key, pending);
  return pending;
}
