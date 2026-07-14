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

// Sui network. localnet/devnet run OUR vendored Predict fork; testnet is Mysten's OFFICIAL Predict
// deployment (never our fork again, L-005). The dev key doubles as the fork operator on localnet/devnet.
export const SUI_NETWORK: string = process.env.SUI_NETWORK || 'testnet';
// The one dispatch seam for the real protocol. When true, plays/discovery/settle route through the
// real-protocol path (predict-real.ts + config-real.ts + real-mode market-sync); when false the fork
// path (predict.ts + config.ts) runs unchanged. No third mode/flag: testnet always means real.
export const IS_REAL_PREDICT: boolean = SUI_NETWORK === 'testnet';
export const SUI_FULLNODE_URL: string = process.env.SUI_FULLNODE_URL || '';
// GraphQL endpoint for historical queries (events / tx-history) that fullnode gRPC v2 can't serve.
// Defaults per network; override with SUI_GRAPHQL_URL. Mysten hosts one per public network.
const DEFAULT_GRAPHQL_URL: Record<string, string> = {
  mainnet: 'https://graphql.mainnet.sui.io/graphql',
  testnet: 'https://graphql.testnet.sui.io/graphql',
  devnet: 'https://graphql.devnet.sui.io/graphql',
};
export const SUI_GRAPHQL_URL: string =
  process.env.SUI_GRAPHQL_URL || DEFAULT_GRAPHQL_URL[SUI_NETWORK] || DEFAULT_GRAPHQL_URL.devnet;
export const TESTING_WALLET_PK: string = process.env.TESTING_WALLET_PK || '';
export const PYTH_HERMES_URL: string = process.env.PYTH_HERMES_URL || 'https://hermes.pyth.network';

// Realtime chart display feed (Binance). Real mode (testnet) + mainnet only: the chart LINE gets its
// MOTION from a single shared Binance aggTrade websocket (many ticks/sec), while its LEVEL stays
// EMA-pinned to the on-chain oracle in price-bus.ts. Strictly display-only, it never records or settles
// anything (L-015). In fork mode the socket never opens and displaySpot falls straight through to the
// on-chain gameSpot, byte-identical to before. A geo-block or outage just drops to that same fallback.
export const BINANCE_ENABLED: boolean = process.env.PIPS_BINANCE_ENABLED !== 'false';
// Combined-stream base URL; the `?streams=` query is built from BINANCE_SYMBOLS. Point this at
// binance.us or a small relay if the deploy region is geo-blocked (the fallback ladder makes a block
// non-fatal either way, so this is an upside knob, not a hard dependency).
export const BINANCE_WS_URL: string = process.env.PIPS_BINANCE_WS_URL || 'wss://stream.binance.com:9443/stream';
// No aggTrade message for this long marks the feed stale, so the ladder falls back to the on-chain spot.
export const BINANCE_STALE_MS: number = Number(process.env.PIPS_BINANCE_STALE_MS) || 5000;
// asset -> Binance stream symbol (lowercase). Drives which combined streams we subscribe to and the
// reverse lookup on each message. Format: 'BTC:btcusdt,ETH:ethusdt,SUI:suiusdt'.
export const BINANCE_SYMBOLS: Record<string, string> = Object.fromEntries(
  (process.env.PIPS_BINANCE_SYMBOLS || 'BTC:btcusdt,ETH:ethusdt,SUI:suiusdt')
    .split(',')
    .map((pair) => pair.split(':').map((s) => s.trim()))
    .filter(([asset, sym]) => asset && sym)
    .map(([asset, sym]) => [asset.toUpperCase(), sym.toLowerCase()]),
);

// WebSocket price hub (/ws) broadcast cadence. One shared server-side loop per active asset reads the
// display bus ONCE per tick and fans the same value to every subscriber on the same frame, so every
// user's chart is in lock-step. 100ms = 10Hz, fast enough to feel live without fighting the 60fps game
// canvas. The client interpolates between frames with a time-constant ease.
export const PRICE_WS_BROADCAST_MS: number = Number(process.env.PIPS_PRICE_WS_BROADCAST_MS) || 100;

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

