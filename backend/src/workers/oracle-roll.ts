// Keeps a staggered ladder of live oracles per asset so a play always routes to one expiring ~LUCKY_ROUND_MS out (never one oracle per play, gotcha #11).
// Expiry anchors to the live clock at create time, never a frozen tick-start timestamp, or a late create aborts EOracleExpired on activate.

import cron from 'node-cron';

import {
  ORACLE_ASSETS,
  ORACLE_LADDER_DEPTH,
  ORACLE_LIFETIME_MS,
  ORACLE_ROLL_MAX_PER_TICK,
  EXPIRY_SAFETY_MS,
  ORACLE_ROLL_CRON,
  IS_REAL_PREDICT,
} from '../config/main-config.ts';
import { gridForSpot, usd1e9, replaceOracleCap } from '../lib/sui/config.ts';
import { operatorCaps } from '../lib/sui/signer.ts';
import { executeAsOperator } from '../lib/sui/execute.ts';
import { buildActivateOracle, buildCreateOracle, buildCreateOracleCap } from '../lib/sui/predict.ts';
import { liveByAsset, upsertMarket } from '../lib/sui/markets.ts';
import { engineSpot } from '../lib/game-price.ts';
import { fetchSpot } from '../lib/pyth.ts';
import { cronIntervalMs, recordRun, registerWorker } from '../lib/worker-registry.ts';
import { isOperatorLeader } from '../lib/leader-lock.ts';
import { Transaction } from '@mysten/sui/transactions';

// Spacing between ladder rungs (in remaining life) so the ladder covers SAFE_CREATE_MIN_LIFE_MS..ORACLE_LIFETIME_MS evenly instead of bunching at the far end.
const ORACLE_STEP_MS = Math.max(1000, Math.floor(ORACLE_LIFETIME_MS / ORACLE_LADDER_DEPTH));

// Below this, an asset's ladder is "starving" (cache reload, dry spell): burst multiple fresh oracles this tick instead of the steady one-per-tick refill.
const LADDER_LOW_WATER = Math.max(2, Math.ceil(ORACLE_LADDER_DEPTH / 2));

// Minimum life for a freshly created oracle, from the live clock at create time. Comfortably exceeds create+activate's worst-case latency on a slow node.
// Also keeps the nearest rung inside both games' routing windows (LUCKY ~20s, RANGE 20-33s), so a cold-start recovery still yields a playable market.
const SAFE_CREATE_MIN_LIFE_MS = 28_000;

// Skip activate if the create stalled long enough to eat this much life, rather than abort EOracleExpired on chain (the orphaned oracle is harmless).
// Rare with per-create re-anchoring, this is belt-and-suspenders for a node stall.
const ACTIVATE_MIN_HEADROOM_MS = 8_000;

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

// Each create appends to Registry.oracle_ids[cap], an unbounded vector that crosses Sui's 256KB object cap around ~8k oracles (~a day on our short-round ladder), aborting MoveObjectTooBig.
// Signal to rotate to a fresh cap, not a transient error to retry on the same one.
const isCapFull = (msg: string): boolean => msg.includes('MoveObjectTooBig');

// Mint a fresh oracle cap (stock Predict admin call, doesn't touch the bricked vector) and persist it; its own vector starts empty so creation resumes immediately.
// Existing oracles keep their original cap (price-push/settle key off per-oracle capId), so only new creates move, nothing in flight breaks.
const rotateCap = async (fullCapId: string): Promise<string> => {
  const tx = new Transaction();
  buildCreateOracleCap(tx);
  const fresh = findCreatedCap((await executeAsOperator(tx, 'rotate full oracle cap')).objectChanges);
  replaceOracleCap(fullCapId, fresh);
  console.warn(`[OracleRoll] oracle cap ${fullCapId} hit the 256KB registry cap; rotated to fresh cap ${fresh}`);
  return fresh;
};

// Ladder rungs an asset is missing, nearest (shortest life) first, as target lives not absolute expiries (a rung is covered if a live oracle sits within half a step).
// Targets lives instead of frozen timestamps because the tick's clock goes stale across a serial burst; createOracle re-anchors each to Date.now() when it creates.
const nearestUncoveredLives = (now: number, live: Array<{ expiryMs: number }>): number[] => {
  const out: number[] = [];
  for (let life = SAFE_CREATE_MIN_LIFE_MS; life <= ORACLE_LIFETIME_MS; life += ORACLE_STEP_MS) {
    if (!live.some((m) => Math.abs(m.expiryMs - now - life) < ORACLE_STEP_MS / 2)) out.push(life);
  }
  return out;
};

