// oracle-roll: keeps a staggered ladder of oracles alive per asset so a play can always route to
// one expiring ~LUCKY_ROUND_MS out (never one oracle per play, gotcha #11). The oracle's on-chain
// lifetime is decoupled from the round: oracles are created with a full ORACLE_LIFETIME_MS of life
// (so a storage-heavy create + a separate activate never race expiry and abort EOracleExpired) and
// age down through the round point. Each tick adds at most one fresh oracle per asset, spaced
// ~ORACLE_LIFETIME_MS / depth apart in expiry, so the ladder fills evenly across the horizon rather
// than bunching at the far end. Localnet gas is free, so a deeper, longer ladder costs nothing.

import cron from 'node-cron';

import {
  ORACLE_ASSETS,
  ORACLE_LADDER_DEPTH,
  ORACLE_LIFETIME_MS,
  ORACLE_ROLL_MAX_PER_TICK,
  EXPIRY_SAFETY_MS,
  ORACLE_ROLL_CRON,
  OPERATOR_ENABLED,
} from '../config/main-config.ts';
import { gridForSpot, usd1e9 } from '../lib/sui/config.ts';
import { operatorCaps } from '../lib/sui/signer.ts';
import { executeAsOperator } from '../lib/sui/execute.ts';
import { buildActivateOracle, buildCreateOracle } from '../lib/sui/predict.ts';
import { liveByAsset, upsertMarket } from '../lib/sui/markets.ts';
import { gameSpot } from '../lib/game-price.ts';
import { fetchSpot } from '../lib/pyth.ts';
import { Transaction } from '@mysten/sui/transactions';

// How far apart, in expiry, to space fresh oracles so the ladder covers the whole lifetime evenly.
const ORACLE_STEP_MS = Math.max(1000, Math.floor(ORACLE_LIFETIME_MS / ORACLE_LADDER_DEPTH));

// Below this many live oracles an asset's ladder is "starving": the gentle 1-per-tick refill can't
// keep up (a reload empties the cache, a dry spell throws "No markets are live"), so the roller
// bursts multiple fresh oracles in one tick to recover in seconds. Above it, steady-state spacing.
const LADDER_LOW_WATER = Math.max(2, Math.ceil(ORACLE_LADDER_DEPTH / 2));

// Floor on the life of a freshly created oracle. create+activate is two serial operator txs; if the
// oracle expired mid-setup, activate aborts EOracleExpired and the create is wasted. So we never seed
// a near-buzzer slot directly (the near buckets fill by aging instead) — this is the minimum life any
// created oracle gets, with comfortable headroom over the setup time even on a slow node.
const SAFE_CREATE_MIN_LIFE_MS = 28_000;

// The expiry slots a starving ladder should fill, NEAREST first, at ladder spacing across the safe
// horizon, skipping any slot a live oracle already covers. Nearest-first so recovery first lands a
// short-round oracle (a playable market now) and fills the far buckets after.
const nearestUncoveredExpiries = (now: number, live: Array<{ expiryMs: number }>): number[] => {
  const out: number[] = [];
  for (let e = now + SAFE_CREATE_MIN_LIFE_MS; e <= now + ORACLE_LIFETIME_MS; e += ORACLE_STEP_MS) {
    if (!live.some((m) => Math.abs(m.expiryMs - e) < ORACLE_STEP_MS / 2)) out.push(e);
  }
  return out;
};

let isRunning = false;

const findCreatedOracle = (changes: Array<{ type: string; objectId?: string; objectType?: string }>): string => {
  const c = changes.find((x) => x.type === 'created' && x.objectType?.endsWith('::oracle::OracleSVI'));
  if (!c?.objectId) throw new Error('create_oracle returned no OracleSVI object');
  return c.objectId;
};

