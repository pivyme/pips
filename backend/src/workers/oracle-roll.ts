// oracle-roll: keeps a staggered ladder of live oracles per asset so a play can always route to one
// expiring ~LUCKY_ROUND_MS out (never one oracle per play, gotcha #11). An oracle's on-chain lifetime is
// decoupled from the round: each is seeded with real setup headroom and ages down through the round
// point, so a storage-heavy create plus a separate activate never race expiry.
//
// THE LOAD-BEARING INVARIANT: every oracle's expiry is anchored to the LIVE clock at the moment its
// create tx is built (Date.now() + life), never to a timestamp captured once at the top of the tick. A
// tick fires many serial operator txs (create+activate is two each, sharing the one operator lane with
// the 2s price-push and settle), so a recovery burst can run tens of seconds of wall time. A frozen
// tick-start expiry would land already in the past for the assets serviced late in the tick, and
// oracle::activate would abort EOracleExpired (code 2) on every one of them. That cascade drains the
// ladder, the ladder can never build depth (the oracles expire before the tick even ends), and the
// games go dark. Re-anchoring per create is what keeps activate's `now < expiry` always true. Localnet
// gas is free, so a deep, long ladder costs nothing.

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

// Spacing between ladder rungs, measured in remaining life: an oracle should exist at each life from
// SAFE_CREATE_MIN_LIFE_MS up to ORACLE_LIFETIME_MS, this far apart, so the ladder covers the whole
// horizon evenly instead of bunching at the far end.
const ORACLE_STEP_MS = Math.max(1000, Math.floor(ORACLE_LIFETIME_MS / ORACLE_LADDER_DEPTH));

// Below this many live oracles an asset's ladder is "starving" (a reload emptied the cache, or a dry
// spell): the gentle 1-per-tick refill can't keep up, so the roller bursts multiple fresh oracles in
// one tick to recover in seconds. Above it, steady-state one-per-tick spacing.
const LADDER_LOW_WATER = Math.max(2, Math.ceil(ORACLE_LADDER_DEPTH / 2));

// Minimum life a freshly created oracle is given, measured from the LIVE clock at create time. create
// and activate are two serial operator txs; this floor sits comfortably above the time they take even
// on a slow, congested node, so activate always lands before expiry. It also keeps the nearest rung
// inside both games' routing windows (LUCKY ~20s, RANGE 20-33s), so even a cold-start recovery yields a
// playable market on the first rung instead of one that is too far out to route to.
const SAFE_CREATE_MIN_LIFE_MS = 28_000;

// If the create tx itself stalled long enough that less than this is left of the oracle's life, skip the
// activate rather than fire one that would abort EOracleExpired on chain (the log-spam the operator was
// drowning in, plus an orphaned oracle wasted into the registry vector). Comfortably exceeds a single
// activate tx. With per-create re-anchoring this is rare; it is the belt-and-suspenders on a node stall.
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

// Each create appends the new oracle id to Registry.oracle_ids[cap], an unbounded vector<ID> in the
// vendored Predict. After ~8k oracles that one dynamic-field object crosses Sui's 256KB object cap and
// EVERY further create_oracle on that cap aborts MoveObjectTooBig. On our short-round ladder a cap fills
// in ~a day. This is the signal to rotate to a fresh cap, not a transient error to retry on the same cap.
const isCapFull = (msg: string): boolean => msg.includes('MoveObjectTooBig');

// Mint a fresh oracle cap and swap it in for a full one. create_oracle_cap is a stock Predict admin call
// that does NOT touch the bricked vector, so it still succeeds on a full deployment; the fresh cap's own
// vector starts empty, so creation resumes immediately. We never modify Predict itself. The fresh cap is
// operator-owned and persisted to the deploy file. Existing oracles keep their original authorized cap
// (price-push groups by per-oracle capId, settle reads it off-chain), so only NEW creates move onto the
// fresh cap and nothing in flight breaks.
const rotateCap = async (fullCapId: string): Promise<string> => {
  const tx = new Transaction();
  buildCreateOracleCap(tx);
  const fresh = findCreatedCap((await executeAsOperator(tx, 'rotate full oracle cap')).objectChanges);
  replaceOracleCap(fullCapId, fresh);
  console.warn(`[OracleRoll] oracle cap ${fullCapId} hit the 256KB registry cap; rotated to fresh cap ${fresh}`);
  return fresh;
};

