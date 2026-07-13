// Real-mode (testnet) play safety layer. Testnet SUI is finite and the DUSDC treasury is hand-funded
// (L-008), so a real-mode play clears two gates before it ever touches the chain:
//   1. a per-user rate limit (in-memory cooldown, anti-burn), and
//   2. a sponsor-reserve floor: when the gas sponsor's readable SUI reserve is too low to keep
//      refilling its gas accumulator, new plays PAUSE with a clear user-facing state instead of
//      hard-failing mid-mint, and auto-resume once the reserve recovers.
// Both gates are no-ops off testnet (the fork's localnet/devnet has free, effectively infinite SUI),
// so fork behavior is unchanged. A background monitor re-reads the reserve on a cron and logs burn rate.

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

const SUI_TYPE = '0x2::sui::SUI';
const MIST_PER_SUI = 1_000_000_000;

// === Per-user rate limit ===

const lastPlayAt = new Map<string, number>();

// A block reason the play path turns into a PlayError. null = allowed.
export type PlayBlock = { code: 'PLAYS_PAUSED' | 'RATE_LIMITED'; message: string; retryAfterMs?: number };

// Gate a play. Real mode only; fork mode always allows (free localnet). Checks the sponsor pause first
// (a paused sponsor blocks everyone) then the caller's own cooldown. Does NOT stamp the cooldown, so a
// blocked attempt never starts the clock; call recordPlay once the play is accepted.
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

// Reserve the user's cooldown slot the moment a play passes the gate, so a rapid double-tap can't slip
// two plays past the check before either lands. No-op in fork mode / when the limit is off.
export function recordPlay(userId: string): void {
  if (!IS_REAL_PREDICT || PLAY_RATE_LIMIT_MS <= 0) return;
  lastPlayAt.set(userId, Date.now());
}

// Release a reserved slot when the play fails BEFORE it is accepted (bad params, no market), so the
// user can retry immediately instead of eating a cooldown for a play that never happened.
export function clearPlay(userId: string): void {
  lastPlayAt.delete(userId);
}

// === Sponsor reserve floor -> pause ===
//
// The sponsor pays gas from its SUI address-balance accumulator (unreadable over RPC), which is
// refilled from its OWNED SUI coins (sponsor.ts). Those owned coins ARE readable and are the reserve
// that backstops the accumulator, so the floor watches them: once they run below SPONSOR_FLOOR_SUI the
// sponsor can no longer refill, so we pause BEFORE a play hard-fails on an empty accumulator. On
// testnet the reserve is topped up by a human (no faucet), so the monitor just resumes when it sees SUI.

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

// Re-read the sponsor's readable SUI reserve, flip the pause state on the floor, and log burn since the
// last successful read. Errors leave the prior state untouched (a transient RPC blip must not pause
// plays). No-op when sponsorship is off or off testnet.
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

// Schedule the reserve monitor. Real mode + sponsorship only; a first read runs immediately so the
// pause state is correct before the first play. No-op otherwise (fork localnet has free SUI).
export function startSponsorMonitor(): void {
  if (!IS_REAL_PREDICT || !SPONSOR_ENABLED) return;
  console.log(`[play-safety] sponsor reserve monitor scheduled (${SPONSOR_MONITOR_CRON}, floor ${SPONSOR_FLOOR_SUI} SUI)`);
  cron.schedule(SPONSOR_MONITOR_CRON, () => {
    void refreshSponsorPauseState();
  });
  void refreshSponsorPauseState();
}
