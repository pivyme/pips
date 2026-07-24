/** Centralized env config. Every tunable is a named export, read from process.env with a default. */

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

// Postgres pool ceiling for the Prisma pg adapter. N instances x DB_POOL_MAX must stay under the server's
// max_connections; 10 supports ~8 instances with headroom. Raise only with a bigger Postgres. (09-DEPLOYMENT.md)
export const DB_POOL_MAX: number = Number(process.env.PIPS_DB_POOL_MAX) || 10;

// Graceful-shutdown drain budget (ms). On SIGTERM/crash we stop workers, close servers, disconnect Prisma,
// then force-exit if the drain overruns. Kept under Docker's 10s SIGKILL grace so the drain always wins.
export const SHUTDOWN_TIMEOUT_MS: number = Number(process.env.PIPS_SHUTDOWN_TIMEOUT_MS) || 8000;

// Opt-in alerting. When set, unrecoverable events (fatal crash, leader-lock conflict, worker giving up on a
// play) POST to a Discord/Slack webhook. Empty = silent no-op. DEDUPE_MS throttles the same message per window.
export const ALERT_WEBHOOK_URL: string = (process.env.PIPS_ALERT_WEBHOOK_URL || '').trim();
export const ALERT_DEDUPE_MS: number = Number(process.env.PIPS_ALERT_DEDUPE_MS) || 5 * 60_000;

// Authentication
export const JWT_SECRET: string = process.env.JWT_SECRET as string;
export const JWT_EXPIRES_IN: string = process.env.JWT_EXPIRES_IN || '7d';
export const ALLOWED_ORIGIN: string = process.env.ALLOWED_ORIGIN || '';

// HTTP rate limiting (@fastify/rate-limit, keyed by real client IP via trustProxy). Generous global default
// for the play loop (real-mode play rate gated separately, L-008), tighter caps on auth/fund/identity routes.
export const RATE_LIMIT_WINDOW: string = process.env.PIPS_RATE_LIMIT_WINDOW || '1 minute';
export const RATE_LIMIT_GLOBAL_MAX: number = Number(process.env.PIPS_RATE_LIMIT_GLOBAL_MAX) || 300;
export const RATE_LIMIT_AUTH_MAX: number = Number(process.env.PIPS_RATE_LIMIT_AUTH_MAX) || 10;
export const RATE_LIMIT_FAUCET_MAX: number = Number(process.env.PIPS_RATE_LIMIT_FAUCET_MAX) || 5;
export const RATE_LIMIT_WITHDRAW_MAX: number = Number(process.env.PIPS_RATE_LIMIT_WITHDRAW_MAX) || 20;
export const RATE_LIMIT_AVATAR_MAX: number = Number(process.env.PIPS_RATE_LIMIT_AVATAR_MAX) || 10;
export const RATE_LIMIT_REFERRAL_CLAIM_MAX: number = Number(process.env.PIPS_RATE_LIMIT_REFERRAL_CLAIM_MAX) || 10;

