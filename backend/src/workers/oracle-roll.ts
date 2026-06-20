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
import { gridForSpot, usd1e9, replaceOracleCap } from '../lib/sui/config.ts';
import { operatorCaps } from '../lib/sui/signer.ts';
import { executeAsOperator } from '../lib/sui/execute.ts';
import { buildActivateOracle, buildCreateOracle, buildCreateOracleCap } from '../lib/sui/predict.ts';
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

const findCreatedCap = (changes: Array<{ type: string; objectId?: string; objectType?: string }>): string => {
  const c = changes.find((x) => x.type === 'created' && x.objectType?.endsWith('::oracle::OracleSVICap'));
  if (!c?.objectId) throw new Error('rotateCap: tx created no OracleSVICap');
  return c.objectId;
};

// Each create appends the new oracle id to Registry.oracle_ids[cap], an unbounded vector<ID> in the
// vendored Predict. After ~8k oracles that one dynamic-field object crosses Sui's 256KB object cap and
// EVERY further create_oracle on that cap aborts MoveObjectTooBig. On our short-round ladder a cap
// fills in ~a day (Mysten's 15-min markets would take ~80x longer, which is why they never hit it).
// This is the signal to rotate to a fresh cap, not a transient error to retry on the same cap.
const isCapFull = (msg: string): boolean => msg.includes('MoveObjectTooBig');

// Mint a fresh oracle cap and swap it in for a full one. create_oracle_cap is a stock Predict admin
// call that does NOT touch the bricked vector, so it still succeeds on a full deployment; the fresh
// cap's own vector starts empty, so creation resumes immediately. We never modify Predict itself. The
// fresh cap is operator-owned and persisted to the deploy file. Existing oracles keep their original
// authorized cap (price-push groups by per-oracle capId, settle reads it off-chain), so only NEW
// creates move onto the fresh cap and nothing in flight breaks.
const rotateCap = async (fullCapId: string): Promise<string> => {
  const tx = new Transaction();
  buildCreateOracleCap(tx);
  const fresh = findCreatedCap((await executeAsOperator(tx, 'rotate full oracle cap')).objectChanges);
  replaceOracleCap(fullCapId, fresh);
  console.warn(`[OracleRoll] oracle cap ${fullCapId} hit the 256KB registry cap; rotated to fresh cap ${fresh}`);
  return fresh;
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

    // Snapshot every asset's ladder up front, then service the NEEDIEST first (fewest live oracles).
    // The old fixed BTC,SUI,ETH order serviced the tail assets last each tick; on a busy single operator
    // lane (create+activate is 2 serial txs) the tick ran out of lane time before SUI/ETH recovered, so
    // they kept dropping off the stack while BTC, always first, stayed up. Neediest-first hands the lane
    // to whichever asset is closest to draining.
    const now = Date.now();
    const snapshot = ORACLE_ASSETS.map((asset, ai) => ({
      asset,
      // Distinct cap per asset so each asset stays its own price-push lane (one PTB per cap, gotcha #5).
      // Round-robins when the deployment has fewer caps than assets.
      capId: caps[ai % caps.length],
      live: liveByAsset(asset, now, EXPIRY_SAFETY_MS),
    }));
    const lanes = snapshot
      .filter((l) => l.live.length < ORACLE_LADDER_DEPTH) // skip full ladders
      .sort((a, b) => a.live.length - b.live.length);
    if (lanes.length === 0) return; // every ladder full, nothing to roll
    console.log(
      `[OracleRoll] ladders ${snapshot.map((l) => `${l.asset}:${l.live.length}`).join(' ')} | servicing ${lanes.map((l) => l.asset).join('>')}`,
    );

    for (const { asset, capId, live } of lanes) {
      // Fill the nearest uncovered slots. Healthy: one per tick, which also self-heals a gap a failed
      // create left (the old 1-for-1 far-end refill stayed a slot short forever, so a single miss drained
      // the ladder with zero margin). Starving (post-reload / dry spell): burst up to
      // ORACLE_ROLL_MAX_PER_TICK so a playable market is back within a tick or two.
      const starving = live.length < LADDER_LOW_WATER;
      const perTick = starving ? ORACLE_ROLL_MAX_PER_TICK : 1;
      const expiries = nearestUncoveredExpiries(now, live).slice(0, Math.min(ORACLE_LADDER_DEPTH - live.length, perTick));
      if (expiries.length === 0) continue;

      // Stand oracles up at the live game price (real Pyth anchor + vol) so the first on-chain spot
      // already matches the feed; fall back to raw Pyth on a cold start. One read serves this asset.
      let spot: number;
      try {
        spot = (await gameSpot(asset))?.price ?? (await fetchSpot(asset));
      } catch (err) {
        console.error(`[OracleRoll] no Pyth spot for ${asset}, skipping:`, err instanceof Error ? err.message : err);
        continue;
      }

      let lane = capId; // rotated in place below if this cap's registry slot is full
      for (const expiry of expiries) {
        try {
          await createOracle(asset, lane, spot, expiry);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!isCapFull(msg)) {
            console.error(`[OracleRoll] failed to create ${asset} oracle:`, msg);
            continue;
          }
          // Cap's registry vector is full: mint a fresh cap, retry this slot on it. The swap
          // persists, so the next tick's snapshot already routes this asset onto the fresh cap.
          try {
            lane = await rotateCap(lane);
            await createOracle(asset, lane, spot, expiry);
          } catch (rotErr) {
            console.error(`[OracleRoll] ${asset} cap rotation failed:`, rotErr instanceof Error ? rotErr.message : rotErr);
            break; // give the lane a rest this tick; it recovers on the rotated cap next tick
          }
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
