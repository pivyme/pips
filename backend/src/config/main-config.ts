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

// Sui network. localnet/devnet run OUR vendored Predict fork; testnet AND mainnet are Mysten's OFFICIAL
// Predict (L-005). Mainnet is the clean re-point of the testnet real path: same code, its own deploy record.
export const SUI_NETWORK: string = process.env.SUI_NETWORK || 'testnet';
// The one dispatch seam: true = real-protocol path (predict-real + config-real + real market-sync), false =
// fork path (predict.ts + config.ts). No third mode/flag: testnet and mainnet both mean real, fork is
// localnet/devnet only.
export const IS_REAL_PREDICT: boolean = SUI_NETWORK === 'testnet' || SUI_NETWORK === 'mainnet';
export const SUI_FULLNODE_URL: string = process.env.SUI_FULLNODE_URL || '';
// GraphQL endpoint for historical queries (events / tx-history) gRPC v2 can't serve. Override with SUI_GRAPHQL_URL.
const DEFAULT_GRAPHQL_URL: Record<string, string> = {
  mainnet: 'https://graphql.mainnet.sui.io/graphql',
  testnet: 'https://graphql.testnet.sui.io/graphql',
  devnet: 'https://graphql.devnet.sui.io/graphql',
};
export const SUI_GRAPHQL_URL: string =
  process.env.SUI_GRAPHQL_URL || DEFAULT_GRAPHQL_URL[SUI_NETWORK] || DEFAULT_GRAPHQL_URL.devnet;
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

// Display pin tuning (price-bus.ts, real mode only, display-only per L-015). TAU: speed the smoothed offset
// pulls the line to the oracle. SLEW: max offset correction/sec. REENTRY: healthy Binance streak before resuming after an outage. BUZZER: converge fully before expiry.
export const PRICE_PIN_TAU_MS: number = Number(process.env.PIPS_PRICE_PIN_TAU_MS) || 1200;
export const PRICE_PIN_SLEW_FRAC_PER_SEC: number = Number(process.env.PIPS_PRICE_PIN_SLEW_FRAC_PER_SEC) || 0.004;
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

// DUSDC starting balance per new user (6dp). Network-scoped: the fork mints freely so it hands out a fat stack;
// testnet-real chips come only from a hand-funded treasury (L-008), so new users get just enough for a couple of real plays without draining the finite reserve.
export const STARTING_BALANCE: number = Number(process.env.PIPS_STARTING_BALANCE) || (IS_REAL_PREDICT ? 3 : 1000);

// Free SUI for gas on localnet. The operator funds each user once at onboarding and tops up below the floor, so
// nobody gets stuck. The floor sits above PLAY_GAS_BUDGET so an unsponsored play is affordable; sponsored, a user needs no SUI.
export const GAS_FUND_SUI: number = Number(process.env.PIPS_GAS_FUND_SUI) || 2;
export const GAS_MIN_SUI: number = Number(process.env.PIPS_GAS_MIN_SUI) || 0.6;

// Pinned gas budget per play (MIST). Pinning skips tx.build's dryRun round-trip (sponsored build 1.13s -> 0.64s).
// A real mint's gross gas is ~0.21 SUI (mostly rebated same-tx), so 0.5 SUI covers it with headroom yet caps a pathological tx from draining the finite testnet sponsor.
export const PLAY_GAS_BUDGET: bigint = BigInt(process.env.PIPS_PLAY_GAS_BUDGET || 500_000_000);

// Gas sponsorship (privy mode). One wallet pays gas for every user play so users only ever hold DUSDC: the tx
// names it as gas OWNER with an EMPTY payment, so gas draws from its SUI address balance, not an owned coin, so concurrent plays can't equivocate. Empty key = off (falls back to per-user funding).
export const GAS_SPONSORSHIP_WALLET_PK: string = process.env.GAS_SPONSORSHIP_WALLET_PK || '';
// When the sponsor's SUI dips below MIN, the operator moves TOPUP into its address balance (the working buffer);
// the rest stays as owned coins, the readable reserve play-safety.ts watches. Fork moves a big buffer, testnet-real a tiny one so a hand-funded sponsor isn't drained at once.
export const SPONSOR_MIN_SUI: number = Number(process.env.PIPS_SPONSOR_MIN_SUI) || 50;
export const SPONSOR_TOPUP_SUI: number =
  Number(process.env.PIPS_SPONSOR_TOPUP_SUI) || (IS_REAL_PREDICT ? 0.2 : 500);

