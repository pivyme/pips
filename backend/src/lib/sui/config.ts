// Shared Sui money-math re-exports + the public Predict ids for /config. We trade Mysten's real Predict
// (ids in config-real.ts); this surface stays thin so /config and shared balance/treasury code have one import.

import { SUI_NETWORK } from '../../config/main-config.ts';
import { REAL_DUSDC_TYPE, REAL_PREDICT_PACKAGE, REAL_POOL_VAULT_ID } from './config-real.ts';

// Pure money math lives in math.ts (chain-free, unit-tested); re-exported here so the rest of the backend imports scaling helpers from the one Sui config surface.
export {
  FLOAT_SCALING,
  DUSDC_DECIMALS,
  usd1e9,
  toDusdcRaw,
  fromDusdcRaw,
  formatDusdcRaw,
  mulScaled,
  quantityForStake,
  multiplier,
} from './math.ts';

export const NETWORK = SUI_NETWORK;
export const DUSDC_TYPE = REAL_DUSDC_TYPE;

// Public-facing Predict ids for /config + explorer links: the real predict package + PoolVault.
export const PUBLIC_PREDICT_PACKAGE = REAL_PREDICT_PACKAGE;
export const PUBLIC_PREDICT_OBJECT = REAL_POOL_VAULT_ID;
