// Play safety: testnet SUI is finite (L-008), so every play clears a per-user rate limit and a
// sponsor-reserve floor that pauses new plays (clear user-facing state) before the gas accumulator empties, auto-resuming once it recovers. A cron monitor logs burn rate.

import cron from 'node-cron';

import {
  PLAY_GAS_BUDGET,
  PLAY_RATE_LIMIT_MS,
  PLAY_RATE_BURST,
  SPONSOR_FLOOR_SUI,
  SPONSOR_BURN_WARN_SUI,
  SPONSOR_MONITOR_CRON,
} from '../../config/main-config.ts';
import { suiClient } from './client.ts';
import { SPONSOR_ENABLED, sponsorAddress } from './sponsor.ts';
import { cronIntervalMs, recordRun, registerWorker } from '../worker-registry.ts';

const SUI_TYPE = '0x2::sui::SUI';
const MIST_PER_SUI = 1_000_000_000;

// === Per-user rate limit (token bucket) ===
// Range V2 stacks several positions in quick succession, so a hard "one at a time" cooldown 429s legit play.
// A per-user token bucket lets a burst of PLAY_RATE_BURST plays through, then refills one slot per
// PLAY_RATE_LIMIT_MS. A sustained spammer is still capped at the same long-run rate; normal stacking never blocks.
type Bucket = { tokens: number; at: number };
const buckets = new Map<string, Bucket>();

// Credits any slots earned since the last touch, capped at the bucket depth. `at` tracks the last accounted
// instant, carrying the sub-interval remainder so refills don't drift; a full bucket resets it to now.
function refill(userId: string): Bucket {
  const cap = Math.max(1, PLAY_RATE_BURST);
  const now = Date.now();
  const b = buckets.get(userId) ?? { tokens: cap, at: now };
  if (PLAY_RATE_LIMIT_MS <= 0) {
    b.tokens = cap;
    b.at = now;
  } else {
    const gained = Math.floor((now - b.at) / PLAY_RATE_LIMIT_MS);
    if (gained > 0) {
      b.tokens = Math.min(cap, b.tokens + gained);
      b.at = b.tokens >= cap ? now : b.at + gained * PLAY_RATE_LIMIT_MS;
    }
  }
  buckets.set(userId, b);
  return b;
}

// A block reason the play path turns into a PlayError. null = allowed.
export type PlayBlock = { code: 'PLAYS_PAUSED' | 'RATE_LIMITED'; message: string; retryAfterMs?: number };

// Gates a play. Checks the sponsor pause first (blocks everyone), then the caller's own bucket.
// Does NOT spend a token, so call recordPlay once the play is accepted.
export function checkPlayAllowed(userId: string): PlayBlock | null {
  if (pauseState.paused) {
    return { code: 'PLAYS_PAUSED', message: 'Plays are paused while we top up gas. Back in a moment.' };
  }
  if (PLAY_RATE_LIMIT_MS > 0) {
    const b = refill(userId);
    if (b.tokens < 1) {
      const retryAfterMs = Math.max(0, b.at + PLAY_RATE_LIMIT_MS - Date.now());
      return { code: 'RATE_LIMITED', message: `Slow down a touch. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`, retryAfterMs };
    }
  }
  return null;
}

// Spends a token the moment a play passes the gate, so a rapid burst can't slip past the depth before the
// mints land (no-op when the limit is off). Check + record run synchronously and adjacent, so no interleave.
export function recordPlay(userId: string): void {
  if (PLAY_RATE_LIMIT_MS <= 0) return;
  const b = refill(userId);
  b.tokens = Math.max(0, b.tokens - 1);
}

// Refunds a token when a play fails BEFORE it is accepted, so a doomed attempt (bad params / no market)
// never eats a slot the user could have spent on a real play.
export function clearPlay(userId: string): void {
  if (PLAY_RATE_LIMIT_MS <= 0) return;
  const b = buckets.get(userId);
  if (!b) return;
  b.tokens = Math.min(Math.max(1, PLAY_RATE_BURST), b.tokens + 1);
}

