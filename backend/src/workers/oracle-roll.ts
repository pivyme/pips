// oracle-roll: keeps a small ladder of long-lived oracles alive per asset. Creating an
// oracle pre-allocates its strike matrix and burns scarce testnet gas, so we never make
// one per play (gotcha #11): a handful of staggered oracles serve every play, which routes
// to the nearest live one and realizes short durations via cash-out. Each tick tops the
// ladder back up to ORACLE_LADDER_DEPTH and centers fresh oracles on the current spot.

import cron from 'node-cron';

import {
  ORACLE_ASSETS,
  ORACLE_LADDER_DEPTH,
  ORACLE_LIFETIME_MS,
  ORACLE_MIN_REMAINING_MS,
  ORACLE_ROLL_CRON,
  OPERATOR_ENABLED,
} from '../config/main-config.ts';
import { gridForSpot, usd1e9 } from '../lib/sui/config.ts';
import { operatorCaps } from '../lib/sui/signer.ts';
import { executeAsOperator } from '../lib/sui/execute.ts';
import { buildActivateOracle, buildCreateOracle } from '../lib/sui/predict.ts';
import { liveByAsset, upsertMarket } from '../lib/sui/markets.ts';
import { fetchSpot } from '../lib/pyth.ts';
import { Transaction } from '@mysten/sui/transactions';

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
    const capId = operatorCaps.oracleCapIds[0];
    if (!capId) {
      console.error('[OracleRoll] no oracle cap in config; run the bootstrap first');
      return;
    }

    const stagger = Math.floor(ORACLE_LIFETIME_MS / ORACLE_LADDER_DEPTH);
    for (const asset of ORACLE_ASSETS) {
      const now = Date.now();
      const live = liveByAsset(asset, now, ORACLE_MIN_REMAINING_MS);
      const need = ORACLE_LADDER_DEPTH - live.length;
      if (need <= 0) continue;

      let spot: number;
      try {
        spot = await fetchSpot(asset);
      } catch (err) {
        console.error(`[OracleRoll] no Pyth spot for ${asset}, skipping:`, err instanceof Error ? err.message : err);
        continue;
      }

      // Stagger the new batch so the ladder's expiries stay spread out, not bunched.
      for (let i = 0; i < need; i++) {
        try {
          await createOracle(asset, capId, spot, now + ORACLE_LIFETIME_MS + i * stagger);
        } catch (err) {
          console.error(`[OracleRoll] failed to create ${asset} oracle:`, err instanceof Error ? err.message : err);
          break; // gas or version trouble; back off and retry next tick
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
