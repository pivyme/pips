// Real-mode (testnet) play safety: testnet SUI is finite (L-008), so every play clears a per-user rate limit
// and a sponsor-reserve floor that pauses new plays (clear user-facing state) before the gas accumulator empties, auto-resuming once it recovers. Both gates no-op off testnet; a cron monitor logs burn rate.

import cron from 'node-cron';

import {
  IS_REAL_PREDICT,
  PLAY_RATE_LIMIT_MS,
  SPONSOR_FLOOR_SUI,
  SPONSOR_BURN_WARN_SUI,
  SPONSOR_MONITOR_CRON,
} from '../../config/main-config.ts';
import { suiClient } from './client.ts';
import { SPONSOR_ENABLED, sponsorAddress } from './sponsor.ts';
import { cronIntervalMs, recordRun, registerWorker } from '../worker-registry.ts';

const SUI_TYPE = '0x2::sui::SUI';
const MIST_PER_SUI = 1_000_000_000;

// === Per-user rate limit ===

const lastPlayAt = new Map<string, number>();

// A block reason the play path turns into a PlayError. null = allowed.
export type PlayBlock = { code: 'PLAYS_PAUSED' | 'RATE_LIMITED'; message: string; retryAfterMs?: number };

// Gates a play; real mode only, fork mode always allows. Checks the sponsor pause first (blocks everyone),
// then the caller's own cooldown. Does NOT stamp the cooldown, so call recordPlay once the play is accepted.
export function checkPlayAllowed(userId: string): PlayBlock | null {
  if (!IS_REAL_PREDICT) return null;
  if (pauseState.paused) {
    return { code: 'PLAYS_PAUSED', message: 'Plays are paused while we top up gas. Back in a moment.' };
  }
  if (PLAY_RATE_LIMIT_MS > 0) {
    const since = Date.now() - (lastPlayAt.get(userId) ?? 0);
    if (since < PLAY_RATE_LIMIT_MS) {
      const retryAfterMs = PLAY_RATE_LIMIT_MS - since;
      return { code: 'RATE_LIMITED', message: `One play at a time. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`, retryAfterMs };
    }
  }
  return null;
}

// Reserves the user's cooldown slot the moment a play passes the gate, so a rapid double-tap can't slip two plays past the check before either lands (no-op in fork mode or when the limit is off).
export function recordPlay(userId: string): void {
  if (!IS_REAL_PREDICT || PLAY_RATE_LIMIT_MS <= 0) return;
  lastPlayAt.set(userId, Date.now());
}

// Releases a reserved slot when the play fails BEFORE it is accepted, so the user can retry immediately instead of eating a cooldown for a play that never happened.
export function clearPlay(userId: string): void {
  lastPlayAt.delete(userId);
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
  if (!IS_REAL_PREDICT || !SPONSOR_ENABLED || !sponsorAddress) return;
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

  const shouldPause = reserveSui < SPONSOR_FLOOR_SUI;
  if (shouldPause && !pauseState.paused) {
    pauseState.paused = true;
    pauseState.reason = `sponsor reserve ${reserveSui.toFixed(3)} SUI below floor ${SPONSOR_FLOOR_SUI} SUI`;
    console.warn(`[play-safety] PAUSING new plays: ${pauseState.reason}. Fund ${sponsorAddress} with testnet SUI to resume.`);
  } else if (!shouldPause && pauseState.paused) {
    pauseState.paused = false;
    pauseState.reason = '';
    console.log(`[play-safety] RESUMING plays: sponsor reserve recovered to ${reserveSui.toFixed(3)} SUI`);
  }
}

// Schedules the reserve monitor (real mode + sponsorship only); a first read runs immediately so the pause state is correct before the first play.
export function startSponsorMonitor(): void {
  if (!IS_REAL_PREDICT || !SPONSOR_ENABLED) return;
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
