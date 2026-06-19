// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

/// Constants module - all protocol constants.
///
/// Scaling conventions (aligned with DeepBook):
/// - Prices/percentages use FLOAT_SCALING (1e9): 500_000_000 = 50%
/// - Quantities are in Quote units (USDC with 6 decimals): 1_000_000 = 1 contract = $1
/// - At settlement, winners receive `quantity` directly (already in USDC units)
/// - Use deepbook::math for all mul/div operations
module deepbook_predict::constants;

// === Scaling ===

/// Fixed-point scaling factor (1e9) for math operations and prices.
/// 500_000_000 = 50%, 1_000_000_000 = 100%
public macro fun float_scaling(): u64 { 1_000_000_000 }

// === Default Config ===

/// Max total exposure as % of vault capital (80% in FLOAT_SCALING)
public macro fun default_max_total_exposure_pct(): u64 { 800_000_000 }

/// Base spread multiplier for Bernoulli scaling (0.5% in FLOAT_SCALING).
/// Effective spread at 50c = base_spread * √(0.5 * 0.5) = base_spread * 0.5 = 0.25% each way.
/// Tuned for the fast game: the round-trip spread must stay well under a round's price move
/// (~1.2% at GAME_VOL 2), or it drowns the signal and every play just bleeds the spread.
public macro fun default_base_spread(): u64 { 5_000_000 }

/// Minimum spread floor (0.15% in FLOAT_SCALING)
public macro fun default_min_spread(): u64 { 1_500_000 }

/// Utilization multiplier applied to base spread (2x in FLOAT_SCALING)
/// Controls how aggressively spread widens as vault approaches capacity
public macro fun default_utilization_multiplier(): u64 { 2_000_000_000 }

/// Minimum ask price the protocol will allow at mint (1% in FLOAT_SCALING)
public macro fun default_min_ask_price(): u64 { 10_000_000 }

/// Maximum ask price the protocol will allow at mint (99% in FLOAT_SCALING)
public macro fun default_max_ask_price(): u64 { 990_000_000 }

// === Time Constants ===

public macro fun ms_per_year(): u64 { 31_536_000_000 }

/// Oracle staleness threshold (30 seconds)
public macro fun staleness_threshold_ms(): u64 { 30_000 }

// === Curve Builder ===

/// Default number of sample points for adaptive curve building
public macro fun default_curve_samples(): u64 { 50 }

/// Minimum interval between curve sample points ($0.001 in FLOAT_SCALING)
public macro fun min_curve_interval(): u64 { 1_000_000 }

// === Oracle Strike Grid ===

/// Fixed number of strike ticks each oracle must cover.
/// Pips runs its own Predict instance on gas-scarce testnet. Oracle creation
/// pre-allocates the full strike matrix, so storage cost scales linearly with this
/// count. Mysten's 100_000 ticks costs ~38 SUI per oracle. We use 500 (one 512-slot
/// page, ~0.24 SUI) and widen tick_size per asset to keep the same USD range.
public macro fun oracle_strike_grid_ticks(): u64 { 500 }

/// Granularity unit for oracle tick sizes; every tick_size must be a multiple of this value.
public macro fun oracle_tick_size_unit(): u64 { 10_000 }

/// Required decimals for all accepted quote assets in phase 1.
public macro fun required_quote_decimals(): u8 { 6 }

