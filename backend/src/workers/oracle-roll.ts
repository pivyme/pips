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

      // Add at most one per tick, and only once the newest live oracle is at least a step old, so
      // fresh oracles land ~ORACLE_STEP_MS apart in expiry and the ladder spreads across the whole
      // lifetime instead of bunching. Fresh oracles always get a full lifetime of headroom.
      const newestExpiry = live.reduce((mx, m) => Math.max(mx, m.expiryMs), 0);
      if (live.length > 0 && newestExpiry > now + ORACLE_LIFETIME_MS - ORACLE_STEP_MS) continue;

      // Stand the oracle up at the live game price (real Pyth anchor + vol) so its first on-chain
      // spot already matches the feed; fall back to raw Pyth on a cold start.
      let spot: number;
      try {
        spot = (await gameSpot(asset))?.price ?? (await fetchSpot(asset));
      } catch (err) {
        console.error(`[OracleRoll] no Pyth spot for ${asset}, skipping:`, err instanceof Error ? err.message : err);
        continue;
      }

      try {
        await createOracle(asset, capId, spot, now + ORACLE_LIFETIME_MS);
      } catch (err) {
        console.error(`[OracleRoll] failed to create ${asset} oracle:`, err instanceof Error ? err.message : err);
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
