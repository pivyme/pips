// Postgres session-level advisory lock so at most ONE instance ever acts as the fund-moving operator,
// even if PIPS_OPERATOR_ENABLED is misconfigured true on two instances against the same shared DB.
// Without it, two "operators" would double-push oracles / double-settle / double-fund and could
// double-spend. This turns that config mistake into a safe no-op: the loser stays a plain follower.
//
// Held on a DEDICATED pg connection for the process lifetime. A session advisory lock is bound to the
// exact connection that took it, so routing this through the pooled Prisma adapter would let the pool
// hand that connection back and silently drop the lock underneath us. pg_try_advisory_lock is
// non-blocking: it returns false at once if another instance holds it, so a misconfig never hangs boot.
//
// Fund-moving operator work (price-pusher, oracle-roll, ops-funding, the settle Phase-1 oracle nudge)
// gates on isOperatorLeader() instead of OPERATOR_ENABLED alone. Everything else (the API, follower
// market discovery, follower settle finalize) runs regardless, so a lock-losing operator instance
// degrades to a fully functional follower rather than going dark.

import { Client } from 'pg';

import { DATABASE_URL, OPERATOR_ENABLED } from '../config/main-config.ts';
import { alert } from './alert.ts';

// hashtext(...) maps the lock name to the bigint key pg_try_advisory_lock wants; the exact number is
// irrelevant, it only has to be identical across every instance sharing this DB.
const LOCK_EXPR = "hashtext('pips_operator_lock')";

let client: Client | null = null;
let held = false;

// True only when this instance is BOTH configured as the operator AND actually holds the advisory lock.
// Read synchronously by the operator workers at start(); acquireLeaderLock() must have resolved first
// (app.ts awaits it at boot before starting any worker).
export function isOperatorLeader(): boolean {
  return OPERATOR_ENABLED && held;
}

// Attempt to become the operator leader. No-op (returns false) unless OPERATOR_ENABLED. Never throws:
// on a conflict or any DB error it logs and stays a follower, so a lock problem can never crash boot or
// leave the app half-up. Call once at boot after the DB readiness ping, before starting workers.
export async function acquireLeaderLock(): Promise<boolean> {
  if (!OPERATOR_ENABLED) return false;
  if (held) return true;
  try {
    const c = new Client({ connectionString: DATABASE_URL });
    await c.connect();
    const res = await c.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(${LOCK_EXPR}) AS locked`);
    if (res.rows[0]?.locked === true) {
      client = c;
      held = true;
      console.log('[leader-lock] acquired operator advisory lock; this instance is the operator leader');
      return true;
    }
    // Another instance already holds it: stay a follower despite PIPS_OPERATOR_ENABLED=true.
    await c.end().catch(() => {});
    console.warn(
      '[leader-lock] another operator instance already holds the lock; this instance stays a FOLLOWER despite PIPS_OPERATOR_ENABLED=true (no oracle/price/settle-nudge/funding writes here)',
    );
    // Fires once per boot (dedupe covers the rest): a genuine two-operator misconfig is worth a ping so a
    // human can fix the duplicate before an intended operator sits idle behind the wrong instance.
    alert('warn', 'operator leader-lock already held by another instance; this instance stays a follower despite OPERATOR_ENABLED=true');
    return false;
  } catch (e) {
    // Could not determine leadership (connection/query error). Fail safe: no operator writes, so a DB
    // hiccup can never turn into a double-run. The single genuine operator retries on the next boot.
    console.error('[leader-lock] could not acquire advisory lock, staying a FOLLOWER (no operator writes):', e instanceof Error ? e.message : e);
    return false;
  }
}

// Release the lock + close the dedicated connection on graceful shutdown, so a rolling deploy's fresh
// instance can take leadership immediately instead of waiting for this connection to time out on the
// server. The lock also releases automatically when the connection closes on process exit; this is the
// clean-handoff path. Never throws.
export async function releaseLeaderLock(): Promise<void> {
  const c = client;
  if (!c) return;
  client = null;
  held = false;
  try {
    await c.query(`SELECT pg_advisory_unlock(${LOCK_EXPR})`);
  } catch {
    // Connection may already be torn down; the DB reclaims the session lock when the connection closes.
  }
  await c.end().catch(() => {});
}
