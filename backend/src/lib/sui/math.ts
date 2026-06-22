// Pure Predict money math. No chain, no config, no deployed.json, so it unit-tests in
// isolation. Two scales live in the protocol and we keep every conversion here:
//   - prices / strikes are FLOAT_SCALING (1e9) fixed-point
//   - quantities and DUSDC coin amounts are 6dp (1_000_000 = $1 = one settled contract)
// mint cost = mulScaled(ask, quantity); a winning binary pays `quantity` at settlement.

export const FLOAT_SCALING = 1_000_000_000n; // 1e9, on-chain price/strike scale
export const DUSDC_DECIMALS = 1_000_000n; // 6dp, coin + quantity scale

// display USD -> 1e9-scaled u64 (prices, strikes)
export const usd1e9 = (n: number): bigint => BigInt(Math.round(n * 1e9));
// display DUSDC -> 6dp raw u64 (coin amounts, quantities)
export const toDusdcRaw = (n: number): bigint => BigInt(Math.round(n * 1_000_000));
// 6dp raw DUSDC -> display number
export const fromDusdcRaw = (raw: bigint): number => Number(raw) / 1_000_000;
// 6dp raw DUSDC -> exact decimal string. Financial API values use this instead of Number/toFixed,
// which rounded away on-chain sub-cent amounts and made balance/PnL reconciliation impossible.
export const formatDusdcRaw = (raw: bigint, minDecimals = 2): string => {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const whole = abs / DUSDC_DECIMALS;
  const fraction = (abs % DUSDC_DECIMALS).toString().padStart(6, '0');
  const keep = Math.max(0, Math.min(6, minDecimals));
  const decimals = fraction.replace(/0+$/, '').padEnd(keep, '0');
  return `${negative ? '-' : ''}${whole}${decimals ? `.${decimals}` : ''}`;
};

// deepbook::math::mul: floor((a * b) / 1e9). Used for cost = ask(1e9) * quantity(6dp).
export const mulScaled = (a1e9: bigint, b: bigint): bigint => (a1e9 * b) / FLOAT_SCALING;

// Invert cost = mulScaled(ask, quantity): the quantity whose first-order cost is `stakeRaw`.
// First-order only (ask shifts as the trade moves the book), so callers refine against a
// live preview before minting. Floors to whole 6dp units.
export const quantityForStake = (ask1e9: bigint, stakeRaw: bigint): bigint => {
  if (ask1e9 <= 0n) throw new Error('quantityForStake: ask must be positive');
  return (stakeRaw * FLOAT_SCALING) / ask1e9;
};

// Gross payout multiple on a position: payout / cost. 0 cost -> 0 (no position, no payout).
export const multiplier = (costRaw: bigint, payoutRaw: bigint): number =>
  costRaw <= 0n ? 0 : Number(payoutRaw) / Number(costRaw);