// Real-mode (testnet) sponsor safety layer (play-safety.ts). Testnet SUI is finite (L-008): RATE_LIMIT_MS is a
// per-user play cooldown (0 = off, fork default), FLOOR_SUI pauses new plays until the reserve recovers, BURN_WARN_SUI/MONITOR_CRON log burn rate (real mode only).
export const PLAY_RATE_LIMIT_MS: number =
  process.env.PIPS_PLAY_RATE_LIMIT_MS != null ? Number(process.env.PIPS_PLAY_RATE_LIMIT_MS) : IS_REAL_PREDICT ? 3000 : 0;
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
// Treasury DUSDC reserve floor. Network-scoped: the fork keeps a huge minted reserve; testnet-real holds only
// hand-transferred DUSDC (L-008), so the floor is tiny and TOPUP is inert (not mintable in real mode, just warns).
export const TREASURY_MIN_DUSDC: number = Number(process.env.PIPS_TREASURY_MIN_DUSDC) || (IS_REAL_PREDICT ? 5 : 1_000_000);
export const TREASURY_TOPUP_DUSDC: number = Number(process.env.PIPS_TREASURY_TOPUP_DUSDC) || 5_000_000;

// Revenue wallet gas. It used to be receive-only (the rake sink), but referral claims now SIGN payouts
// from it, so it needs a little SUI for gas. Operator-topped like the other ops wallets. Tiny on
// testnet-real (finite hand-funded SUI), generous on the fork where SUI is free.
export const REVENUE_MIN_SUI: number = Number(process.env.PIPS_REVENUE_MIN_SUI) || (IS_REAL_PREDICT ? 0.2 : 20);
export const REVENUE_TOPUP_SUI: number = Number(process.env.PIPS_REVENUE_TOPUP_SUI) || (IS_REAL_PREDICT ? 0.5 : 200);

// Request DUSDC faucet. Each tap sends FAUCET_AMOUNT DUSDC, rate-limited to one per COOLDOWN_MS per user.
// Network-scoped amount: big on the fork, tiny on testnet-real (hand-funded finite treasury: one more play, not a windfall).
export const FAUCET_AMOUNT: number = Number(process.env.PIPS_FAUCET_AMOUNT) || (IS_REAL_PREDICT ? 2 : 500);
export const FAUCET_COOLDOWN_MS: number = Number(process.env.PIPS_FAUCET_COOLDOWN_MS) || 60_000;

// Demo override, OFF by default. A valid bucket (2/5/10/25/100) forces I Feel Lucky to that bucket for a
// rehearsed demo (never demo a 100x lotto live, 08-DEMO-FLOW.md); asset/side stay random. DURATION optionally pins the round.
export const DEMO_LUCKY_LEVERAGE: number = Number(process.env.PIPS_DEMO_LUCKY_LEVERAGE) || 0;
export const DEMO_LUCKY_DURATION: number = Number(process.env.PIPS_DEMO_LUCKY_DURATION) || 0;

// Stake bounds per play (display DUSDC), enforced by the knob + play endpoints. Testnet-real floors at the
// protocol's ~$1 min net premium (L-011) and caps tiny to protect finite DUSDC; MIN 1.5 clears $1 net after the ~12% fee headroom (1.5 * 0.88 = 1.32). Fork keeps the wide band.
export const MIN_STAKE: number = Number(process.env.PIPS_MIN_STAKE) || (IS_REAL_PREDICT ? 1.5 : 1);
export const MAX_STAKE: number = Number(process.env.PIPS_MAX_STAKE) || (IS_REAL_PREDICT ? 3 : 100);

