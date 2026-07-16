// Devnet faucet top-up. On Sui devnet the public faucet is the only SUI source, and devnet gets
// wiped roughly weekly, so the crucial wallets run dry and break plays/redeems/payouts. This worker
// is the self-healing safety net: every minute it reads each wallet's balance and, for any below the
// floor, faucets it back up to the target. It VERIFIES each drip actually landed by re-reading the
// balance, because the public devnet faucet silently rate-limits (returns 200 but sends nothing),
// which is what used to wedge the operator below its 1 SUI gas budget while we logged a false
// "topped up". When the real balance stops moving it stops requesting and warns, instead of lying.
//
// For a rock-stable operator, point DEVNET_FAUCET_URL at a no-rate-limit faucet (set the env). The
// loop-to-target then keeps the operator far above its gas budget so it never starves between drips.
//
// Note: this refills SUI, it cannot fix a devnet wipe (the Predict packages vanish too). After a wipe,
// re-run scripts/devnet-refresh.sh to republish; this worker keeps the wallets alive between wipes.

import cron from 'node-cron';
import { getFaucetHost, requestSuiFromFaucetV2 } from '@mysten/sui/faucet';

import {
  SUI_NETWORK,
  DEVNET_FAUCET_ENABLED,
  DEVNET_FAUCET_URL,
  DEVNET_FAUCET_MIN_SUI,
  DEVNET_FAUCET_TARGET_SUI,
  DEVNET_FAUCET_BATCH,
  DEVNET_FAUCET_MAX_REQUESTS,
  DEVNET_FAUCET_GAP_MS,
  DEVNET_FAUCET_CRON,
  DEVNET_FAUCET_EXTRA,
} from '../config/main-config.ts';
import { suiClient } from '../lib/sui/client.ts';
import { operatorAddress, settlementAddress, treasuryAddress } from '../lib/sui/signer.ts';
import { sponsorAddress } from '../lib/sui/sponsor.ts';
import { cronIntervalMs, recordRun, registerWorker } from '../lib/worker-registry.ts';

const MIN_MIST = BigInt(Math.round(DEVNET_FAUCET_MIN_SUI * 1e9));
// Never let the target sit below the floor (a misconfig would otherwise loop forever).
const TARGET_MIST = BigInt(Math.round(Math.max(DEVNET_FAUCET_TARGET_SUI, DEVNET_FAUCET_MIN_SUI) * 1e9));
const FAUCET_HOST = DEVNET_FAUCET_URL || getFaucetHost('devnet');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sui = (mist: bigint): string => (Number(mist) / 1e9).toFixed(3);

// The wallets to keep alive, de-duped (an unset ops wallet falls back to the operator address, so
// they can collide) and filtered to those actually configured.
function targets(): { label: string; address: string }[] {
  const list = [
    { label: 'operator', address: operatorAddress },
    { label: 'settlement', address: settlementAddress },
    { label: 'treasury', address: treasuryAddress },
    { label: 'sponsor', address: sponsorAddress },
    ...DEVNET_FAUCET_EXTRA.map((address, i) => ({ label: `extra${i + 1}`, address })),
  ].filter((t) => t.address.startsWith('0x'));
  const seen = new Set<string>();
  return list.filter((t) => (seen.has(t.address) ? false : (seen.add(t.address), true)));
}

const balanceMist = async (owner: string): Promise<bigint> => {
  try {
    return BigInt((await suiClient.getBalance({ owner })).balance.balance);
  } catch {
    return -1n; // read failed: skip this one rather than faucet blindly
  }
};

// One faucet drip. v2 endpoint, with the v1 /gas fallback the bootstrap also uses. Throws on a
// hard failure so the caller can stop hammering a rate-limited host.
const requestFaucet = async (recipient: string): Promise<void> => {
  try {
    await requestSuiFromFaucetV2({ host: FAUCET_HOST, recipient });
  } catch {
    const res = await fetch(`${FAUCET_HOST}/gas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ FixedAmountRequest: { recipient } }),
    });
    if (!res.ok) throw new Error(`faucet ${res.status}`);
  }
};

// Faucet `t` back up to the target, firing requests in parallel batches so a high target fills in
// seconds. After each batch we re-read the real balance: if it didn't move at all (the host accepted
// the requests but delivered nothing, i.e. rate-limited or dry) we back off rather than spin. Returns
// the final balance so the caller can flag a wallet still stuck below its floor.
const fundToTarget = async (t: { label: string; address: string }, start: bigint): Promise<bigint> => {
  let bal = start;
  let delivered = 0n;
  let sent = 0;
  while (bal < TARGET_MIST && sent < DEVNET_FAUCET_MAX_REQUESTS) {
    const batch = Math.min(DEVNET_FAUCET_BATCH, DEVNET_FAUCET_MAX_REQUESTS - sent);
    const results = await Promise.allSettled(
      Array.from({ length: batch }, () => requestFaucet(t.address)),
    );
    sent += batch;
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    if (ok === 0) {
      const why = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
      console.warn(`[devnet-faucet] ${t.label} batch fully rejected (${why?.reason instanceof Error ? why.reason.message : why?.reason}), backing off`);
      break;
    }
    await sleep(DEVNET_FAUCET_GAP_MS); // let the drips land before re-reading
    const after = await balanceMist(t.address);
    if (after < 0n) break; // read failed, try again next tick
    if (after <= bal) {
      // Requests were accepted but no SUI arrived: the host is rate-limiting or dry. Don't keep going.
      console.warn(`[devnet-faucet] ${t.label} batch delivered nothing (still ${sui(bal)} SUI), backing off`);
      break;
    }
    delivered += after - bal;
    bal = after;
  }
  if (delivered > 0n) {
    console.log(`[devnet-faucet] ${t.label} ${t.address.slice(0, 10)}… +${sui(delivered)} -> ${sui(bal)} SUI (${sent} req)`);
  }
  if (bal < MIN_MIST) {
    console.warn(`[devnet-faucet] ${t.label} STILL below floor at ${sui(bal)} SUI (host ${FAUCET_HOST} may be rate-limited; set PIPS_DEVNET_FAUCET_URL)`);
  }
  return bal;
};

let isRunning = false;

const tick = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;
  const startedAt = Date.now();
  let runErr: unknown = null;
  try {
    for (const t of targets()) {
      const bal = await balanceMist(t.address);
      if (bal < 0n || bal >= MIN_MIST) continue; // unknown or already funded
      await fundToTarget(t, bal);
    }
  } catch (e) {
    runErr = e;
    console.warn('[devnet-faucet] tick error:', e instanceof Error ? e.message : e);
  } finally {
    isRunning = false;
    recordRun('devnet-faucet', !runErr, Date.now() - startedAt, runErr);
  }
};

export const startDevnetFaucet = (): void => {
  if (SUI_NETWORK !== 'devnet' || !DEVNET_FAUCET_ENABLED) return; // faucet only exists on devnet
  console.log(
    `[devnet-faucet] Scheduled: ${DEVNET_FAUCET_CRON} via ${FAUCET_HOST} (keeps ${targets().map((t) => t.label).join(', ')} >= ${DEVNET_FAUCET_MIN_SUI} SUI, tops to ${DEVNET_FAUCET_TARGET_SUI})`,
  );
  const task = cron.schedule(DEVNET_FAUCET_CRON, tick);
  registerWorker('devnet-faucet', task, cronIntervalMs(DEVNET_FAUCET_CRON));
  tick(); // run once on boot so dry wallets recover immediately
};
