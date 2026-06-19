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
export const APP_PORT: number = Number(process.env.APP_PORT) || 3700;
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
// nobody ever gets stuck. SUI is effectively infinite on localnet, so these are generous.
export const GAS_FUND_SUI: number = Number(process.env.PIPS_GAS_FUND_SUI) || 1;
export const GAS_MIN_SUI: number = Number(process.env.PIPS_GAS_MIN_SUI) || 0.2;

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
// every ~5s, and settle every ~3s so a 30s round resolves promptly after the buzzer.
export const OPERATOR_ENABLED: boolean = process.env.PIPS_OPERATOR_ENABLED === 'true';
export const PRICE_PUSH_CRON: string = process.env.PIPS_PRICE_PUSH_CRON || '*/2 * * * * *';
export const ORACLE_ROLL_CRON: string = process.env.PIPS_ORACLE_ROLL_CRON || '*/5 * * * * *';
export const SETTLE_CRON: string = process.env.PIPS_SETTLE_CRON || '*/3 * * * * *';
// Stop streaming live prices within this window before expiry so an in-flight mint
// cannot race settlement (gotcha #3 in 05-SUI-PREDICT.md).
export const EXPIRY_SAFETY_MS: number = Number(process.env.PIPS_EXPIRY_SAFETY_MS) || 5000;

// Game volatility. Real spot is too quiet over a 30-60s round, so we run a synthetic, Pyth-anchored
// vol layer (lib/game-price.ts) that makes the chart feel alive and a tight range band a real
// gamble. It is the SINGLE source for the chart stream, the oracle push, and the settle price, so
// what the player sees is exactly what settles. 1 = the tuned default, 0 = off (pure Pyth, the kill
// switch), >1 = wilder. The one sanctioned synthetic layer on the real path.
export const GAME_VOL: number =
  process.env.PIPS_GAME_VOL != null && process.env.PIPS_GAME_VOL !== '' ? Number(process.env.PIPS_GAME_VOL) : 1;

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
// never races expiry; the ladder ages these down to fill the near-round bucket.
export const ORACLE_LIFETIME_MS: number = Number(process.env.PIPS_ORACLE_LIFETIME_MS) || 60_000;
// The LUCKY round target: each play routes to the live oracle expiring nearest this far out and
// settles there, so rounds stay ~30s regardless of how long the oracles themselves live.
export const LUCKY_ROUND_MS: number = Number(process.env.PIPS_LUCKY_ROUND_MS) || 30_000;
// Oracles kept live per asset, spread evenly across the lifetime (~ORACLE_LIFETIME_MS / depth apart)
// so a near-round one always exists. Higher = tighter round consistency but more operator txs;
// with a single shared oracle cap every push serializes, so this is the throughput knob, not gas.
export const ORACLE_LADDER_DEPTH: number = Number(process.env.PIPS_ORACLE_LADDER_DEPTH) || 4;
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
  OPERATOR_ENABLED,
  PRICE_PUSH_CRON,
  ORACLE_ROLL_CRON,
  SETTLE_CRON,
  EXPIRY_SAFETY_MS,
  GAME_VOL,
  ORACLE_ASSETS,
  ORACLE_LIFETIME_MS,
  LUCKY_ROUND_MS,
  ORACLE_LADDER_DEPTH,
  ORACLE_COMPACT_SETTLED,
  PREDICT_PACKAGE_ID,
  PREDICT_REGISTRY_ID,
  PREDICT_OBJECT_ID,
  PREDICT_ADMIN_CAP_ID,
  ERROR_LOG_MAX_RECORDS,
  ERROR_LOG_CLEANUP_INTERVAL,
};