// Stand up one live oracle with `lifeMs` of life from now: create (the oracle shares itself, so its id only exists after) then activate. Returns once tradeable.
// Expiry anchors to the live clock right before create, so a long serial burst ahead of this call can't push it past its own expiry before activate runs.
const createOracle = async (asset: string, capId: string, spot: number, lifeMs: number): Promise<void> => {
  const { minStrike, tickSize } = gridForSpot(asset, spot);
  const expiryMs = Date.now() + lifeMs;

  const createTx = new Transaction();
  buildCreateOracle(createTx, capId, asset, expiryMs, minStrike, tickSize);
  const oracleId = findCreatedOracle((await executeAsOperator(createTx, `create_oracle ${asset}`)).objectChanges);

  // Create ran long and ate most of the life: skip activate (would abort EOracleExpired), next tick reseeds. The orphaned oracle is harmless.
  if (Date.now() >= expiryMs - ACTIVATE_MIN_HEADROOM_MS) {
    console.warn(`[OracleRoll] ${asset} create ran long, skipping activate to avoid EOracleExpired; next tick reseeds`);
    return;
  }

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
  const startedAt = Date.now();
  let runErr: unknown = null;
  try {
    const caps = operatorCaps.oracleCapIds;
    if (caps.length === 0) {
      console.error('[OracleRoll] no oracle cap in config; run the bootstrap first');
      return;
    }

    // Plan from one consistent snapshot per asset (ladder gap + rungs to fill); neediest (fewest live) leads each interleave pass.
    const now = Date.now();
    const plan = ORACLE_ASSETS.map((asset, ai) => {
      const live = liveByAsset(asset, now, EXPIRY_SAFETY_MS);
      const starving = live.length < LADDER_LOW_WATER;
      const want = Math.min(ORACLE_LADDER_DEPTH - live.length, starving ? ORACLE_ROLL_MAX_PER_TICK : 1);
      return {
        asset,
        // Distinct cap per asset (one PTB per cap, gotcha #5); round-robins if there are fewer caps than assets.
        capId: caps[ai % caps.length],
        liveCount: live.length,
        lives: nearestUncoveredLives(now, live).slice(0, Math.max(0, want)),
      };
    });
    const work = plan.filter((p) => p.lives.length > 0).sort((a, b) => a.liveCount - b.liveCount);
    if (work.length === 0) return; // every ladder full, nothing to roll
    console.log(
      `[OracleRoll] ladders ${plan.map((p) => `${p.asset}:${p.liveCount}`).join(' ')} | filling ${work.map((p) => `${p.asset}x${p.lives.length}`).join(' ')}`,
    );

    // One spot read per asset, up front: engineSpot (the value we push) so the chart starts from a real moving value, falling back to raw Pyth on a cold start.
    const spots = new Map<string, number>();
    for (const p of work) {
      try {
        spots.set(p.asset, (await engineSpot(p.asset))?.price ?? (await fetchSpot(p.asset)));
      } catch (err) {
        console.error(`[OracleRoll] no Pyth spot for ${p.asset}, skipping:`, err instanceof Error ? err.message : err);
      }
    }

    // Per-asset cap, rotated in place below if its registry slot fills mid-tick.
    const lanes = new Map<string, string>(work.map((p) => [p.asset, p.capId]));

    // Interleave by pass: one oracle per needy asset per pass, nearest rung first, so every asset gets a live market in the first pass.
    // The old serial-per-asset order left tail assets (SUI/ETH) dark while the head asset (BTC) filled its whole burst.
    const passes = Math.max(...work.map((p) => p.lives.length));
    for (let pass = 0; pass < passes; pass++) {
      for (const p of work) {
        const life = p.lives[pass];
        const spot = spots.get(p.asset);
        if (life == null || spot == null) continue;
        const lane = lanes.get(p.asset) ?? p.capId;
        try {
          await createOracle(p.asset, lane, spot, life);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!isCapFull(msg)) {
            console.error(`[OracleRoll] failed to create ${p.asset} oracle:`, msg);
            continue;
          }
          // Cap's registry vector is full: mint a fresh cap and retry this rung; the swap persists so the next tick already routes here.
          try {
            const fresh = await rotateCap(lane);
            lanes.set(p.asset, fresh);
            await createOracle(p.asset, fresh, spot, life);
          } catch (rotErr) {
            console.error(`[OracleRoll] ${p.asset} cap rotation failed:`, rotErr instanceof Error ? rotErr.message : rotErr);
          }
        }
      }
    }
  } catch (err) {
    runErr = err;
    console.error('[OracleRoll] tick error:', err instanceof Error ? err.message : err);
  } finally {
    isRunning = false;
    recordRun('oracle-roll', !runErr, Date.now() - startedAt, runErr);
  }
};

export const startOracleRoll = (): void => {
  if (IS_REAL_PREDICT) {
    // Mysten owns the market roll schedule in real mode (no MarketLifecycleCap held); discovery only via market-sync, never create/roll here.
    console.log('[OracleRoll] Real Predict mode (Mysten rolls markets), not scheduling');
    return;
  }
  if (!isOperatorLeader()) {
    console.log('[OracleRoll] Not the operator leader (disabled or lost the advisory lock), not scheduling');
    return;
  }
  console.log(`[OracleRoll] Scheduled: ${ORACLE_ROLL_CRON}`);
  const task = cron.schedule(ORACLE_ROLL_CRON, rollLadder);
  registerWorker('oracle-roll', task, cronIntervalMs(ORACLE_ROLL_CRON));
  rollLadder();
};