// Avatar storage (S3 / DigitalOcean Spaces). Bucket/region/endpoint are derived from S3_BUCKET_URL, one source of truth.
// Missing any piece disables uploads cleanly (route 503s, client shows a letter chip); fail-soft, never blocks boot.
export const S3_ACCESS_KEY: string = (process.env.S3_ACCESS_KEY || '').trim();
export const S3_SECRET_KEY: string = (process.env.S3_SECRET_KEY || '').trim();
export const S3_BUCKET_URL: string = (process.env.S3_BUCKET_URL || '').trim().replace(/\/+$/, '');
export const S3_FOLDER_PREFIX: string = (process.env.S3_FOLDER_PREFIX || 'pips').trim().replace(/^\/+|\/+$/g, '');
// Parse https://<bucket>.<region>.<host> -> bucket=pivy, region=sgp1, endpoint=https://sgp1.digitaloceanspaces.com
const s3Host: string = S3_BUCKET_URL.replace(/^https?:\/\//, '');
const s3Labels: string[] = s3Host ? s3Host.split('.') : [];
export const S3_BUCKET: string = s3Labels[0] ?? '';
export const S3_REGION: string = s3Labels[1] ?? '';
export const S3_ENDPOINT: string = s3Labels.length > 1 ? `https://${s3Labels.slice(1).join('.')}` : '';
export const AVATAR_UPLOADS_ENABLED: boolean = Boolean(S3_ACCESS_KEY && S3_SECRET_KEY && S3_BUCKET && S3_ENDPOINT);

// Auth + signing mode. 'dev' auto-logs-in the testing wallet and the backend signs. 'privy' is Google/email
// login with an embedded Sui wallet; the server signs plays via Privy rawSign under a session signer.
export type AuthMode = 'dev' | 'privy';
export const AUTH_MODE: AuthMode = process.env.PIPS_AUTH_MODE === 'privy' ? 'privy' : 'dev';

// Sui network. testnet + mainnet run Mysten's OFFICIAL DeepBook Predict (L-005). Mainnet is the clean
// re-point of the testnet path: same code, its own deploy record.
export const SUI_NETWORK: string = process.env.SUI_NETWORK || 'testnet';
export const SUI_FULLNODE_URL: string = process.env.SUI_FULLNODE_URL || '';
// PIPS's optional, stateless on-chain attribution package. Empty keeps mint PTBs byte-for-byte
// unchanged, so deployment and runtime rollout are deliberately separate decisions.
export const PIPS_LOGGER_PACKAGE_ID: string = process.env.PIPS_LOGGER_PACKAGE_ID?.trim() ?? '';
// GraphQL endpoint for historical queries (events / tx-history) gRPC v2 can't serve. Override with SUI_GRAPHQL_URL.
const DEFAULT_GRAPHQL_URL: Record<string, string> = {
  mainnet: 'https://graphql.mainnet.sui.io/graphql',
  testnet: 'https://graphql.testnet.sui.io/graphql',
};
export const SUI_GRAPHQL_URL: string =
  process.env.SUI_GRAPHQL_URL || DEFAULT_GRAPHQL_URL[SUI_NETWORK] || DEFAULT_GRAPHQL_URL.testnet;
export const TESTING_WALLET_PK: string = process.env.TESTING_WALLET_PK || '';
export const PYTH_HERMES_URL: string = process.env.PYTH_HERMES_URL || 'https://hermes.pyth.network';

// === Multichain deposit (LI.FI) ===
// Quoting is a read-only MAINNET route lookup: it works from any network we run on, needs no wallet, and
// is what lets the deposit drawer show real routes/fees/ETAs on testnet. The API needs no key; the key
// only buys a per-key rate limit instead of a per-IP one, so it stays server-side (never shipped to the browser).
export const LIFI_API_URL: string = process.env.PIPS_LIFI_API_URL || 'https://li.quest/v1';
export const LIFI_API_KEY: string = process.env.LIFI_API_KEY || '';
export const LIFI_INTEGRATOR: string = process.env.PIPS_LIFI_INTEGRATOR || 'pips';
export const LIFI_TIMEOUT_MS: number = Number(process.env.PIPS_LIFI_TIMEOUT_MS) || 12_000;

// Cross-chain deposit EXECUTION. Gated on mainnet by construction, not by the env var alone: bridged real
// USDC would land in a DUSDC economy as a different coin type, invisible to the balance and unusable by
// Predict. The flag can only ever loosen a condition that is already true, so a demo box can never be one
// env var away from moving real money. Quoting is deliberately NOT gated by this.
export const BRIDGE_EXECUTE_ENABLED: boolean =
  process.env.PIPS_BRIDGE_EXECUTE_ENABLED === 'true' && SUI_NETWORK === 'mainnet';

// Deposit sizing, driven by the real fee math: a $3 bridge loses ~2% and $0.50 loses ~10%, so warn under
// MIN and hard-reject under HARD where the deposit is mostly fees. Slippage sets the quote's toAmountMin floor.
export const DEPOSIT_MIN_USD: number = Number(process.env.PIPS_DEPOSIT_MIN_USD) || 3;
export const DEPOSIT_HARD_MIN_USD: number = Number(process.env.PIPS_DEPOSIT_HARD_MIN_USD) || 1;
export const DEPOSIT_SLIPPAGE: number = Number(process.env.PIPS_DEPOSIT_SLIPPAGE) || 0.01;
// Each quote hits an external API, so it gets a tighter per-IP cap than the global one. The client already
// debounces and aborts in-flight requests; this is the backstop.
export const RATE_LIMIT_QUOTE_MAX: number = Number(process.env.PIPS_RATE_LIMIT_QUOTE_MAX) || 60;

// Realtime chart display feed (Binance, real mode + mainnet only): chart MOTION comes from a shared aggTrade WS,
// LEVEL stays EMA-pinned to the on-chain oracle (price-bus.ts), display-only, never settles (L-015). Fork mode never opens the socket.
export const BINANCE_ENABLED: boolean = process.env.PIPS_BINANCE_ENABLED !== 'false';
// Combined-stream base URL; `?streams=` is built from BINANCE_SYMBOLS. Point at binance.us or a relay if geo-blocked.
export const BINANCE_WS_URL: string = process.env.PIPS_BINANCE_WS_URL || 'wss://stream.binance.com:9443/stream';
// No aggTrade for this long marks the feed stale, so the ladder falls back to the on-chain spot.
export const BINANCE_STALE_MS: number = Number(process.env.PIPS_BINANCE_STALE_MS) || 5000;
// asset -> Binance stream symbol (lowercase). Format: 'BTC:btcusdt,ETH:ethusdt,SUI:suiusdt'.
export const BINANCE_SYMBOLS: Record<string, string> = Object.fromEntries(
  (process.env.PIPS_BINANCE_SYMBOLS || 'BTC:btcusdt,ETH:ethusdt,SUI:suiusdt')
    .split(',')
    .map((pair) => pair.split(':').map((s) => s.trim()))
    .filter(([asset, sym]) => asset && sym)
    .map(([asset, sym]) => [asset.toUpperCase(), sym.toLowerCase()]),
);

// /ws broadcast cadence. One shared loop per asset reads the display bus once per tick and fans the same value
// to every subscriber, so charts stay in lock-step. 100ms = 10Hz. The client eases between frames.
export const PRICE_WS_BROADCAST_MS: number = Number(process.env.PIPS_PRICE_WS_BROADCAST_MS) || 100;

// Display feed tuning (price-bus.ts, real mode only, display-only per L-015). The line's LEVEL is the fresh
// on-chain oracle; Binance adds only bounded, zero-mean texture so entry/band/settle sit on the line.
// ORACLE_TTL: how fresh the BTC anchor read is kept. LEVEL_TAU: eases the sub-2s oracle steps onto the line.
// PIN_TAU: the Binance slow-EMA window defining "high-frequency texture". WIGGLE_MAX: max stray from the oracle
// (fraction of price). REENTRY: healthy Binance streak before resuming texture after an outage. BUZZER: converge fully before expiry.
export const PRICE_ORACLE_TTL_MS: number = Number(process.env.PIPS_PRICE_ORACLE_TTL_MS) || 750;
export const PRICE_LEVEL_TAU_MS: number = Number(process.env.PIPS_PRICE_LEVEL_TAU_MS) || 450;
export const PRICE_PIN_TAU_MS: number = Number(process.env.PIPS_PRICE_PIN_TAU_MS) || 1200;
export const PRICE_WIGGLE_MAX_FRAC: number = Number(process.env.PIPS_PRICE_WIGGLE_MAX_FRAC) || 0.00003;
export const PRICE_PIN_REENTRY_MS: number = Number(process.env.PIPS_PRICE_PIN_REENTRY_MS) || 1500;
export const PRICE_PIN_BUZZER_MS: number = Number(process.env.PIPS_PRICE_PIN_BUZZER_MS) || 4000;

// Privy (privy mode). App id + secret authenticate the server SDK; the authorization key is the session-signer
// key delegated at login, it rawSigns plays with no popup and its quorum id must match VITE_PRIVY_SESSION_SIGNER_ID. JWT verification key is optional (skips a fetch).
export const PRIVY_APP_ID: string = process.env.PRIVY_APP_ID || '';
export const PRIVY_APP_SECRET: string = process.env.PRIVY_APP_SECRET || '';
export const PRIVY_AUTHORIZATION_KEY_ID: string = process.env.PRIVY_AUTHORIZATION_KEY_ID || '';
export const PRIVY_AUTHORIZATION_PRIVATE_KEY: string = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY || '';
export const PRIVY_JWT_VERIFICATION_KEY: string = process.env.PRIVY_JWT_VERIFICATION_KEY || '';

// In privy mode, fail fast in prod if the server credentials are incomplete (abort the deploy loudly instead of
// letting the first login discover it); dev warns and continues. No new required vars beyond the four the SDK needs.
if (AUTH_MODE === 'privy') {
  const missingPrivy = (
    [
      ['PRIVY_APP_ID', PRIVY_APP_ID],
      ['PRIVY_APP_SECRET', PRIVY_APP_SECRET],
      ['PRIVY_AUTHORIZATION_KEY_ID', PRIVY_AUTHORIZATION_KEY_ID],
      ['PRIVY_AUTHORIZATION_PRIVATE_KEY', PRIVY_AUTHORIZATION_PRIVATE_KEY],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missingPrivy.length > 0) {
    const msg = `PIPS_AUTH_MODE=privy but missing required Privy key(s): ${missingPrivy.join(', ')}`;
    if (IS_PROD) {
      console.error(`FATAL: ${msg}`);
      process.exit(1);
    } else {
      console.warn(`[config] ${msg} (privy logins will fail until these are set)`);
    }
  }
}

// Native Sui wallet-connect login (custodial play-wallet), independent of AUTH_MODE. /auth/wallet/* proves
// ownership by signing a nonce; the server provisions and signs for a custodial play wallet, encrypted at rest via WALLET_ENCRYPTION_KEY (32 bytes, hex64 or base64-32).
export const WALLET_AUTH_ENABLED: boolean = process.env.PIPS_WALLET_AUTH_ENABLED === 'true';
export const WALLET_ENCRYPTION_KEY: string = process.env.PIPS_WALLET_ENCRYPTION_KEY || '';

// DUSDC starting balance per new user (6dp). Also the refill + TOP UP target. Chips come only from a
// hand-funded treasury (L-008, not mintable), so keep the treasury stocked above TREASURY_MIN_DUSDC + this.
export const STARTING_BALANCE: number = Number(process.env.PIPS_STARTING_BALANCE) || 100;

// Pinned gas budget per play (MIST). Pinning skips tx.build's dryRun round-trip (sponsored build 1.13s -> 0.64s).
// A real mint's gross gas is ~0.21 SUI (mostly rebated same-tx), so 0.5 SUI covers it with headroom yet caps a pathological tx from draining the finite testnet sponsor.
export const PLAY_GAS_BUDGET: bigint = BigInt(process.env.PIPS_PLAY_GAS_BUDGET || 500_000_000);

// Gas sponsorship (privy mode). One wallet pays gas for every user play so users only ever hold DUSDC: the tx
// names it as gas OWNER with an EMPTY payment, so gas draws from its SUI address balance, not an owned coin, so concurrent plays can't equivocate. Empty key = off (falls back to per-user funding).
export const GAS_SPONSORSHIP_WALLET_PK: string = process.env.GAS_SPONSORSHIP_WALLET_PK || '';
// When the sponsor's SUI dips below MIN, TOPUP is moved into its address balance (the working buffer); the
// rest stays as owned coins, the readable reserve play-safety.ts watches. Kept tiny so a hand-funded sponsor isn't drained at once.
export const SPONSOR_MIN_SUI: number = Number(process.env.PIPS_SPONSOR_MIN_SUI) || 50;
export const SPONSOR_TOPUP_SUI: number = Number(process.env.PIPS_SPONSOR_TOPUP_SUI) || 0.2;

// Sponsor safety layer (play-safety.ts). Testnet SUI is finite (L-008): the per-user limiter is a token
// bucket, RATE_LIMIT_MS is the refill interval (one slot per interval, 0 = off), RATE_BURST is the bucket
// depth so Range V2 can stack several positions back to back without a 429; sustained rate is still capped.
// FLOOR_SUI pauses new plays until the reserve recovers, BURN_WARN_SUI/MONITOR_CRON log burn rate.
export const PLAY_RATE_LIMIT_MS: number =
  process.env.PIPS_PLAY_RATE_LIMIT_MS != null ? Number(process.env.PIPS_PLAY_RATE_LIMIT_MS) : 3000;
export const PLAY_RATE_BURST: number = Math.max(1, Number(process.env.PIPS_PLAY_RATE_BURST) || 6);
export const SPONSOR_FLOOR_SUI: number = Number(process.env.PIPS_SPONSOR_FLOOR_SUI) || 0.5;
export const SPONSOR_BURN_WARN_SUI: number = Number(process.env.PIPS_SPONSOR_BURN_WARN_SUI) || 0.2;
export const SPONSOR_MONITOR_CRON: string = process.env.PIPS_SPONSOR_MONITOR_CRON || '*/30 * * * * *';

// Settlement wallet. The settle-redeem sweep signs with THIS wallet, not the operator, so a backed-up redeem
// runs on its own gas coin and can't head-of-line block the operator's price-push/oracle-nudge lane. Empty = falls back to the operator, which auto-funds it.
export const SETTLEMENT_WALLET_PK: string = process.env.SETTLEMENT_WALLET_PK || '';
export const SETTLEMENT_MIN_SUI: number = Number(process.env.PIPS_SETTLEMENT_MIN_SUI) || 50;
export const SETTLEMENT_TOPUP_SUI: number = Number(process.env.PIPS_SETTLEMENT_TOPUP_SUI) || 500;

// Treasury wallet. Holds a pre-minted DUSDC reserve and pays user chips (starting balance + Request DUSDC faucet)
// via a plain transfer, keeping payouts off the operator key. Empty = falls back to an operator mint; the operator auto-funds this wallet with SUI and DUSDC.
export const TREASURY_WALLET_PK: string = process.env.TREASURY_WALLET_PK || '';
export const TREASURY_MIN_SUI: number = Number(process.env.PIPS_TREASURY_MIN_SUI) || 20;
export const TREASURY_TOPUP_SUI: number = Number(process.env.PIPS_TREASURY_TOPUP_SUI) || 200;
// Treasury DUSDC reserve floor (display USD): holds only hand-transferred DUSDC (L-008, not mintable), so the floor is tiny.
export const TREASURY_MIN_DUSDC: number = Number(process.env.PIPS_TREASURY_MIN_DUSDC) || 5;
export const TREASURY_TOPUP_DUSDC: number = Number(process.env.PIPS_TREASURY_TOPUP_DUSDC) || 5_000_000;

// Revenue wallet gas. It used to be receive-only (the rake sink), but referral claims now SIGN payouts
// from it, so it needs a little SUI for gas (hand-funded, finite testnet SUI).
export const REVENUE_MIN_SUI: number = Number(process.env.PIPS_REVENUE_MIN_SUI) || 0.2;
export const REVENUE_TOPUP_SUI: number = Number(process.env.PIPS_REVENUE_TOPUP_SUI) || 0.5;

// Request DUSDC faucet. Each tap sends FAUCET_AMOUNT DUSDC, rate-limited to one per COOLDOWN_MS per user.
// Kept modest: the treasury is hand-funded and finite (L-008), a top-up, not a windfall.
export const FAUCET_AMOUNT: number = Number(process.env.PIPS_FAUCET_AMOUNT) || 20;
export const FAUCET_COOLDOWN_MS: number = Number(process.env.PIPS_FAUCET_COOLDOWN_MS) || 60 * 60 * 1000;

// Demo override, OFF by default. A valid bucket (2/5/10/25/100) forces I Feel Lucky to that bucket for a
// rehearsed demo (never demo a 100x lotto live, 08-DEMO-FLOW.md); asset/side stay random. DURATION optionally pins the round.
export const DEMO_LUCKY_LEVERAGE: number = Number(process.env.PIPS_DEMO_LUCKY_LEVERAGE) || 0;
export const DEMO_LUCKY_DURATION: number = Number(process.env.PIPS_DEMO_LUCKY_DURATION) || 0;

// Stake bounds per play (display DUSDC), enforced by the knob + play endpoints. Floors at the protocol's
// ~$1 min net premium (L-011) and caps tiny to protect finite DUSDC; MIN 1.5 clears $1 net after the ~12% fee headroom (1.5 * 0.88 = 1.32).
export const MIN_STAKE: number = Number(process.env.PIPS_MIN_STAKE) || 1.5;
export const MAX_STAKE: number = Number(process.env.PIPS_MAX_STAKE) || 3;

// Login re-fund (D2/D3). A returning user whose spendable chips fall below THRESHOLD gets topped back up to
// STARTING_BALANCE so they can keep playing. Play money, but the treasury is finite (L-008), so the refill is
// gated on threshold + a per-user cooldown + the treasury floor. Defaults respect an explicit 0 (Number('0')
// is falsy, so `|| default` would wrongly re-arm it), letting THRESHOLD=0 mean the literal balance==0 behavior.
export const REFILL_THRESHOLD: number =
  process.env.PIPS_REFILL_THRESHOLD != null && Number.isFinite(Number(process.env.PIPS_REFILL_THRESHOLD))
    ? Number(process.env.PIPS_REFILL_THRESHOLD)
    : MIN_STAKE;
export const REFILL_COOLDOWN_MS: number =
  process.env.PIPS_REFILL_COOLDOWN_MS != null && Number.isFinite(Number(process.env.PIPS_REFILL_COOLDOWN_MS))
    ? Number(process.env.PIPS_REFILL_COOLDOWN_MS)
    : 6 * 60 * 60 * 1000;

// Explicit "out of chips" grant (POST /wallet/grant, behind the game TOP UP + the on-load auto top-up).
// Same guarded top-up as the login refill but on a short cooldown, so a player who spends down to zero is
// never stuck on testnet. The treasury floor still caps the finite reserve. 0 respected via the finite check.
export const GRANT_COOLDOWN_MS: number =
  process.env.PIPS_GRANT_COOLDOWN_MS != null && Number.isFinite(Number(process.env.PIPS_GRANT_COOLDOWN_MS))
    ? Number(process.env.PIPS_GRANT_COOLDOWN_MS)
    : 60_000;

// House rake (revenue). A config-driven cut of every real play's stake, folded into position sizing (no fee
// line item) and collected atomically in the same mint PTB as a DUSDC transfer to the revenue wallet (lib/sui/house.ts). Default 150 bps (1.5%) stays below casino levels since PIPS is replay-heavy; empty REVENUE_WALLET_PK or a 0 edge disables it cleanly.
const rawHouseEdgeBps: string | undefined = process.env.PIPS_HOUSE_EDGE_BPS;
export const HOUSE_EDGE_BPS: bigint = BigInt(
  rawHouseEdgeBps != null && rawHouseEdgeBps !== '' && Number.isFinite(Number(rawHouseEdgeBps))
    ? Math.max(0, Math.round(Number(rawHouseEdgeBps)))
    : 150,
);
export const REVENUE_WALLET_PK: string = process.env.REVENUE_WALLET_PK || '';
// Below this net (display USD) the rake is skipped so it never breaches real Predict's ~$1 net-premium floor (L-011) plus fee headroom.
export const HOUSE_EDGE_MIN_NET_USD: number =
  Number(process.env.PIPS_HOUSE_EDGE_MIN_NET_USD) || 1.2;

// Referral revenue share. A referrer earns this cut of the house rake their referred users generate,
// paid from the revenue wallet as claimable DUSDC chips (services/referral.ts). Default 2500 bps (25%).
// Since the share (25% of the 1.5% fee = 0.375% of volume) is always smaller than the fee the referee
// pays, self-dealing loses money every round, so turning rewards on is inherently non-drainable.
// Changing it only re-prices UNCLAIMED balances; claimed amounts are snapshotted at claim time.
export const REFERRAL_SHARE_BPS: bigint = BigInt(
  process.env.PIPS_REFERRAL_SHARE_BPS != null && Number.isFinite(Number(process.env.PIPS_REFERRAL_SHARE_BPS))
    ? Math.max(0, Math.round(Number(process.env.PIPS_REFERRAL_SHARE_BPS)))
    : 2500,
);
// Dust guard: below this (display USD) a claim is refused; the balance keeps accruing until it clears.
export const REFERRAL_MIN_CLAIM_USD: number = Number(process.env.PIPS_REFERRAL_MIN_CLAIM_USD) || 1;

// Real-mode (testnet) strike sizing. A mint aborts if the strike's entry probability leaves [min, max]_entry_probability;
// a fixed-% strike sits several sigma OTM on a 20-60s BTC market, so we size it as z(p)*sigma instead (sigma = annual vol scaled by sqrt(time to expiry), p = the tier's target win prob). Band edges are unreadable pre-mint (L-012), so these stay conservative.
export const REAL_BTC_ANNUAL_VOL: number = Number(process.env.PIPS_REAL_BTC_ANNUAL_VOL) || 0.55;
// Floor on the target win probability we ask for (above the chain's unreadable min_entry_probability). Caps how
// far OTM a high tier may sit; multiplier tops out near 1/this before leverage.
export const REAL_STRIKE_MIN_PROB: number = Number(process.env.PIPS_REAL_STRIKE_MIN_PROB) || 0.06;
// Absolute guard cap on the strike offset (fraction of spot), in case the vol estimate runs hot.
export const REAL_STRIKE_MAX_OFFSET_FRAC: number = Number(process.env.PIPS_REAL_STRIKE_MAX_OFFSET_FRAC) || 0.006;
// Binary games (LUCKY, MOONSHOT) split each tier between leverage (clamped to the market cap) and OTM distance
// (LUCKY.md §5b): strikeTier = tier / leverageFrac, priced at p = 1/strikeTier. Targeting this prob (instead of a naive tier/2 leverage, which pins every uncapped tier ATM at p=0.5) keeps every tier above the 2x floor moving off ATM.
export const LEVERAGE_TARGET_WIN_PROB: number = Number(process.env.PIPS_LEVERAGE_TARGET_WIN_PROB) || 0.35;
// Floor on a binary strike's OTM distance, in units of the round's sigma. The 2x tier is a fair coinflip so
// it prices ATM (offset 0), which would sit the target on the entry line; this makes it a visible directional
// move (~0.3 sigma -> p~0.38, so a slightly-worse-than-2x bet). Sigma-scaled, not a fixed % of spot, so it
// stays inside the chain's admission band on a 20-60s round (L-013). Only bites the low tier; 3x+ sit further.
export const REAL_BINARY_MIN_OFFSET_SIGMA: number = Number(process.env.PIPS_REAL_BINARY_MIN_OFFSET_SIGMA) || 0.3;
// Upper target probability for a RANGE band. A wide centered band is near-certain (p~1), tripping
// max_entry_probability; cap the half-width so the band's prob stays under this. A too-tight user band is left as-is.
export const REAL_RANGE_MAX_PROB: number = Number(process.env.PIPS_REAL_RANGE_MAX_PROB) || 0.85;
// RANGE knob ladder: target win probabilities, safest first. A tier mints at 1x leverage so its payout is
// ~1/p whenever the tap lands; the band half-width (z((1+p)/2)*sigma) is what absorbs the clock. The two
// tightest rungs (~9x, ~15x) are the big-payout end; the chain admits asks down to 0.01 (~100x ceiling)
// and ticksForRange floors the band at one admission tick, so they stay mintable, with sim-calibrated quotes.
const RANGE_TIER_DEFAULTS = [0.85, 0.65, 0.45, 0.3, 0.18, 0.11, 0.065];
const rangeTierEnv = (process.env.PIPS_RANGE_TIER_PROBS ?? '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((p) => p >= 0.05 && p <= 0.9);
export const RANGE_TIER_PROBS: number[] = rangeTierEnv.length > 0 ? rangeTierEnv : RANGE_TIER_DEFAULTS;
// Game-round durations offered to the player (seconds). The on-chain expiry is the oracle's; this is the UX timer.
export const GAME_DURATIONS: number[] = (process.env.PIPS_GAME_DURATIONS || '10,30,60')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

// Minigame (Line Rider / Flappy Piper) run-validation window (services/leaderboard.ts). TTL is how long an
// opened run stays valid (generous, to cover a long Line Rider run); MIN_RUN_MS is the shortest run length accepted.
export const MINIGAME_RUN_TTL_S: number = Number(process.env.PIPS_MINIGAME_RUN_TTL_S) || 1200;
export const MINIGAME_MIN_RUN_MS: number = Number(process.env.PIPS_MINIGAME_MIN_RUN_MS) || 500;

// Settle worker cadence: how often the settle sweep redeems expired plays. Kept tight so results land ~1s after the buzzer.
export const SETTLE_CRON: string = process.env.PIPS_SETTLE_CRON || '*/1 * * * * *';
// Market discovery cadence: learns the live 1m BTC market set from chain and refreshes its spot for the
// chart. Sync near real time (~2s) or the served line lags the market the strike is priced/settled against.
export const MARKET_SYNC_CRON: string = process.env.PIPS_MARKET_SYNC_CRON || '*/2 * * * * *';
// Cap on-chain redeems per settle tick so a backlog drains gradually instead of monopolizing the settle
// executor. The rest carry over to the next tick.
export const SETTLE_MAX_REDEEMS_PER_TICK: number = Number(process.env.PIPS_SETTLE_MAX_REDEEMS_PER_TICK) || 6;
// Cap total plays examined per settle tick. A provable loss is finalized from chain reads with no redeem tx,
// so it no longer counts against the redeem budget; this bounds the read/DB burst if a big backlog expires at
// once (a restart), pacing it across ticks. Generous so steady-state settles clear in a single tick.
export const SETTLE_MAX_PLAYS_PER_TICK: number = Number(process.env.PIPS_SETTLE_MAX_PLAYS_PER_TICK) || 32;
// Stop streaming live prices this long before expiry so an in-flight mint can't race settlement.
export const EXPIRY_SAFETY_MS: number = Number(process.env.PIPS_EXPIRY_SAFETY_MS) || 5000;

// Live-PnL SSE (/stream/plays/:id). INTERVAL_MS = the tick; MARK_TTL_MS dedupes overlapping reads.
export const PLAY_STREAM_INTERVAL_MS: number = Number(process.env.PIPS_PLAY_STREAM_INTERVAL_MS) || 2500;
export const LIVE_MARK_TTL_MS: number = Number(process.env.PIPS_LIVE_MARK_TTL_MS) || 2000;

// Round durations a play routes to. LUCKY takes the market expiring nearest LUCKY_ROUND_MS out (a quick spin
// -> brief round -> instant settle); RANGE holds longer and takes the market expiring inside [RANGE_MIN, RANGE_MAX]_ORACLE_LIFE_MS so the band gets tested.
export const LUCKY_ROUND_MS: number = Number(process.env.PIPS_LUCKY_ROUND_MS) || 20_000;
export const RANGE_MIN_ORACLE_LIFE_MS: number = Number(process.env.PIPS_RANGE_MIN_ORACLE_LIFE_MS) || 20_000;
export const RANGE_MAX_ORACLE_LIFE_MS: number = Number(process.env.PIPS_RANGE_MAX_ORACLE_LIFE_MS) || 33_000;

// Error Log Configuration
export const ERROR_LOG_MAX_RECORDS: number = 10000;
export const ERROR_LOG_CLEANUP_INTERVAL: string = '0 * * * *'; // Every hour

// Deposit tracking cleanup (mainnet only): an execute-quote opens a PENDING row before the user broadcasts,
// so an abandoned confirm leaves a row with a null txHash. Any real bridge lands in <=20min and the balance
// live-reads chain, so a null-txHash row older than this is genuinely dead and gets swept. Correctness never
// depends on the table, this is pure housekeeping.
export const DEPOSIT_CLEANUP_CRON: string = process.env.PIPS_DEPOSIT_CLEANUP_CRON || '17 * * * *'; // hourly, off the 0 slot
export const DEPOSIT_STALE_HOURS: number = Number(process.env.PIPS_DEPOSIT_STALE_HOURS) || 24;

// Wallet activity indexer + token metadata worker (BALANCE_FEATURE). Both run only on real networks
// (testnet/mainnet), where the public Mysten GraphQL schema serves tx-history; localnet/devnet skip.
// The indexer is presence-gated (scans online users + a recently-active tail only), so idle app = ~0 calls.
export const WALLET_INDEX_CRON: string = process.env.PIPS_WALLET_INDEX_CRON || '*/2 * * * *'; // every 2 min
export const WALLET_INDEX_BATCH: number = Number(process.env.PIPS_WALLET_INDEX_BATCH) || 25; // users per tick
export const WALLET_INDEX_MAX_PAGES: number = Number(process.env.PIPS_WALLET_INDEX_MAX_PAGES) || 5; // GraphQL page budget per scan
// Low-cadence self-heal (§12b): re-scan a bounded recent window for recently-active users, ignoring the
// high-water mark, to backfill anything a GraphQL hiccup dropped.
export const WALLET_RECONCILE_CRON: string = process.env.PIPS_WALLET_RECONCILE_CRON || '23 * * * *'; // hourly, off the 0 slot
export const WALLET_RECONCILE_BATCH: number = Number(process.env.PIPS_WALLET_RECONCILE_BATCH) || 40;
export const WALLET_RECONCILE_ACTIVE_HOURS: number = Number(process.env.PIPS_WALLET_RECONCILE_ACTIVE_HOURS) || 48;
// Checkpoints the reconcile pass rewinds before re-scanning, to re-verify recent history + backfill a drop
// (idempotent, so over-scanning is always safe). The page budget still bounds the work.
export const WALLET_RECONCILE_LOOKBACK_CP: number = Number(process.env.PIPS_WALLET_RECONCILE_LOOKBACK_CP) || 2000;
// On-demand /wallet/sync: per-user min interval (anti-spam, like the faucet cooldown) + the staleness
// threshold that triggers a light repair-on-read when the activity feed is opened.
export const WALLET_SYNC_MIN_INTERVAL_MS: number = Number(process.env.PIPS_WALLET_SYNC_MIN_INTERVAL_MS) || 3000;
export const WALLET_SYNC_STALE_MS: number = Number(process.env.PIPS_WALLET_SYNC_STALE_MS) || 120_000;
// Token metadata/price refresh: chill cadence, off the request path. Batch bounds the per-tick work.
export const TOKEN_SYNC_CRON: string = process.env.PIPS_TOKEN_SYNC_CRON || '*/10 * * * *'; // every 10 min
export const TOKEN_SYNC_BATCH: number = Number(process.env.PIPS_TOKEN_SYNC_BATCH) || 50;