// Native Sui wallet-connect login (custodial play-wallet model), independent of AUTH_MODE. When on,
// /auth/wallet/* is exposed: a user proves they own an external Sui wallet by signing a nonce, then
// the server provisions a per-user custodial play wallet and signs their plays with it (the fast
// no-popup loop, same as privy). WALLET_ENCRYPTION_KEY (32 bytes, hex64 or base64-32) encrypts those
// custodial keys at rest, required when enabled. `openssl rand -hex 32`.
export const WALLET_AUTH_ENABLED: boolean = process.env.PIPS_WALLET_AUTH_ENABLED === 'true';
export const WALLET_ENCRYPTION_KEY: string = process.env.PIPS_WALLET_ENCRYPTION_KEY || '';

// DUSDC starting balance per new user, display units (6dp DUSDC). Network-scoped: the fork mints freely
// on localnet so it hands out a fat stack; testnet-real chips come only from a hand-funded treasury
// (L-008, never a mint), so a new user gets just enough for a couple of real plays (the protocol floors
// a mint at ~$1, L-011), keeping the finite reserve from draining on the first login.
export const STARTING_BALANCE: number = Number(process.env.PIPS_STARTING_BALANCE) || (IS_REAL_PREDICT ? 3 : 1000);

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
// staying under the funded floor above. Sponsored, it is drawn from the sponsor. This 0.5 SUI cap is
// already testnet-sane (well above the ~0.21 gross, so a mint never overruns it, yet a bounded ceiling
// so a pathological tx can't drain the finite testnet sponsor); tighten via env once measured on chain.
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
// TOPUP is the working buffer moved into the gas accumulator per warm-up; the rest stays as owned SUI
// coins (the readable reserve the pause floor watches, see play-safety.ts). Network-scoped: free
// localnet moves a big buffer; testnet-real moves a tiny one so a hand-funded sponsor isn't drained
// into the unreadable accumulator in one shot (leaving no readable reserve to gate on).
export const SPONSOR_MIN_SUI: number = Number(process.env.PIPS_SPONSOR_MIN_SUI) || 50;
export const SPONSOR_TOPUP_SUI: number =
  Number(process.env.PIPS_SPONSOR_TOPUP_SUI) || (IS_REAL_PREDICT ? 0.2 : 500);

// Real-mode (testnet) sponsor safety layer (play-safety.ts). Testnet SUI is finite and not ours to
// faucet (L-008), so a real-mode play is guarded without ever silently dropping a legit play:
//  - PLAY_RATE_LIMIT_MS: per-user cooldown between plays (in-memory anti-burn). 0 = off (fork default).
//  - SPONSOR_FLOOR_SUI: when the sponsor's readable SUI reserve dips below this, PAUSE new plays with a
//    clear user state and auto-resume when it recovers (topped up by hand on testnet, no faucet).
//  - SPONSOR_BURN_WARN_SUI: log a warning when one monitor interval burns more than this much SUI.
//  - SPONSOR_MONITOR_CRON: how often the monitor re-reads the reserve + logs burn (real mode only).
export const PLAY_RATE_LIMIT_MS: number =
  process.env.PIPS_PLAY_RATE_LIMIT_MS != null ? Number(process.env.PIPS_PLAY_RATE_LIMIT_MS) : IS_REAL_PREDICT ? 3000 : 0;
export const SPONSOR_FLOOR_SUI: number = Number(process.env.PIPS_SPONSOR_FLOOR_SUI) || 0.5;
export const SPONSOR_BURN_WARN_SUI: number = Number(process.env.PIPS_SPONSOR_BURN_WARN_SUI) || 0.2;
export const SPONSOR_MONITOR_CRON: string = process.env.PIPS_SPONSOR_MONITOR_CRON || '*/30 * * * * *';