// House rake (revenue). A config-driven cut of every real play's stake, folded into position sizing (no fee
// line item) and collected atomically in the same mint PTB as a DUSDC transfer to the revenue wallet (lib/sui/house.ts). Default 150 bps (1.5%) stays below casino levels since PIPS is replay-heavy; empty REVENUE_WALLET_PK or a 0 edge disables it cleanly.
const rawHouseEdgeBps: string | undefined = process.env.PIPS_HOUSE_EDGE_BPS;
export const HOUSE_EDGE_BPS: bigint = BigInt(
  rawHouseEdgeBps != null && rawHouseEdgeBps !== '' && Number.isFinite(Number(rawHouseEdgeBps))
    ? Math.max(0, Math.round(Number(rawHouseEdgeBps)))
    : 150,
);
export const REVENUE_WALLET_PK: string = process.env.REVENUE_WALLET_PK || '';
// Below this net (display USD) the rake is skipped so it never breaches real Predict's ~$1 net-premium floor
// (L-011) plus fee headroom. Fork has no such floor, so 0 (rake applies down to the fork's $1 MIN_STAKE).
export const HOUSE_EDGE_MIN_NET_USD: number =
  Number(process.env.PIPS_HOUSE_EDGE_MIN_NET_USD) || (IS_REAL_PREDICT ? 1.2 : 0);

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
// Game-round durations offered to the player (seconds). The on-chain expiry is the oracle's; this is the UX timer.
export const GAME_DURATIONS: number[] = (process.env.PIPS_GAME_DURATIONS || '10,30,60')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

// Minigame (Line Rider / Flappy Piper) run-validation window (services/leaderboard.ts). TTL is how long an
// opened run stays valid (generous, to cover a long Line Rider run); MIN_RUN_MS is the shortest run length accepted.
export const MINIGAME_RUN_TTL_S: number = Number(process.env.PIPS_MINIGAME_RUN_TTL_S) || 1200;
export const MINIGAME_MIN_RUN_MS: number = Number(process.env.PIPS_MINIGAME_MIN_RUN_MS) || 500;

// Operator workers (price-pusher / oracle-roll / settle). OFF by default: it's the single-leader switch, set true
// on exactly ONE instance (the operator) so oracles aren't double-pushed. LUCKY 30s cadence: push spot ~1s, roll the ladder ~5s, settle ~1s so results land ~1s after the buzzer.
export const OPERATOR_ENABLED: boolean = process.env.PIPS_OPERATOR_ENABLED === 'true';
export const PRICE_PUSH_CRON: string = process.env.PIPS_PRICE_PUSH_CRON || '*/1 * * * * *';
export const ORACLE_ROLL_CRON: string = process.env.PIPS_ORACLE_ROLL_CRON || '*/5 * * * * *';
export const SETTLE_CRON: string = process.env.PIPS_SETTLE_CRON || '*/1 * * * * *';
// Follower market discovery cadence (only when OPERATOR_ENABLED is false): learns the live oracle set from chain
// and refreshes each oracle's spot for the follower chart. Sync at push cadence (~2s) or the served line lags the oracle the strike is priced/settled against.
export const MARKET_SYNC_CRON: string = process.env.PIPS_MARKET_SYNC_CRON || '*/2 * * * * *';
// Cap on-chain redeems per settle tick so a backlog drains gradually instead of monopolizing the one serial
// operator executor (shared with oracle-roll). The rest carry over to the next tick.
export const SETTLE_MAX_REDEEMS_PER_TICK: number = Number(process.env.PIPS_SETTLE_MAX_REDEEMS_PER_TICK) || 6;
// Stop streaming live prices this long before expiry so an in-flight mint can't race settlement (gotcha #3, 05-SUI-PREDICT.md).
export const EXPIRY_SAFETY_MS: number = Number(process.env.PIPS_EXPIRY_SAFETY_MS) || 5000;

// Live-PnL SSE (/stream/plays/:id). The mark is a real per-play devInspect (~1.5s on the remote node), so a 2.5s
// tick + short mark cache cuts node load ~60% with no felt loss. INTERVAL_MS = the tick; MARK_TTL_MS dedupes overlapping reads.
export const PLAY_STREAM_INTERVAL_MS: number = Number(process.env.PIPS_PLAY_STREAM_INTERVAL_MS) || 2500;
export const LIVE_MARK_TTL_MS: number = Number(process.env.PIPS_LIVE_MARK_TTL_MS) || 2000;

// Game volatility. Real spot is too quiet over a 30-60s round, so a synthetic Pyth-anchored vol layer
// (lib/game-price.ts) is the SINGLE source for chart stream, oracle push, and settle price, so what the player sees is what settles. 2 = tuned default (~1.2% move/30s), 0 = off. Must track IMPLIED_VOL or a play just bleeds.
export const GAME_VOL: number =
  process.env.PIPS_GAME_VOL != null && process.env.PIPS_GAME_VOL !== '' ? Number(process.env.PIPS_GAME_VOL) : 2;

