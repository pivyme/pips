/**
 * Centralized configuration for the application
 * All commonly used environment variables should be defined here
 */

// Validate required environment variables on startup
const requiredEnvVars: string[] = ['DATABASE_URL', 'JWT_SECRET'];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`FATAL: Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// App Configuration
export const APP_PORT: number = Number(process.env.APP_PORT) || 3780;
export const NODE_ENV: string = process.env.NODE_ENV || 'development';
export const IS_DEV: boolean = NODE_ENV === 'development';
export const IS_PROD: boolean = NODE_ENV === 'production';

// Database
export const DATABASE_URL: string = process.env.DATABASE_URL as string;

// Authentication
export const JWT_SECRET: string = process.env.JWT_SECRET as string;
export const JWT_EXPIRES_IN: string = process.env.JWT_EXPIRES_IN || '7d';
export const ALLOWED_ORIGIN: string = process.env.ALLOWED_ORIGIN || '';

// Auth + signing mode. 'dev' auto-logs-in the testing wallet and the backend signs txs.
// 'privy' is Google/email login with a non-custodial embedded Sui wallet; the server signs the
// user's plays via Privy rawSign under a session signer (no per-spin popup).
export type AuthMode = 'dev' | 'privy';
export const AUTH_MODE: AuthMode = process.env.PIPS_AUTH_MODE === 'privy' ? 'privy' : 'dev';

// Sui. Testnet only pre-mainnet. The dev key doubles as the Predict operator.
export const SUI_NETWORK: string = process.env.SUI_NETWORK || 'testnet';
export const SUI_FULLNODE_URL: string = process.env.SUI_FULLNODE_URL || '';
export const TESTING_WALLET_PK: string = process.env.TESTING_WALLET_PK || '';
export const PYTH_HERMES_URL: string = process.env.PYTH_HERMES_URL || 'https://hermes.pyth.network';

// Privy (privy mode only). App id + secret authenticate the server SDK. The authorization key is
// the app's session-signer key the user delegates to at login: its private key (P-256 PKCS8, with
// or without the `wallet-auth:` prefix) signs each wallet API request so the server can rawSign the
// user's plays with no popup, and its key-quorum id provisions/owns server-managed wallets (the
// same id the web client grants via VITE_PRIVY_SESSION_SIGNER_ID). The JWT verification key is
// optional, set it to skip Privy's per-verify network fetch.
export const PRIVY_APP_ID: string = process.env.PRIVY_APP_ID || '';
export const PRIVY_APP_SECRET: string = process.env.PRIVY_APP_SECRET || '';
export const PRIVY_AUTHORIZATION_KEY_ID: string = process.env.PRIVY_AUTHORIZATION_KEY_ID || '';
export const PRIVY_AUTHORIZATION_PRIVATE_KEY: string = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY || '';
export const PRIVY_JWT_VERIFICATION_KEY: string = process.env.PRIVY_JWT_VERIFICATION_KEY || '';

// Free DUSDC starting balance per new user, in display units (6dp DUSDC).
export const STARTING_BALANCE: number = Number(process.env.PIPS_STARTING_BALANCE) || 1000;

// Free SUI for gas on localnet. The operator funds each user once at onboarding (so a privy
// user can pay their own play gas) and tops up whenever the balance dips below the floor, so
// nobody ever gets stuck. SUI is effectively infinite on localnet, so these are generous. The
// floor sits above PLAY_GAS_BUDGET so an unsponsored play (sponsorship off) is always affordable;
// under sponsorship the sponsor pays and a user needs no SUI at all.
export const GAS_FUND_SUI: number = Number(process.env.PIPS_GAS_FUND_SUI) || 2;
export const GAS_MIN_SUI: number = Number(process.env.PIPS_GAS_MIN_SUI) || 0.6;

// Pinned gas budget for a user play (MIST). Letting tx.build size the budget itself triggers a full
// dryRunTransactionBlock, a ~0.5-1s node round trip; pinning a generous, always-affordable budget
// skips it (measured: sponsored build 1.13s -> 0.64s). A real Predict mint's GROSS gas is ~0.21 SUI
// (storage-heavy, almost all rebated same-tx), so 0.5 SUI covers mint+deposit with headroom while
// staying under the funded floor above. Sponsored, it is drawn from the sponsor (~500 SUI). Free localnet.
export const PLAY_GAS_BUDGET: bigint = BigInt(process.env.PIPS_PLAY_GAS_BUDGET || 500_000_000);

// Gas sponsorship (privy mode). One dedicated wallet pays the gas for every user play, so a user
// only ever holds DUSDC and never thinks about SUI. The play tx names this wallet as the gas OWNER
// with an EMPTY gas payment, so gas is drawn from its SUI address balance (Sui's accumulator), not
// an owned gas coin. With no owned gas coin in the tx, concurrent plays from different users share
// zero owned objects and can never equivocate, which is what keeps it stable under load. Empty key
// = sponsorship off (the app falls back to the per-user SUI funding above). The operator seeds and
// tops up the sponsor balance from its own free localnet SUI.
export const GAS_SPONSORSHIP_WALLET_PK: string = process.env.GAS_SPONSORSHIP_WALLET_PK || '';
// When the sponsor's SUI dips below MIN, the operator deposits TOPUP more into its address balance.
// Generous: localnet SUI is free and storage rebates flow back into the sponsor balance.
export const SPONSOR_MIN_SUI: number = Number(process.env.PIPS_SPONSOR_MIN_SUI) || 50;
export const SPONSOR_TOPUP_SUI: number = Number(process.env.PIPS_SPONSOR_TOPUP_SUI) || 500;

// Demo override, OFF by default. When set to a valid leverage bucket (2/5/10/25/100), I Feel
// Lucky forces that bucket instead of the fair RNG draw so a rehearsed demo reliably lands a
// mid-bucket green swing (08-DEMO-FLOW.md says never demo a 100x lotto live). Asset and side
// stay random so it still feels alive. Leave empty for fair play. Optionally also pin the round
// duration so the climb has room to develop on camera.
export const DEMO_LUCKY_LEVERAGE: number = Number(process.env.PIPS_DEMO_LUCKY_LEVERAGE) || 0;
export const DEMO_LUCKY_DURATION: number = Number(process.env.PIPS_DEMO_LUCKY_DURATION) || 0;

// Stake bounds per play, display DUSDC. The knob and the play endpoints enforce these.
export const MIN_STAKE: number = Number(process.env.PIPS_MIN_STAKE) || 1;
export const MAX_STAKE: number = Number(process.env.PIPS_MAX_STAKE) || 100;
// Game-round durations offered to the player (seconds). The on-chain expiry is the
// oracle's; the round duration is the UX timer / when the screen auto-cashes out.
export const GAME_DURATIONS: number[] = (process.env.PIPS_GAME_DURATIONS || '10,30,60')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

// Operator workers (price-pusher / oracle-roll / settle). OFF by default. On localnet gas
// is effectively infinite, so cost is no longer the constraint; the flag stays off by
// default because it IS the single-leader switch: if the backend runs as several instances,
// set it true on exactly ONE (the operator/leader) so oracles are not double-pushed, and
// keep it false on the rest, which just serve the API. For the LUCKY 30s tier the cadence is
// tight: push spot every ~2s (well inside the 30s freshness gate), roll the oracle ladder
// every ~5s, and settle every ~1s. The settle tick is cheap now (it resolves won/lost from the
// frozen price with no tx, and decouples the win redeem), so a fast cadence makes the result land
// within ~1s of the buzzer instead of waiting out a 3s scan gap. The isRunning guard skips overlaps.
export const OPERATOR_ENABLED: boolean = process.env.PIPS_OPERATOR_ENABLED === 'true';
export const PRICE_PUSH_CRON: string = process.env.PIPS_PRICE_PUSH_CRON || '*/2 * * * * *';
export const ORACLE_ROLL_CRON: string = process.env.PIPS_ORACLE_ROLL_CRON || '*/5 * * * * *';
export const SETTLE_CRON: string = process.env.PIPS_SETTLE_CRON || '*/1 * * * * *';
// Follower-mode market discovery cadence. Only runs when OPERATOR_ENABLED is false: this backend
// then learns the live oracle set from chain (emitted by whoever IS the operator) instead of from
// its own oracle-roll. Oracles are short-lived, so sync briskly to keep the ladder current.
export const MARKET_SYNC_CRON: string = process.env.PIPS_MARKET_SYNC_CRON || '*/3 * * * * *';
// Cap the on-chain redeems a single settle tick fires, so a backlog of expired ITM plays drains
// gradually instead of monopolizing the one serial operator executor (which oracle-roll shares) and
// starving the ladder. The rest carry over to the next tick (every 3s).
export const SETTLE_MAX_REDEEMS_PER_TICK: number = Number(process.env.PIPS_SETTLE_MAX_REDEEMS_PER_TICK) || 6;
// Stop streaming live prices within this window before expiry so an in-flight mint
// cannot race settlement (gotcha #3 in 05-SUI-PREDICT.md).
export const EXPIRY_SAFETY_MS: number = Number(process.env.PIPS_EXPIRY_SAFETY_MS) || 5000;

// Live-PnL SSE (/stream/plays/:id). The mark is a real per-play devInspect (~1.5s on the remote
// node), so a 1s tick per open play saturates the single-validator node and starves the operator
// ladder. A 2.5s tick + a short mark cache cuts that load ~60% with no felt loss (a binary mark
// barely moves in 2.5s). PLAY_STREAM_INTERVAL_MS is the tick; LIVE_MARK_TTL_MS dedupes overlapping
// reads (the stream tick + a getPlay) onto one devInspect.
export const PLAY_STREAM_INTERVAL_MS: number = Number(process.env.PIPS_PLAY_STREAM_INTERVAL_MS) || 2500;
export const LIVE_MARK_TTL_MS: number = Number(process.env.PIPS_LIVE_MARK_TTL_MS) || 2000;

// Game volatility. Real spot is too quiet over a 30-60s round, so we run a synthetic, Pyth-anchored
// vol layer (lib/game-price.ts) that makes the chart feel alive and a tight range band a real
// gamble. It is the SINGLE source for the chart stream, the oracle push, and the settle price, so
// what the player sees is exactly what settles. 2 = the tuned default (~1.2% realized move per 30s
// round), 0 = off (pure Pyth, the kill switch), >2 = wilder. The one sanctioned synthetic layer on
// the real path. Must track IMPLIED_VOL: the realized move and the price the option is quoted at have
// to be the same order, or the spread drowns the signal and a play just bleeds (see IMPLIED_VOL).
export const GAME_VOL: number =
  process.env.PIPS_GAME_VOL != null && process.env.PIPS_GAME_VOL !== '' ? Number(process.env.PIPS_GAME_VOL) : 2;

// Implied vol the binary is priced at (total vol to expiry, fed into the oracle SVI surface in
// lib/sui/predict.ts). The single biggest game-feel knob: it sets both how hard the mark moves when
// spot moves (delta ~ 1/vol) and how far OTM each multiplier tier's strike sits. Too high and a play
// feels dead while the big multipliers sit unreachably far out (the old 0.04/0.1/0.6 SVI was ~31.6%
// vol, ~50x the realized move, so 25x lived ~65% away, unwinnable); too low and the strike grid
// can't resolve the near tiers. Keep it ~1.5-2.5x the per-round realized move (GAME_VOL): a touch
// above realized is a thin honest house lean. 0.03 = 3% pairs with GAME_VOL 2 (~1.2% realized): 2x
// sits ATM and swings live, 25x sits ~5% OTM, a real but rare jackpot.
export const IMPLIED_VOL: number =
  process.env.PIPS_IMPLIED_VOL != null && process.env.PIPS_IMPLIED_VOL !== '' ? Number(process.env.PIPS_IMPLIED_VOL) : 0.03;

// Oracle ladder, the LUCKY tier. A play settles at its oracle's expiry (key.expiry ==
// oracle.expiry). Crucially the oracle's on-chain LIFETIME is decoupled from the ROUND length:
// a fresh oracle must first survive a storage-heavy create plus a separate activate (every
// operator tx funnels through one serial executor), and a 30s-lived oracle could expire mid-setup
// on the remote node, so oracle::activate aborts EOracleExpired and the ladder starves. So oracles
// live well past the round (ORACLE_LIFETIME_MS) for ample setup headroom, the ladder keeps a
// staggered spread of them per asset, and each play routes to the live oracle expiring nearest
// LUCKY_ROUND_MS out (never one oracle per play, gotcha #11). The oracles age down through the
// round point, so a real ~30s one is always available. Localnet gas is free, so the longer life
// and deeper ladder cost nothing. Each asset is its own price-push lane (a distinct cap, gotcha #5).
export const ORACLE_ASSETS: string[] = (process.env.PIPS_ORACLE_ASSETS || 'BTC,SUI,ETH')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
// How long a freshly created oracle lives. Must comfortably exceed LUCKY_ROUND_MS so create+activate
// never races expiry; the ladder ages these down to fill the near-round bucket. Generous on free
// localnet: a longer life means the ladder always carries oracles with enough headroom that a slow
// background mint lands before its routed oracle expires (the old 60s starved this under congestion).
export const ORACLE_LIFETIME_MS: number = Number(process.env.PIPS_ORACLE_LIFETIME_MS) || 90_000;
// The LUCKY round target: each play routes to the live oracle expiring nearest this far out and
// settles there, so rounds stay ~this long regardless of how long the oracles themselves live. Kept
// short so the loop is a quick thrill: spin (reels ~2s) -> a brief watchable round -> instant settle.
export const LUCKY_ROUND_MS: number = Number(process.env.PIPS_LUCKY_ROUND_MS) || 15_000;
// Minimum oracle life a LUCKY play will route to. The mint runs in the background but must still land
// before expiry (else EOracleExpired -> the play re-routes/re-racks), so a play never routes to an
// oracle with less life than this. When the ladder is thin and nothing clears the bar, routing falls
// back to the longest-lived live oracle instead of failing. Must comfortably exceed the mint time,
// which spikes on the congested remote node, so this carries real headroom over a fast mint (~2.5s).
export const LUCKY_MIN_ORACLE_LIFE_MS: number = Number(process.env.PIPS_LUCKY_MIN_ORACLE_LIFE_MS) || 13_000;
// Oracles kept live per asset, spread evenly across the lifetime (~ORACLE_LIFETIME_MS / depth apart)
// so a near-round one always exists. Higher = more buffer when the operator briefly falls behind
// (free localnet gas), at the cost of bigger push PTBs and more settle work, both bounded.
export const ORACLE_LADDER_DEPTH: number = Number(process.env.PIPS_ORACLE_LADDER_DEPTH) || 8;
// Max oracles oracle-roll creates per asset in a single tick. Steady state needs only 1 (gentle,
// spacing-gated). But after a reload/dry spell the ladder is empty and a 1-per-tick refill leaves
// minutes of "No markets are live"; when an asset is below low-water the roller bursts up to this
// many per tick (spacing gate bypassed) so the ladder refills in seconds. Free localnet gas.
export const ORACLE_ROLL_MAX_PER_TICK: number = Number(process.env.PIPS_ORACLE_ROLL_MAX_PER_TICK) || 3;
// Reclaim a settled oracle's strike matrix to recover its storage rebate. Only worth it on a
// gas-scarce chain; on free localnet it is pure extra load on the serial operator queue, so off.
export const ORACLE_COMPACT_SETTLED: boolean = process.env.PIPS_ORACLE_COMPACT_SETTLED === 'true';

// Predict instance ids. Written by the bootstrap, never hardcoded. Unstable pre-mainnet.
export const PREDICT_PACKAGE_ID: string = process.env.PREDICT_PACKAGE_ID || '';
export const PREDICT_REGISTRY_ID: string = process.env.PREDICT_REGISTRY_ID || '';
export const PREDICT_OBJECT_ID: string = process.env.PREDICT_OBJECT_ID || '';
export const PREDICT_ADMIN_CAP_ID: string = process.env.PREDICT_ADMIN_CAP_ID || '';

// Error Log Configuration
export const ERROR_LOG_MAX_RECORDS: number = 10000;
export const ERROR_LOG_CLEANUP_INTERVAL: string = '0 * * * *'; // Every hour

// Export all as default object for convenience
export default {
  APP_PORT,
  NODE_ENV,
  IS_DEV,
  IS_PROD,
  DATABASE_URL,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  ALLOWED_ORIGIN,
  AUTH_MODE,
  DEMO_LUCKY_LEVERAGE,
  DEMO_LUCKY_DURATION,
  MIN_STAKE,
  MAX_STAKE,
  GAME_DURATIONS,
  SUI_NETWORK,
  SUI_FULLNODE_URL,
  TESTING_WALLET_PK,
  PRIVY_APP_ID,
  PRIVY_APP_SECRET,
  PRIVY_AUTHORIZATION_KEY_ID,
  PRIVY_AUTHORIZATION_PRIVATE_KEY,
  PRIVY_JWT_VERIFICATION_KEY,
  PYTH_HERMES_URL,
  STARTING_BALANCE,
  GAS_FUND_SUI,
  GAS_MIN_SUI,
  PLAY_GAS_BUDGET,
  GAS_SPONSORSHIP_WALLET_PK,
  SPONSOR_MIN_SUI,
  SPONSOR_TOPUP_SUI,
  OPERATOR_ENABLED,
  PRICE_PUSH_CRON,
  ORACLE_ROLL_CRON,
  SETTLE_CRON,
  MARKET_SYNC_CRON,
  SETTLE_MAX_REDEEMS_PER_TICK,
  EXPIRY_SAFETY_MS,
  PLAY_STREAM_INTERVAL_MS,
  LIVE_MARK_TTL_MS,
  GAME_VOL,
  ORACLE_ASSETS,
  ORACLE_LIFETIME_MS,
  LUCKY_ROUND_MS,
  LUCKY_MIN_ORACLE_LIFE_MS,
  ORACLE_LADDER_DEPTH,
  ORACLE_ROLL_MAX_PER_TICK,
  ORACLE_COMPACT_SETTLED,
  PREDICT_PACKAGE_ID,
  PREDICT_REGISTRY_ID,
  PREDICT_OBJECT_ID,
  PREDICT_ADMIN_CAP_ID,
  ERROR_LOG_MAX_RECORDS,
  ERROR_LOG_CLEANUP_INTERVAL,
};
