// Fair, auditable RNG for I Feel Lucky. Chain-free and pure so the distribution unit-tests
// in isolation. Every pick is a sha256 draw from a stored seed + index, so given the seed
// anyone can replay the exact asset/side/leverage/duration the server chose.

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

// LUCKY slot-weighted multiplier reel (LUCKY.md §4). Weights are the reel-DEAL frequency (how
// often the slot hands you that tier), NOT the win odds; each dealt tier then wins at its own
// honest odds (~1/mult) from the live market. Keyed by multiplier so pickTier returns the tier.
// The ladder starts at 2x: every tier is a real directional move (the target sits in the bet
// direction, OTM), so "down" always needs the price to fall. A sub-2x tier would force an
// in-the-money target sitting on the wrong side of entry, which is the confusion we removed. Capped
// at 10x (the old 25x tier's weight folded into 10x): the top stays reachable and pays a sane amount.
export const LUCKY_TIER_WEIGHTS: Record<number, number> = { 2: 50, 3: 30, 5: 13, 10: 7 };

// Deal one tier for a spin from a uniform draw. The strike solver then prices that tier honestly.
export const pickTier = (r: number): number => pickWeighted(r, LUCKY_TIER_WEIGHTS);