// Settlement wallet. The permissionless settle-redeem sweep signs with THIS wallet instead of the
// operator, so a slow/backed-up redeem runs on its own gas coin + serial queue and can't head-of-line
// block the operator's price-push + oracle-nudge lane (they share one serial gas coin, the root of the
// "slow/failed spins" churn). Empty = redeems fall back to the operator wallet (legacy single-wallet).
// Only USED on the operator (the redeem sweep is operator-gated); the operator auto-funds it with SUI.
export const SETTLEMENT_WALLET_PK: string = process.env.SETTLEMENT_WALLET_PK || '';
export const SETTLEMENT_MIN_SUI: number = Number(process.env.PIPS_SETTLEMENT_MIN_SUI) || 50;
export const SETTLEMENT_TOPUP_SUI: number = Number(process.env.PIPS_SETTLEMENT_TOPUP_SUI) || 500;

// Treasury wallet. Holds a big pre-minted DUSDC reserve and pays out user chips (onboarding starting
// balance + the Request DUSDC faucet) via a plain transfer, NOT an operator mint. That keeps DUSDC
// payouts off the operator key entirely: a follower never signs an operator tx and the operator's gas
// coin never churns on mints. Empty = payouts fall back to an operator mint (legacy). The operator
// auto-funds it with SUI (its own gas) and mints the DUSDC reserve into it.
export const TREASURY_WALLET_PK: string = process.env.TREASURY_WALLET_PK || '';
export const TREASURY_MIN_SUI: number = Number(process.env.PIPS_TREASURY_MIN_SUI) || 20;
export const TREASURY_TOPUP_SUI: number = Number(process.env.PIPS_TREASURY_TOPUP_SUI) || 200;
// Treasury DUSDC reserve floor. Network-scoped: the fork keeps a huge minted reserve; testnet-real
// holds only what a human transferred in (L-008), so the floor is a tiny dollar figure and TOPUP is
// inert (DUSDC is not mintable in real mode, so ensureTreasuryFunded just warns to top up by hand).
export const TREASURY_MIN_DUSDC: number = Number(process.env.PIPS_TREASURY_MIN_DUSDC) || (IS_REAL_PREDICT ? 5 : 1_000_000);
export const TREASURY_TOPUP_DUSDC: number = Number(process.env.PIPS_TREASURY_TOPUP_DUSDC) || 5_000_000;

// Request DUSDC faucet. Each tap sends FAUCET_AMOUNT display DUSDC to the user, rate-limited to one
// tap per FAUCET_COOLDOWN_MS per user (in-memory, anti-spam). Network-scoped amount: big on the free
// fork, tiny on testnet-real (the treasury is hand-funded and finite, so a tap tops the user up for one
// more real play, not a windfall).
export const FAUCET_AMOUNT: number = Number(process.env.PIPS_FAUCET_AMOUNT) || (IS_REAL_PREDICT ? 2 : 500);
export const FAUCET_COOLDOWN_MS: number = Number(process.env.PIPS_FAUCET_COOLDOWN_MS) || 60_000;

// Demo override, OFF by default. When set to a valid leverage bucket (2/5/10/25/100), I Feel
// Lucky forces that bucket instead of the fair RNG draw so a rehearsed demo reliably lands a
// mid-bucket green swing (08-DEMO-FLOW.md says never demo a 100x lotto live). Asset and side
// stay random so it still feels alive. Leave empty for fair play. Optionally also pin the round
// duration so the climb has room to develop on camera.
export const DEMO_LUCKY_LEVERAGE: number = Number(process.env.PIPS_DEMO_LUCKY_LEVERAGE) || 0;
export const DEMO_LUCKY_DURATION: number = Number(process.env.PIPS_DEMO_LUCKY_DURATION) || 0;

// Stake bounds per play, display DUSDC. The knob and the play endpoints enforce these. Network-scoped:
// testnet-real floors at the protocol's ~$1 min net premium (L-011, NOT the intake's 0.01 guess, which
// the protocol source disproved) and caps tiny to protect finite testnet DUSDC; the fork's free
// localnet keeps the wide band. Env overrides win in either mode.
// testnet-real MIN is sized so the net-premium budget (stake minus the ~12% fee headroom the mint
// charges on top) still clears the protocol's $1 min-net-premium floor: 1.5 * 0.88 = $1.32 >= $1.
export const MIN_STAKE: number = Number(process.env.PIPS_MIN_STAKE) || (IS_REAL_PREDICT ? 1.5 : 1);
export const MAX_STAKE: number = Number(process.env.PIPS_MAX_STAKE) || (IS_REAL_PREDICT ? 3 : 100);

