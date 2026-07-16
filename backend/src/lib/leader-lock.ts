// Postgres advisory lock so at most ONE instance ever acts as the fund-moving operator, even if
// PIPS_OPERATOR_ENABLED is misconfigured true on two instances sharing a DB (else double-push/settle/spend).

// Held on a DEDICATED pg connection for the process lifetime: a session advisory lock is bound to its exact
// connection, so the pooled Prisma adapter would silently hand it back and drop it underneath us.

// Fund-moving operator work (price-pusher, oracle-roll, ops-funding, the settle Phase-1 oracle nudge) gates
// on isOperatorLeader(); everything else runs regardless, so a lock-losing instance degrades to a follower.

import { Client } from 'pg';

import { DATABASE_URL, OPERATOR_ENABLED } from '../config/main-config.ts';
import { alert } from './alert.ts';

// hashtext(...) maps the lock name to the bigint key pg_try_advisory_lock wants; the exact number is
// irrelevant as long as it's identical across every instance sharing this DB.
const LOCK_EXPR = "hashtext('pips_operator_lock')";

let client: Client | null = null;
let held = false;

// True only when this instance is BOTH configured as the operator AND holds the advisory lock. Read
// synchronously by workers at start(); acquireLeaderLock() must resolve first (app.ts awaits it at boot).
export function isOperatorLeader(): boolean {
  return OPERATOR_ENABLED && held;
}

// Attempt to become operator leader; no-op (returns false) unless OPERATOR_ENABLED. Never throws, a conflict
// or DB error just logs and stays a follower. Call once at boot, after the DB readiness ping, before workers.
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
    // Fires once per boot: a genuine two-operator misconfig is worth a ping so a human can fix it before
    // an intended operator sits idle behind the wrong instance.
    alert('warn', 'operator leader-lock already held by another instance; this instance stays a follower despite OPERATOR_ENABLED=true');
    return false;
  } catch (e) {
    // Could not determine leadership; fail safe with no operator writes so a DB hiccup can't cause a
    // double-run. The genuine operator retries on the next boot.
    console.error('[leader-lock] could not acquire advisory lock, staying a FOLLOWER (no operator writes):', e instanceof Error ? e.message : e);
    return false;
  }
}

// Releases the lock and closes the dedicated connection on graceful shutdown, so a rolling deploy's fresh
// instance can take leadership immediately instead of waiting on a timeout. Never throws.
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
