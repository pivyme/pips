// House-rake seam: all revenue logic lives here so the wallet -> Move Treasury upgrade later is a config
// swap, not a game-code change (same discipline as every Predict id living behind one wrapper). Splits every stake into net+rake, sizes the position off net, moves rake to the revenue wallet in the same atomic mint PTB; at rake=0 everything is byte-identical to no-rake.

import { HOUSE_EDGE_BPS, HOUSE_EDGE_MIN_NET_USD } from '../../config/main-config.ts';
import { toDusdcRaw } from './config.ts';
import { houseRake } from './math.ts';
import { REVENUE_ENABLED } from './signer.ts';

// Re-exported so the real path (buildMintPlay withdraws + transfers there) still learns the sink from this one seam.
export { REVENUE_ENABLED, revenueAddress } from './signer.ts';

// Net floor below which the rake is skipped (never break a mint): real Predict hard-floors a mint at ~$1 net premium (L-011).
const MIN_NET_RAW = toDusdcRaw(HOUSE_EDGE_MIN_NET_USD);

export type Rake = { rake: bigint; net: bigint };

// Splits a stake into { net, rake }; falls back to rake=0 when the revenue wallet is unset, otherwise
// delegates to the pure houseRake split. The wallet gate lives here, not math.ts, so that stays chain/config-free and unit-testable.
export function rakeOf(stakeRaw: bigint): Rake {
  if (!REVENUE_ENABLED) return { rake: 0n, net: stakeRaw };
  return houseRake(stakeRaw, HOUSE_EDGE_BPS, MIN_NET_RAW);
}
