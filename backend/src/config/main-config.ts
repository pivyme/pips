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

// Auth + signing mode. 'dev' auto-logs-in the testing wallet and the backend
// signs txs. 'enoki' is Google zkLogin with client signing + gas sponsorship.
export type AuthMode = 'dev' | 'enoki';
export const AUTH_MODE: AuthMode = process.env.PIPS_AUTH_MODE === 'enoki' ? 'enoki' : 'dev';

// Sui. Testnet only pre-mainnet. The dev key doubles as the Predict operator.
export const SUI_NETWORK: string = process.env.SUI_NETWORK || 'testnet';
export const SUI_FULLNODE_URL: string = process.env.SUI_FULLNODE_URL || '';
export const TESTING_WALLET_PK: string = process.env.TESTING_WALLET_PK || '';
export const ENOKI_PRIVATE_API_KEY: string = process.env.ENOKI_PRIVATE_API_KEY || '';
export const PYTH_HERMES_URL: string = process.env.PYTH_HERMES_URL || 'https://hermes.pyth.network';

// Free DUSDC starting balance per new user, in display units (6dp DUSDC).
export const STARTING_BALANCE: number = Number(process.env.PIPS_STARTING_BALANCE) || 1000;

// Stake bounds per play, display DUSDC. The knob and the play endpoints enforce these.
export const MIN_STAKE: number = Number(process.env.PIPS_MIN_STAKE) || 1;
export const MAX_STAKE: number = Number(process.env.PIPS_MAX_STAKE) || 100;
// Game-round durations offered to the player (seconds). The on-chain expiry is the
// oracle's; the round duration is the UX timer / when the screen auto-cashes out.
export const GAME_DURATIONS: number[] = (process.env.PIPS_GAME_DURATIONS || '10,30,60')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

// Operator workers (price-pusher / oracle-roll / settle). OFF by default: they spend
// testnet gas continuously, so only enable when the operator wallet is funded for a
// run. The UI gets high-frequency prices from Pyth via SSE, so on-chain pushes only
// need to keep oracles inside the 30s freshness gate, hence the conservative default.
export const OPERATOR_ENABLED: boolean = process.env.PIPS_OPERATOR_ENABLED === 'true';
export const PRICE_PUSH_CRON: string = process.env.PIPS_PRICE_PUSH_CRON || '*/15 * * * * *';
export const ORACLE_ROLL_CRON: string = process.env.PIPS_ORACLE_ROLL_CRON || '*/30 * * * * *';
export const SETTLE_CRON: string = process.env.PIPS_SETTLE_CRON || '*/5 * * * * *';
// Stop streaming live prices within this window before expiry so an in-flight mint
// cannot race settlement (gotcha #3 in 05-SUI-PREDICT.md).
export const EXPIRY_SAFETY_MS: number = Number(process.env.PIPS_EXPIRY_SAFETY_MS) || 5000;

// Oracle ladder. Creating an oracle pre-allocates its strike matrix (~0.24 SUI with our
// 500-tick constant), so on gas-scarce testnet we keep a SMALL set of long-lived oracles
// per asset and route every play to the nearest live one. Plays realize short durations
// via cash-out (redeem at the live mark), never one oracle per play (gotcha #11).
export const ORACLE_ASSETS: string[] = (process.env.PIPS_ORACLE_ASSETS || 'BTC')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
// New oracles expire this far out. Long enough that one oracle serves many plays.
export const ORACLE_LIFETIME_MS: number = Number(process.env.PIPS_ORACLE_LIFETIME_MS) || 300_000;
// Keep this many live, far-from-expiry oracles per asset at all times.
export const ORACLE_LADDER_DEPTH: number = Number(process.env.PIPS_ORACLE_LADDER_DEPTH) || 2;
// An oracle counts toward the ladder only while it has at least this much life left;
// once it drops below, oracle-roll rolls a fresh one in ahead of need.
export const ORACLE_MIN_REMAINING_MS: number = Number(process.env.PIPS_ORACLE_MIN_REMAINING_MS) || 90_000;

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
  MIN_STAKE,
  MAX_STAKE,
  GAME_DURATIONS,
  SUI_NETWORK,
  SUI_FULLNODE_URL,
  TESTING_WALLET_PK,
  ENOKI_PRIVATE_API_KEY,
  PYTH_HERMES_URL,
  STARTING_BALANCE,
  OPERATOR_ENABLED,
  PRICE_PUSH_CRON,
  ORACLE_ROLL_CRON,
  SETTLE_CRON,
  EXPIRY_SAFETY_MS,
  ORACLE_ASSETS,
  ORACLE_LIFETIME_MS,
  ORACLE_LADDER_DEPTH,
  ORACLE_MIN_REMAINING_MS,
  PREDICT_PACKAGE_ID,
  PREDICT_REGISTRY_ID,
  PREDICT_OBJECT_ID,
  PREDICT_ADMIN_CAP_ID,
  ERROR_LOG_MAX_RECORDS,
  ERROR_LOG_CLEANUP_INTERVAL,
};
