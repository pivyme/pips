// The spendable-balance policy behind /auth/me: wallet DUSDC + the wrapper's internal chips, and what to
// report when one of those two chain reads fails.
//
// It lives here rather than in services/auth.ts for two reasons: it is pure (no IO, so it tests without
// mocking the chain), and auth.ts is wholesale-replaced by a mock in analyticsRoutes.test.ts, which would
// take any export of it down with it.

import { isChainUnavailableError } from './client.ts';

// Last good total per address. The fullnode rate-limits us under load, and a throwing balance read used to
// 500 all of /me ("Could not load profile" mid-session), so we serve the last known number instead.
// Bounded by age, because a stale balance shown forever is its own kind of wrong.
const lastSpendable = new Map<string, { raw: bigint; at: number }>();
const STALE_MAX_MS = 120_000;
const CACHE_MAX = 5_000;

// A wrapper that is genuinely gone reads as 0 chips (nobody has played yet, or it was re-derived out from
// under us). Any other failure is transient, and there we fall back to the last known total rather than
// invent a 0, which to the user reads as "your money vanished".
export function resolveSpendable(
  address: string,
  wallet: PromiseSettledResult<bigint>,
  manager: PromiseSettledResult<bigint>,
): bigint {
  const chips = manager.status === 'fulfilled' ? manager.value : isChainUnavailableError(manager.reason) ? 0n : null;

  if (wallet.status === 'fulfilled' && chips !== null) {
    const raw = wallet.value + chips;
    if (lastSpendable.size >= CACHE_MAX) lastSpendable.clear();
    lastSpendable.set(address, { raw, at: Date.now() });
    return raw;
  }

  const known = lastSpendable.get(address);
  if (known && Date.now() - known.at < STALE_MAX_MS) return known.raw;

  const failure = wallet.status === 'rejected' ? wallet.reason : manager.status === 'rejected' ? manager.reason : null;
  throw failure ?? new Error('balance read failed');
}