// Real-mode (testnet Predict) strike sizing. On the real protocol a mint is rejected if the strike's
// entry probability falls outside [min_entry_probability, max_entry_probability]
// (strike_exposure_config, abort code 1). On a 20-60s BTC market a fixed-percentage strike (the fork's
// 0.15%+ target) sits several sigma OTM, so its probability is ~0 and every mint aborts. We instead
// size the strike off spot as z(p)*sigma, where sigma is the per-round BTC move (annual vol scaled by
// sqrt(time to expiry)) and p is the tier's target win probability, keeping the strike inside the band.
// The band edges are unreadable pre-mint (up_price/range_price are package-private, L-012), so these are
// conservative estimates; the mint-abort fallback pulls the strike toward ATM if one still lands wide.
export const REAL_BTC_ANNUAL_VOL: number = Number(process.env.PIPS_REAL_BTC_ANNUAL_VOL) || 0.55;
// Floor on the target win probability we ask for (kept safely above the chain's unreadable
// min_entry_probability). Caps how far OTM a high tier / long reach may sit: p never drops below this,
// so the strike never lands below the admissible band. Multiplier tops out near 1/this before leverage.
export const REAL_STRIKE_MIN_PROB: number = Number(process.env.PIPS_REAL_STRIKE_MIN_PROB) || 0.06;
// Absolute guard cap on the strike offset (fraction of spot), in case the vol estimate runs hot.
export const REAL_STRIKE_MAX_OFFSET_FRAC: number = Number(process.env.PIPS_REAL_STRIKE_MAX_OFFSET_FRAC) || 0.006;
// Upper target probability for a RANGE band. A wide centered band on a 1m BTC market is near-certain to
// contain settlement (probability ~1), which trips max_entry_probability; cap the half-width so the
// band's probability stays under this. A too-tight user band is left as-is (it only lowers probability).
export const REAL_RANGE_MAX_PROB: number = Number(process.env.PIPS_REAL_RANGE_MAX_PROB) || 0.85;
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
// tight: push spot every ~1s (the chart follows the pushed spot now, so this also sets how lively the
// line is; still well inside the 30s freshness gate), roll the oracle ladder every ~5s, and settle
// every ~1s. The settle tick is cheap now (it resolves won/lost from the
// frozen price with no tx, and decouples the win redeem), so a fast cadence makes the result land
// within ~1s of the buzzer instead of waiting out a 3s scan gap. The isRunning guard skips overlaps.
export const OPERATOR_ENABLED: boolean = process.env.PIPS_OPERATOR_ENABLED === 'true';
export const PRICE_PUSH_CRON: string = process.env.PIPS_PRICE_PUSH_CRON || '*/1 * * * * *';
export const ORACLE_ROLL_CRON: string = process.env.PIPS_ORACLE_ROLL_CRON || '*/5 * * * * *';
export const SETTLE_CRON: string = process.env.PIPS_SETTLE_CRON || '*/1 * * * * *';
// Follower-mode market discovery cadence. Only runs when OPERATOR_ENABLED is false: this backend
// then learns the live oracle set from chain (emitted by whoever IS the operator) instead of from
// its own oracle-roll. It also refreshes each oracle's on-chain spot, which the follower chart
// serves, so sync at the push cadence (~2s): a slacker sync leaves the served line lagging the
// oracle the strike is priced and settled against, which floats the ENTRY/TARGET off the live line.
export const MARKET_SYNC_CRON: string = process.env.PIPS_MARKET_SYNC_CRON || '*/2 * * * * *';
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
// It is ALSO the bridge across an operator restart: any oracle with more than the downtime left when
// the operator drops stays live on chain through the gap, so the games never see a blackout. Keep this
// well above realistic operator downtime (deploy/restart) and raise ORACLE_LADDER_DEPTH with it so the
// per-rung spacing (LIFETIME/DEPTH) and the create rate stay put.
export const ORACLE_LIFETIME_MS: number = Number(process.env.PIPS_ORACLE_LIFETIME_MS) || 180_000;
// The LUCKY round target: each play routes to the live oracle expiring nearest this far out and
// settles there, so rounds stay ~this long regardless of how long the oracles themselves live. Kept
// short so the loop is a quick thrill: spin (reels ~2s) -> a brief watchable round -> instant settle.
export const LUCKY_ROUND_MS: number = Number(process.env.PIPS_LUCKY_ROUND_MS) || 20_000;
// Minimum oracle life a LUCKY play will route to. The mint runs in the background but must still land
// before expiry (else EOracleExpired -> the play re-routes/re-racks), so a play never routes to an
// oracle with less life than this. When the ladder is thin and nothing clears the bar, routing falls
// back to the longest-lived live oracle instead of failing. Must comfortably exceed the mint time,
// which spikes on the congested remote node, so this carries real headroom over a fast mint (~2.5s).
export const LUCKY_MIN_ORACLE_LIFE_MS: number = Number(process.env.PIPS_LUCKY_MIN_ORACLE_LIFE_MS) || 13_000;
// RANGE round bounds, the hold-the-band game. Unlike LUCKY's quick spin, Range holds longer so the
// band has time to be tested, but bounded (the old longest-lived pick gave inconsistent ~90s rounds).
// A play routes to a live oracle expiring inside this window and takes the longest such, so a round
// lands ~22-30s. The window is narrower than the ladder's rung spacing so it can be momentarily empty;
// the router just waits a beat for a rung to age into it (see rangeOracle), no ladder change needed.
export const RANGE_MIN_ORACLE_LIFE_MS: number = Number(process.env.PIPS_RANGE_MIN_ORACLE_LIFE_MS) || 20_000;
export const RANGE_MAX_ORACLE_LIFE_MS: number = Number(process.env.PIPS_RANGE_MAX_ORACLE_LIFE_MS) || 33_000;
// Smallest distance a LUCKY target may sit from entry, as a fraction of spot (the solver also floors
// it at one grid tick). Guarantees every target, even the 2x floor, is a real directional move and
// never renders on top of the ENTRY line. At the ~3%/round implied vol a 0.15% floor barely moves the
// 2x odds (it stays ~2.0-2.2x) while making "the price has to go your way" visibly true on the chart.
export const LUCKY_MIN_TARGET_FRAC: number = Number(process.env.PIPS_LUCKY_MIN_TARGET_FRAC) || 0.0015;
// Oracles kept live per asset, spread evenly across the lifetime (~ORACLE_LIFETIME_MS / depth apart)
// so a near-round one always exists. Higher = more buffer when the operator briefly falls behind or
// restarts (free localnet gas). Cost is only bigger push PTBs (still ONE tx per cap, gotcha #5, so the
// serial-lane tx count does not grow with depth) and a little more settle work, both bounded. Scaled
// with ORACLE_LIFETIME_MS to hold the rung spacing at ~11s, so the create rate (depth/lifetime) is flat.
export const ORACLE_LADDER_DEPTH: number = Number(process.env.PIPS_ORACLE_LADDER_DEPTH) || 16;
// Max oracles oracle-roll creates per asset in a single tick. Steady state needs only 1 (gentle,
// spacing-gated). But after a reload/dry spell the ladder is empty and a 1-per-tick refill leaves
// minutes of "No markets are live"; when an asset is below low-water the roller bursts up to this
// many per tick (spacing gate bypassed) so the ladder refills in seconds. Free localnet gas.
export const ORACLE_ROLL_MAX_PER_TICK: number = Number(process.env.PIPS_ORACLE_ROLL_MAX_PER_TICK) || 3;
// Reclaim a settled oracle's strike matrix to recover its storage rebate. Only worth it on a
// gas-scarce chain; on free localnet it is pure extra load on the serial operator queue, so off.
export const ORACLE_COMPACT_SETTLED: boolean = process.env.PIPS_ORACLE_COMPACT_SETTLED === 'true';