// Stand up one live oracle for an asset at the given expiry. Two PTBs: create (the oracle
// shares itself inside the call, so its id only exists afterwards) then register+activate+
// seed-SVI+first-price. Returns once it is live and tradeable.
const createOracle = async (asset: string, capId: string, spot: number, expiryMs: number): Promise<void> => {
  const { minStrike, tickSize } = gridForSpot(asset, spot);

  const createTx = new Transaction();
  buildCreateOracle(createTx, capId, asset, expiryMs, minStrike, tickSize);
  const oracleId = findCreatedOracle((await executeAsOperator(createTx, `create_oracle ${asset}`)).objectChanges);

  const liveTx = new Transaction();
  buildActivateOracle(liveTx, oracleId, capId, spot);
  await executeAsOperator(liveTx, `activate ${asset} oracle`);

  upsertMarket({
    oracleId,
    capId,
    underlying: asset,
    expiryMs,
    minStrike: String(minStrike),
    tickSize: String(tickSize),
    settled: false,
    spot1e9: String(usd1e9(spot)),
    lastPushAt: Date.now(),
  });
  console.log(`[OracleRoll] live ${asset} oracle ${oracleId} expiring ${new Date(expiryMs).toISOString()}`);
};

const rollLadder = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;
  try {
    const caps = operatorCaps.oracleCapIds;
    if (caps.length === 0) {
      console.error('[OracleRoll] no oracle cap in config; run the bootstrap first');
      return;
    }

    for (let ai = 0; ai < ORACLE_ASSETS.length; ai++) {
      const asset = ORACLE_ASSETS[ai];
      // Distinct cap per asset so each asset becomes its own price-push lane (one PTB per
      // cap, gotcha #5). Round-robins when the deployment has fewer caps than assets.
      const capId = caps[ai % caps.length];
      const now = Date.now();
      const live = liveByAsset(asset, now, EXPIRY_SAFETY_MS);
      if (live.length >= ORACLE_LADDER_DEPTH) continue; // ladder full

      // In steady state add at most one per tick, and only once the newest live oracle is at least a
      // step old, so fresh oracles land ~ORACLE_STEP_MS apart and the ladder spreads evenly. When the
      // ladder is STARVING (post-reload / dry spell) skip that gate and burst several near-first slots
      // so a playable market is back within a tick or two instead of ~30s of "No markets are live".
      const starving = live.length < LADDER_LOW_WATER;
      if (!starving) {
        const newestExpiry = live.reduce((mx, m) => Math.max(mx, m.expiryMs), 0);
        if (newestExpiry > now + ORACLE_LIFETIME_MS - ORACLE_STEP_MS) continue;
      }

      // Stand oracles up at the live game price (real Pyth anchor + vol) so the first on-chain spot
      // already matches the feed; fall back to raw Pyth on a cold start. One read serves this tick.
      let spot: number;
      try {
        spot = (await gameSpot(asset))?.price ?? (await fetchSpot(asset));
      } catch (err) {
        console.error(`[OracleRoll] no Pyth spot for ${asset}, skipping:`, err instanceof Error ? err.message : err);
        continue;
      }

      // Steady state: one fresh oracle at full life (ages down to fill the near buckets). Starving:
      // up to ORACLE_ROLL_MAX_PER_TICK at the nearest uncovered slots, so the recovery is fast AND
      // staggered (no synchronized far-end bunching that would just re-drain together).
      const expiries = starving
        ? nearestUncoveredExpiries(now, live).slice(0, Math.min(ORACLE_LADDER_DEPTH - live.length, ORACLE_ROLL_MAX_PER_TICK))
        : [now + ORACLE_LIFETIME_MS];
      for (const expiry of expiries) {
        try {
          await createOracle(asset, capId, spot, expiry);
        } catch (err) {
          console.error(`[OracleRoll] failed to create ${asset} oracle:`, err instanceof Error ? err.message : err);
        }
      }
    }
  } catch (err) {
    console.error('[OracleRoll] tick error:', err instanceof Error ? err.message : err);
  } finally {
    isRunning = false;
  }
};

export const startOracleRoll = (): void => {
  if (!OPERATOR_ENABLED) {
    console.log('[OracleRoll] Operator disabled (PIPS_OPERATOR_ENABLED != true), not scheduling');
    return;
  }
  console.log(`[OracleRoll] Scheduled: ${ORACLE_ROLL_CRON}`);
  cron.schedule(ORACLE_ROLL_CRON, rollLadder);
  rollLadder();
};
