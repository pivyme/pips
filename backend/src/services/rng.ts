// Fair, auditable RNG for I Feel Lucky, chain-free and pure so the distribution unit-tests in isolation.
// Every pick is a sha256 draw from a stored seed + index, so anyone with the seed can replay the exact asset/side/leverage/duration the server chose.

import crypto from 'crypto';

export const LEVERAGE_BUCKETS = [2, 5, 10, 25, 100] as const;
// Low buckets common, 100x a rare lotto.
export const BUCKET_WEIGHTS: Record<number, number> = { 2: 35, 5: 30, 10: 20, 25: 12, 100: 3 };

// A fresh 128-bit seed, hex-encoded, stored on the Play for fairness audit.
export const newSeed = (): string => crypto.randomBytes(16).toString('hex');

// Deterministic [0,1) draw from a seed and a stream index (48 bits of sha256).
export const seedFloat = (seed: string, i: number): number => {
  const h = crypto.createHash('sha256').update(`${seed}:${i}`).digest();
  return h.readUIntBE(0, 6) / 2 ** 48;
};

// Pick a key from a weight map given a uniform draw r in [0,1).
export const pickWeighted = (r: number, weights: Record<number, number>): number => {
  const entries = Object.entries(weights);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let acc = r * total;
  for (const [k, w] of entries) {
    acc -= w;
    if (acc < 0) return Number(k);
  }
  return Number(entries[0][0]);
};

export const pickLeverage = (r: number): number => pickWeighted(r, BUCKET_WEIGHTS);

// LUCKY slot-weighted multiplier reel (LUCKY.md §4): weights are reel-DEAL frequency, NOT win odds, each
// dealt tier wins at its own honest ~1/mult odds. Starts at 2x since a sub-2x tier forces an in-the-money target; capped at 10x (old 25x weight folded in) so the top stays reachable.
export const LUCKY_TIER_WEIGHTS: Record<number, number> = { 2: 50, 3: 30, 5: 13, 10: 7 };

// Deal one tier for a spin from a uniform draw. The strike solver then prices that tier honestly.
export const pickTier = (r: number): number => pickWeighted(r, LUCKY_TIER_WEIGHTS);
