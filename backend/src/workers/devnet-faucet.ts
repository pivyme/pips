// Devnet faucet top-up. On Sui devnet the public faucet is the only SUI source, and devnet gets
// wiped roughly weekly, so the crucial wallets run dry and break plays/redeems/payouts. This worker
// is the self-healing safety net: every few minutes it reads each wallet's balance and faucets ONLY
// the ones below the floor, so it respects the faucet's per-IP rate limit and never spams a wallet
// that's already funded. It also keeps any extra addresses topped up (defaults to the owner's
// personal address). Devnet only: no-op on localnet / mainnet / testnet.
//
// Note: this refills SUI, it cannot fix a devnet wipe (the Predict packages vanish too). After a wipe,
// re-run scripts/devnet-refresh.sh to republish; this worker keeps the wallets alive between wipes.

import cron from 'node-cron';
import { getFaucetHost, requestSuiFromFaucetV2 } from '@mysten/sui/faucet';

import {
  SUI_NETWORK,
  DEVNET_FAUCET_ENABLED,
  DEVNET_FAUCET_MIN_SUI,
  DEVNET_FAUCET_CRON,
  DEVNET_FAUCET_EXTRA,
} from '../config/main-config.ts';
import { suiClient } from '../lib/sui/client.ts';
import { operatorAddress, settlementAddress, treasuryAddress } from '../lib/sui/signer.ts';
import { sponsorAddress } from '../lib/sui/sponsor.ts';

const MIN_MIST = BigInt(Math.round(DEVNET_FAUCET_MIN_SUI * 1e9));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
    return BigInt((await suiClient.getBalance({ owner })).totalBalance);
  } catch {
    return -1n; // read failed: skip this one rather than faucet blindly
  }
};

// v2 endpoint, with the v1 /gas fallback the bootstrap also uses.
const requestFaucet = async (recipient: string): Promise<void> => {
  const host = getFaucetHost('devnet');
  try {
    await requestSuiFromFaucetV2({ host, recipient });
  } catch {
    await fetch(`${host}/gas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ FixedAmountRequest: { recipient } }),
    });
  }
};

let isRunning = false;

const tick = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;
  try {
    for (const t of targets()) {
      const bal = await balanceMist(t.address);
      if (bal < 0n || bal >= MIN_MIST) continue; // unknown or already funded
      try {
        await requestFaucet(t.address);
        console.log(`[devnet-faucet] topped up ${t.label} ${t.address.slice(0, 10)}… (was ${Number(bal) / 1e9} SUI)`);
      } catch (e) {
        console.warn(`[devnet-faucet] faucet failed for ${t.label}:`, e instanceof Error ? e.message : e);
      }
      await sleep(2000); // space requests so the per-IP limiter stays happy
    }
  } catch (e) {
    console.warn('[devnet-faucet] tick error:', e instanceof Error ? e.message : e);
  } finally {
    isRunning = false;
  }
};

export const startDevnetFaucet = (): void => {
  if (SUI_NETWORK !== 'devnet' || !DEVNET_FAUCET_ENABLED) return; // faucet only exists on devnet
  console.log(
    `[devnet-faucet] Scheduled: ${DEVNET_FAUCET_CRON} (keeps ${targets().map((t) => t.label).join(', ')} >= ${DEVNET_FAUCET_MIN_SUI} SUI)`,
  );
  cron.schedule(DEVNET_FAUCET_CRON, tick);
  tick(); // run once on boot so dry wallets recover immediately
};