// Implied vol the binary is priced at (fed into the oracle SVI surface in predict.ts). The biggest game-feel knob:
// too high and plays feel dead with big multipliers unreachable, too low and the near grid can't resolve. Keep ~1.5-2.5x GAME_VOL; 0.03 with GAME_VOL 2 puts 2x ATM, 25x ~5% OTM.
export const IMPLIED_VOL: number =
  process.env.PIPS_IMPLIED_VOL != null && process.env.PIPS_IMPLIED_VOL !== '' ? Number(process.env.PIPS_IMPLIED_VOL) : 0.03;

// Oracle ladder (LUCKY tier). A play settles at its oracle's expiry, and LIFETIME is decoupled from ROUND length:
// a short-lived oracle could expire mid-setup (create + activate are serial, aborts EOracleExpired). So oracles live well past the round, staggered per asset, and each play routes to the one expiring nearest LUCKY_ROUND_MS out (gotcha #11).
export const ORACLE_ASSETS: string[] = (process.env.PIPS_ORACLE_ASSETS || 'BTC,SUI,ETH')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
// How long a fresh oracle lives. Must exceed LUCKY_ROUND_MS so create+activate never races expiry; also bridges
// an operator restart, since an oracle with more life left than the downtime stays live through the gap. Scale ORACLE_LADDER_DEPTH with it so per-rung spacing (LIFETIME/DEPTH) stays put.
export const ORACLE_LIFETIME_MS: number = Number(process.env.PIPS_ORACLE_LIFETIME_MS) || 180_000;
// The LUCKY round target: each play routes to the oracle expiring nearest this far out. Kept short for a quick
// thrill: spin (reels ~2s) -> a brief watchable round -> instant settle.
export const LUCKY_ROUND_MS: number = Number(process.env.PIPS_LUCKY_ROUND_MS) || 20_000;
// Minimum oracle life a LUCKY play routes to, since the background mint must land before expiry (else
// EOracleExpired -> re-route). Falls back to the longest-lived live oracle when nothing clears the bar. Must exceed mint time, which spikes under congestion.
export const LUCKY_MIN_ORACLE_LIFE_MS: number = Number(process.env.PIPS_LUCKY_MIN_ORACLE_LIFE_MS) || 13_000;
// RANGE round bounds (hold-the-band): holds longer than LUCKY's spin so the band gets tested. A play takes the
// longest live oracle expiring inside this window (~22-30s); narrower than the rung spacing so it can be momentarily empty, the router then waits a beat for a rung to age in (see rangeOracle).
export const RANGE_MIN_ORACLE_LIFE_MS: number = Number(process.env.PIPS_RANGE_MIN_ORACLE_LIFE_MS) || 20_000;
export const RANGE_MAX_ORACLE_LIFE_MS: number = Number(process.env.PIPS_RANGE_MAX_ORACLE_LIFE_MS) || 33_000;
// Smallest distance a LUCKY target sits from entry (fraction of spot; the solver also floors at one grid tick),
// keeping every target, even the 2x floor, a real directional move that never renders on the ENTRY line.
export const LUCKY_MIN_TARGET_FRAC: number = Number(process.env.PIPS_LUCKY_MIN_TARGET_FRAC) || 0.0015;
// Oracles kept live per asset, spread evenly across the lifetime (~LIFETIME/depth apart) so a near-round one
// always exists. Higher gives more buffer when the operator falls behind; scale with LIFETIME to hold ~11s spacing.
export const ORACLE_LADDER_DEPTH: number = Number(process.env.PIPS_ORACLE_LADDER_DEPTH) || 16;
// Max oracles oracle-roll creates per asset per tick. Steady state needs 1 (spacing-gated), but after a reload/dry
// spell the roller bursts up to this (spacing bypassed) so the ladder refills in seconds. Free localnet gas.
export const ORACLE_ROLL_MAX_PER_TICK: number = Number(process.env.PIPS_ORACLE_ROLL_MAX_PER_TICK) || 3;
// Reclaim a settled oracle's strike matrix for its storage rebate. Only worth it on a gas-scarce chain; on free
// localnet it's pure extra serial-queue load, so off.
export const ORACLE_COMPACT_SETTLED: boolean = process.env.PIPS_ORACLE_COMPACT_SETTLED === 'true';

