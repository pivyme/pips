// The house-rake seam. ALL revenue logic lives here so the wallet -> Move `Treasury` upgrade (v2) is a
// config swap, not a game-code change. Game code + plays.ts call `rakeOf` and `appendForkRake` and never
// learn which sink is behind it (today: a plain DUSDC transfer to the revenue wallet; tomorrow: a
// `treasury::collect` Move call). Same discipline as every Predict id living behind one wrapper.
//
// The rule (REVENUE_DESIGN.md): split every stake into `net + rake`, size the position off `net`, and
// move `rake` (real DUSDC) to the revenue wallet in the SAME atomic mint PTB. The multiplier the player
// sees is unchanged (the true market price); what shrinks is the position, so max payout is `net * mult`
// instead of `stake * mult`, exactly a vig. At rake = 0 everything is byte-identical to no-rake.
//
// WHERE the rake DUSDC comes from: NOT a fresh coin split from the user's wallet (the doc's first sketch).
// A repeat player's wallet drains into the manager/wrapper (bulk funding parks chips there, and payouts
// land there), so a wallet-sourced coin routinely has nothing to pull from and would revert the mint.
// Instead the rake is peeled straight out of the manager/wrapper AFTER the mint: the deposit already
// topped it to the full `stake`, the mint consumed ~`net`, so `>= rake` is always left to withdraw. It
// stays one atomic PTB, so a reverted mint moves nothing (chips safe, same guarantee as today). Real
// mode does the twin withdraw inside `buildMintPlay` (it owns the wrapper handle + a fresh Auth).

import { type Transaction } from '@mysten/sui/transactions';

import { HOUSE_EDGE_BPS, HOUSE_EDGE_MIN_NET_USD } from '../../config/main-config.ts';
import { toDusdcRaw } from './config.ts';
import { houseRake } from './math.ts';
import { buildManagerWithdraw } from './predict.ts';
import { REVENUE_ENABLED, revenueAddress } from './signer.ts';

// Re-export the revenue address for the real path (buildMintPlay withdraws + transfers there), so the
// one place that knows the sink is still this seam.
export { REVENUE_ENABLED, revenueAddress } from './signer.ts';

// Net floor below which the rake is skipped (never break a mint). Real Predict hard-floors a mint at ~$1
// net premium (L-011), so keep net above the value that yields it; fork imposes no such floor (0).
const MIN_NET_RAW = toDusdcRaw(HOUSE_EDGE_MIN_NET_USD);

export type Rake = { rake: bigint; net: bigint };

// Split a stake into { net, rake }. Returns rake = 0 / net = stake (byte-identical to no-rake) when the
// revenue wallet is unset (nowhere to send it); otherwise delegates to the pure houseRake split, which
// also zeroes the rake when the edge is 0 or the net would fall below the floor. The wallet gate lives
// here (not in math.ts) so the arithmetic stays chain/config-free and unit-testable.
export function rakeOf(stakeRaw: bigint): Rake {
  if (!REVENUE_ENABLED) return { rake: 0n, net: stakeRaw };
  return houseRake(stakeRaw, HOUSE_EDGE_BPS, MIN_NET_RAW);
}

// Append the FORK rake to a mint PTB: peel `rakeRaw` out of the user's PredictManager (owner-gated
// withdraw, funded because the deposit already topped the manager to the full stake and the mint only
// consumed ~net) and send it to the revenue wallet. Runs under the same per-user lock + atomic PTB as
// the mint, so a reverted mint moves nothing. No-op at rake = 0 or when revenue is disabled.
export function appendForkRake(tx: Transaction, managerId: string, rakeRaw: bigint): void {
  if (rakeRaw <= 0n || !REVENUE_ENABLED) return;
  const coin = buildManagerWithdraw(tx, managerId, rakeRaw);
  tx.transferObjects([coin], revenueAddress);
}