// Devnet faucet top-up worker. On devnet the public faucet is the ONLY SUI source, and devnet is
// wiped ~weekly, so the crucial wallets can run dry and stall plays/redeems/payouts. This worker
// keeps them (operator, settlement, treasury, sponsor) and any extra addresses funded: every minute
// it reads each balance and, for any below the floor, faucets repeatedly until it reaches the target,
// VERIFYING each drip actually landed (the public devnet faucet silently rate-limits, which used to
// leave the operator wedged below its gas budget while we logged a false "topped up"). Devnet ONLY:
// no-op on localnet/mainnet/testnet. DEVNET_FAUCET_EXTRA defaults to the owner's personal address.
//
// DEVNET_FAUCET_URL overrides the faucet host. The public faucet (getFaucetHost('devnet')) is
// rate-limited, so for a stable operator point this at a no-rate-limit faucet; the worker speaks the
// standard Sui faucet shape (v2 `/v2/gas`, v1 `/gas` FixedAmountRequest). TARGET must sit comfortably
// above the operator gas budget (1 SUI) so the operator never starves between drips.
export const DEVNET_FAUCET_ENABLED: boolean = process.env.PIPS_DEVNET_FAUCET_ENABLED !== 'false';
export const DEVNET_FAUCET_URL: string = (process.env.PIPS_DEVNET_FAUCET_URL || '').trim().replace(/\/$/, '');
// Aggressive by default: the operator burns SUI fast (oracle storage), so keep it stacked high. Refill
// whenever it dips below MIN, all the way back up to TARGET. These only make sense against a
// no-rate-limit faucet (PIPS_DEVNET_FAUCET_URL); the public faucet will rate-limit long before TARGET.
export const DEVNET_FAUCET_MIN_SUI: number = Number(process.env.PIPS_DEVNET_FAUCET_MIN_SUI) || 1000;
export const DEVNET_FAUCET_TARGET_SUI: number = Number(process.env.PIPS_DEVNET_FAUCET_TARGET_SUI) || 5000;
// Requests fire in parallel batches so a high TARGET fills in seconds. BATCH = concurrent requests per
// round; MAX_REQUESTS caps total requests per wallet per tick (a cold fill from 0 to TARGET).
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