// === Sponsor reserve floor -> pause ===

// The sponsor pays gas from an unreadable SUI address-balance accumulator, refilled from its OWNED coins
// (sponsor.ts) which ARE readable, so the floor watches those instead, pausing plays BEFORE the accumulator empties. Testnet reserve is topped up by a human, the monitor just resumes once it sees SUI.

type PauseState = { paused: boolean; reason: string; reserveSui: number; checkedAt: number };
const pauseState: PauseState = { paused: false, reason: '', reserveSui: 0, checkedAt: 0 };

export function sponsorPaused(): { paused: boolean; reason: string } {
  return { paused: pauseState.paused, reason: pauseState.reason };
}

let lastReserveSui: number | null = null;

async function readSponsorReserveSui(): Promise<number> {
  const bal = await suiClient.getBalance({ owner: sponsorAddress, coinType: SUI_TYPE });
  return Number(BigInt(bal.balance.balance)) / MIST_PER_SUI;
}

// Re-reads the sponsor's readable SUI reserve, flips the pause state on the floor, and logs burn since the
// last successful read. Errors leave the prior state untouched, so a transient RPC blip never pauses plays.
export async function refreshSponsorPauseState(): Promise<void> {
  if (!SPONSOR_ENABLED || !sponsorAddress) return;
  let reserveSui: number;
  try {
    reserveSui = await readSponsorReserveSui();
  } catch (e) {
    console.warn('[play-safety] sponsor balance read failed, keeping prior pause state:', e instanceof Error ? e.message : e);
    return;
  }
  pauseState.reserveSui = reserveSui;
  pauseState.checkedAt = Date.now();

  // Burn since the last successful read (positive = spent). A human top-up shows as negative, ignore it.
  if (lastReserveSui != null) {
    const burn = lastReserveSui - reserveSui;
    if (burn >= SPONSOR_BURN_WARN_SUI) {
      console.warn(`[play-safety] sponsor burned ${burn.toFixed(3)} SUI since last check (reserve now ${reserveSui.toFixed(3)} SUI)`);
    }
  }
  lastReserveSui = reserveSui;

  // The effective floor is never below one play's upfront gas reservation: below PLAY_GAS_BUDGET every
  // sponsored tx fails "Invalid withdraw reservation" outright, which must surface as the pause, not raw errors.
  const floorSui = Math.max(SPONSOR_FLOOR_SUI, Number(PLAY_GAS_BUDGET) / MIST_PER_SUI);
  const shouldPause = reserveSui < floorSui;
  if (shouldPause && !pauseState.paused) {
    pauseState.paused = true;
    pauseState.reason = `sponsor reserve ${reserveSui.toFixed(3)} SUI below floor ${floorSui} SUI`;
    console.warn(`[play-safety] PAUSING new plays: ${pauseState.reason}. Fund ${sponsorAddress} with testnet SUI to resume.`);
  } else if (!shouldPause && pauseState.paused) {
    pauseState.paused = false;
    pauseState.reason = '';
    console.log(`[play-safety] RESUMING plays: sponsor reserve recovered to ${reserveSui.toFixed(3)} SUI`);
  }
}

// Schedules the reserve monitor (sponsorship only); a first read runs immediately so the pause state is correct before the first play.
export function startSponsorMonitor(): void {
  if (!SPONSOR_ENABLED) return;
  console.log(`[play-safety] sponsor reserve monitor scheduled (${SPONSOR_MONITOR_CRON}, floor ${SPONSOR_FLOOR_SUI} SUI)`);
  const task = cron.schedule(SPONSOR_MONITOR_CRON, async () => {
    const startedAt = Date.now();
    // refreshSponsorPauseState swallows its own errors, so a run here is always a healthy heartbeat.
    await refreshSponsorPauseState();
    recordRun('sponsor-monitor', true, Date.now() - startedAt);
  });
  registerWorker('sponsor-monitor', task, cronIntervalMs(SPONSOR_MONITOR_CRON));
  void refreshSponsorPauseState();
}