// Devnet faucet top-up worker. Devnet's public faucet is the only SUI source and wipes ~weekly, so this refills
// the crucial wallets (operator/settlement/treasury/sponsor) every minute, verifying each drip landed since the public faucet silently rate-limits otherwise. Devnet only; DEVNET_FAUCET_URL overrides the faucet host.
export const DEVNET_FAUCET_ENABLED: boolean = process.env.PIPS_DEVNET_FAUCET_ENABLED !== 'false';
export const DEVNET_FAUCET_URL: string = (process.env.PIPS_DEVNET_FAUCET_URL || '').trim().replace(/\/$/, '');
// Aggressive by default: the operator burns SUI fast (oracle storage), refilling below MIN up to TARGET. Only
// sane against a no-rate-limit faucet; TARGET must sit above the operator's gas budget (1 SUI).
export const DEVNET_FAUCET_MIN_SUI: number = Number(process.env.PIPS_DEVNET_FAUCET_MIN_SUI) || 1000;
export const DEVNET_FAUCET_TARGET_SUI: number = Number(process.env.PIPS_DEVNET_FAUCET_TARGET_SUI) || 5000;
// Requests fire in parallel batches so a high TARGET fills in seconds. BATCH = concurrent per round; MAX_REQUESTS
// caps total requests per wallet per tick (a cold fill from 0 to TARGET).
export const DEVNET_FAUCET_BATCH: number = Number(process.env.PIPS_DEVNET_FAUCET_BATCH) || 20;
export const DEVNET_FAUCET_MAX_REQUESTS: number = Number(process.env.PIPS_DEVNET_FAUCET_MAX_REQUESTS) || 2000;
export const DEVNET_FAUCET_GAP_MS: number = Number(process.env.PIPS_DEVNET_FAUCET_GAP_MS) || 250;
export const DEVNET_FAUCET_CRON: string = process.env.PIPS_DEVNET_FAUCET_CRON || '*/1 * * * *';
export const DEVNET_FAUCET_EXTRA: string[] = (
  process.env.PIPS_DEVNET_FAUCET_EXTRA || '0x4eddfba6fcb9a6c5e14476299a03173fdcaf0bbc06cac505db262ee27eea4a0c'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Self-heal watcher (deploy-watch.ts). Polls the shared DB for a fresh deploy record and restarts the process to
// adopt new ids after a devnet-wipe recovery. ON in production (container restarts on exit), OFF locally so it never kills a `bun dev` follower.
export const DEPLOY_WATCH_ENABLED: boolean =
  process.env.PIPS_DEPLOY_WATCH_ENABLED !== undefined
    ? process.env.PIPS_DEPLOY_WATCH_ENABLED === 'true'
    : IS_PROD;
export const DEPLOY_WATCH_CRON: string = process.env.PIPS_DEPLOY_WATCH_CRON || '*/20 * * * * *';

// Self-publish: when the operator detects its Predict package is gone (a devnet wipe), it republishes the whole
// stack itself (spawns scripts/devnet-refresh.sh recover) and restarts onto the fresh ids. Only the operator box (its image carries the sui CLI + contracts/ + scripts/); off by default, cooldown-retried so an outage doesn't spam republishes.
export const SELF_PUBLISH: boolean = process.env.PIPS_SELF_PUBLISH === 'true';
export const SELF_PUBLISH_COOLDOWN_MS: number = Number(process.env.PIPS_SELF_PUBLISH_COOLDOWN_MS) || 5 * 60 * 1000;

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
  DB_POOL_MAX,
  SHUTDOWN_TIMEOUT_MS,
  ALERT_WEBHOOK_URL,
  ALERT_DEDUPE_MS,
  RATE_LIMIT_WINDOW,
  RATE_LIMIT_GLOBAL_MAX,
  RATE_LIMIT_AUTH_MAX,
  RATE_LIMIT_FAUCET_MAX,
  RATE_LIMIT_WITHDRAW_MAX,
  RATE_LIMIT_REFERRAL_CLAIM_MAX,
  RATE_LIMIT_QUOTE_MAX,
  LIFI_API_URL,
  LIFI_API_KEY,
  LIFI_INTEGRATOR,
  LIFI_TIMEOUT_MS,
  BRIDGE_EXECUTE_ENABLED,
  DEPOSIT_MIN_USD,
  DEPOSIT_HARD_MIN_USD,
  DEPOSIT_SLIPPAGE,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  ALLOWED_ORIGIN,
  AUTH_MODE,
  DEMO_LUCKY_LEVERAGE,
  DEMO_LUCKY_DURATION,
  MIN_STAKE,
  MAX_STAKE,
  HOUSE_EDGE_BPS,
  REVENUE_WALLET_PK,
  HOUSE_EDGE_MIN_NET_USD,
  REFERRAL_SHARE_BPS,
  REFERRAL_MIN_CLAIM_USD,
  GAME_DURATIONS,
  MINIGAME_RUN_TTL_S,
  MINIGAME_MIN_RUN_MS,
  SUI_NETWORK,
  IS_REAL_PREDICT,
  SUI_FULLNODE_URL,
  SUI_GRAPHQL_URL,
  TESTING_WALLET_PK,
  BINANCE_ENABLED,
  BINANCE_WS_URL,
  BINANCE_STALE_MS,
  BINANCE_SYMBOLS,
  PRICE_WS_BROADCAST_MS,
  PRICE_PIN_TAU_MS,
  PRICE_PIN_SLEW_FRAC_PER_SEC,
  PRICE_PIN_REENTRY_MS,
  PRICE_PIN_BUZZER_MS,
  PRIVY_APP_ID,
  PRIVY_APP_SECRET,
  PRIVY_AUTHORIZATION_KEY_ID,
  PRIVY_AUTHORIZATION_PRIVATE_KEY,
  PRIVY_JWT_VERIFICATION_KEY,
  WALLET_AUTH_ENABLED,
  WALLET_ENCRYPTION_KEY,
  PYTH_HERMES_URL,
  STARTING_BALANCE,
  GAS_FUND_SUI,
  GAS_MIN_SUI,
  PLAY_GAS_BUDGET,
  GAS_SPONSORSHIP_WALLET_PK,
  SPONSOR_MIN_SUI,
  SPONSOR_TOPUP_SUI,
  PLAY_RATE_LIMIT_MS,
  SPONSOR_FLOOR_SUI,
  SPONSOR_BURN_WARN_SUI,
  SPONSOR_MONITOR_CRON,
  SETTLEMENT_WALLET_PK,
  SETTLEMENT_MIN_SUI,
  SETTLEMENT_TOPUP_SUI,
  TREASURY_WALLET_PK,
  TREASURY_MIN_SUI,
  TREASURY_TOPUP_SUI,
  TREASURY_MIN_DUSDC,
  TREASURY_TOPUP_DUSDC,
  REVENUE_MIN_SUI,
  REVENUE_TOPUP_SUI,
  FAUCET_AMOUNT,
  FAUCET_COOLDOWN_MS,
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
  LUCKY_MIN_TARGET_FRAC,
  RANGE_MIN_ORACLE_LIFE_MS,
  RANGE_MAX_ORACLE_LIFE_MS,
  ORACLE_LADDER_DEPTH,
  ORACLE_ROLL_MAX_PER_TICK,
  ORACLE_COMPACT_SETTLED,
  DEVNET_FAUCET_ENABLED,
  DEVNET_FAUCET_URL,
  DEVNET_FAUCET_MIN_SUI,
  DEVNET_FAUCET_TARGET_SUI,
  DEVNET_FAUCET_BATCH,
  DEVNET_FAUCET_MAX_REQUESTS,
  DEVNET_FAUCET_GAP_MS,
  DEVNET_FAUCET_CRON,
  DEVNET_FAUCET_EXTRA,
  DEPLOY_WATCH_ENABLED,
  DEPLOY_WATCH_CRON,
  SELF_PUBLISH,
  SELF_PUBLISH_COOLDOWN_MS,
  PREDICT_PACKAGE_ID,
  PREDICT_REGISTRY_ID,
  PREDICT_OBJECT_ID,
  PREDICT_ADMIN_CAP_ID,
  ERROR_LOG_MAX_RECORDS,
  ERROR_LOG_CLEANUP_INTERVAL,
};