// Self-heal watcher (src/workers/deploy-watch.ts). Polls the shared DB for a fresh deploy record and
// restarts the process to adopt new ids after a devnet-wipe recovery. ON by default in production (the
// box has a restart-on-exit container), OFF locally so it never kills a `bun dev` follower. The poll is
// frequent because it only does one cheap DB read; the actual restart fires once, on a real change.
export const DEPLOY_WATCH_ENABLED: boolean =
  process.env.PIPS_DEPLOY_WATCH_ENABLED !== undefined
    ? process.env.PIPS_DEPLOY_WATCH_ENABLED === 'true'
    : IS_PROD;
export const DEPLOY_WATCH_CRON: string = process.env.PIPS_DEPLOY_WATCH_CRON || '*/20 * * * * *';

// Self-publish: when the operator container detects its Predict package is gone (a devnet wipe), it
// republishes the whole stack itself (spawns scripts/devnet-refresh.sh recover) and then restarts onto
// the fresh ids. ONLY for the operator box, whose image carries the sui CLI + contracts/ + scripts/ (see
// backend/Dockerfile). Off by default; set PIPS_SELF_PUBLISH=true on the operator. Needs the operator
// key funded on devnet (the box's devnet-faucet worker keeps it topped). Retries on a cooldown so a
// devnet outage doesn't spam republishes.
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
  IS_REAL_PREDICT,
  SUI_FULLNODE_URL,
  SUI_GRAPHQL_URL,
  TESTING_WALLET_PK,
  BINANCE_ENABLED,
  BINANCE_WS_URL,
  BINANCE_STALE_MS,
  BINANCE_SYMBOLS,
  PRICE_WS_BROADCAST_MS,
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