// The ladder rungs an asset is MISSING right now, nearest (shortest life) first, as target life values,
// not absolute expiries. A rung is covered if a live oracle's remaining life sits within half a step of
// it. Nearest-first so recovery first lands a short, immediately playable round and fills outward. We
// target lives rather than frozen timestamps precisely because the tick's clock goes stale across a
// serial burst; createOracle re-anchors each life to the live clock when it actually creates.
const nearestUncoveredLives = (now: number, live: Array<{ expiryMs: number }>): number[] => {
  const out: number[] = [];
  for (let life = SAFE_CREATE_MIN_LIFE_MS; life <= ORACLE_LIFETIME_MS; life += ORACLE_STEP_MS) {
    if (!live.some((m) => Math.abs(m.expiryMs - now - life) < ORACLE_STEP_MS / 2)) out.push(life);
  }
  return out;
};

// Stand up one live oracle for an asset with `lifeMs` of life from NOW. Two PTBs: create (the oracle
// shares itself inside the call, so its id only exists afterwards) then activate. The expiry is anchored
// to the live clock here, the instant before the create is built, so a long serial burst ahead of this
// call can never push the oracle past its own expiry before activate runs. Returns once it is tradeable.
const createOracle = async (asset: string, capId: string, spot: number, lifeMs: number): Promise<void> => {
  const { minStrike, tickSize } = gridForSpot(asset, spot);
  const expiryMs = Date.now() + lifeMs;

  const createTx = new Transaction();
  buildCreateOracle(createTx, capId, asset, expiryMs, minStrike, tickSize);
  const oracleId = findCreatedOracle((await executeAsOperator(createTx, `create_oracle ${asset}`)).objectChanges);

  // If the create tx stalled on a congested node and ate most of the life, don't fire an activate that
  // would abort EOracleExpired; let the next tick reseed a fresh rung. The orphaned oracle is harmless.
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
  try {
    const caps = operatorCaps.oracleCapIds;
    if (caps.length === 0) {
      console.error('[OracleRoll] no oracle cap in config; run the bootstrap first');
      return;
    }

    // Plan from one consistent snapshot: for each asset, how short its ladder is and which rungs to
    // fill. Neediest (fewest live) first so the closest-to-draining asset leads each interleave pass.
    const now = Date.now();
    const plan = ORACLE_ASSETS.map((asset, ai) => {
      const live = liveByAsset(asset, now, EXPIRY_SAFETY_MS);
      const starving = live.length < LADDER_LOW_WATER;
      const want = Math.min(ORACLE_LADDER_DEPTH - live.length, starving ? ORACLE_ROLL_MAX_PER_TICK : 1);
      return {
        asset,
        // Distinct cap per asset so each stays its own price-push lane (one PTB per cap, gotcha #5).
        // Round-robins when the deployment has fewer caps than assets.
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

    // One spot read per asset, up front. Stand oracles up at the live game price (real Pyth anchor +
    // vol) so the first on-chain spot already matches the feed; fall back to raw Pyth on a cold start.
    const spots = new Map<string, number>();
    for (const p of work) {
      try {
        spots.set(p.asset, (await gameSpot(p.asset))?.price ?? (await fetchSpot(p.asset)));
      } catch (err) {
        console.error(`[OracleRoll] no Pyth spot for ${p.asset}, skipping:`, err instanceof Error ? err.message : err);
      }
    }

    // Per-asset cap, rotated in place below if its registry slot fills mid-tick.
    const lanes = new Map<string, string>(work.map((p) => [p.asset, p.capId]));

    // Interleave by PASS: one oracle per needy asset per pass, nearest rung first. This is the recovery
    // win, every asset gets a live market in the first pass instead of the tail assets waiting out the
    // head asset's whole burst (the old serial-per-asset order left SUI/ETH dark while BTC filled, the
    // exact symptom in the failing logs).
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
          // Cap's registry vector is full: mint a fresh cap, retry this rung on it. The swap persists,
          // so the next tick's snapshot already routes this asset onto the fresh cap.
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
