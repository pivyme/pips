// Shared API DTOs (the wire shape between backend and web). DUSDC amounts cross the wire
// as human-readable decimal strings, never raw 6dp integers or JS numbers. See 02-API.md.

export type Game = 'lucky' | 'range';
export type PlayStatus = 'pending' | 'open' | 'won' | 'lost' | 'cashed_out' | 'error';
export type Side = 'up' | 'down'; // up = call/long, down = put/short

export interface UserDTO {
  id: string;
  address: string; // Sui address. privy/dev = their wallet; wallet-connect = the custodial play wallet
  displayName: string; // generated handle, e.g. "Lucky Otter"
  username: string | null; // user-chosen unique handle; null until set in onboarding
  provider: 'privy' | 'dev' | 'wallet';
  walletAuthAddress?: string; // wallet-connect: the connected external wallet (login + default withdraw target)
  balance: string; // DUSDC, e.g. "983.50" (wallet + manager chips)
  managerReady: boolean; // PredictManager exists
  settings: { sound: boolean; haptics: boolean; reducedMotion: boolean };
}

export interface MarketDTO {
  asset: string; // 'BTC' | 'ETH' | 'SOL' | 'SUI'
  spot: string; // current spot, display units
  durations: number[]; // round durations available, seconds
  live: boolean; // oracle fresh + tradeable right now
}

export interface LuckyParams {
  asset: string;
  side: Side;
  multiplier: number; // the real solved payout multiple (LUCKY.md §5)
  duration: number;
}
export interface RangeParams {
  asset: string;
  lower: string;
  upper: string;
  widthPct: number;
  duration: number;
}

// A pre-mint Range price preview: the real multiple read off the live Predict ask (1 / ask) for the
// grid-snapped band, so the knob shows what it will actually mint, not a guess. No DB, no mint.
export interface RangeQuoteDTO {
  multiplier: number; // payout multiple at mint (grid-snapped band, live vault ask)
  lower: string; // grid-snapped band bounds, display units
  upper: string;
  entrySpot: string; // spot the band is centered on, display
  duration: number; // seconds to the routed oracle's expiry
  widthPct: number; // the requested full band width (echoed back)
}

export interface PlayDTO {
  id: string;
  game: Game;
  status: PlayStatus;
  stake: string; // DUSDC staked
  params: LuckyParams | RangeParams;
  market: { asset: string; oracleId: string; expiry: number; strike?: string; lower?: string; upper?: string };
  entryValue: string; // mint cost in DUSDC
  markValue: string; // current redeem value in DUSDC (live)
  pnl: string; // signed, markValue - entryValue
  multiplier: number; // potential payout multiple at mint
  payout?: string; // set on settle/cashout
  entrySpot?: string; // spot at entry (display), debug/audit
  settlePrice?: string; // frozen settlement price at expiry (display), debug/audit
  openedAt?: string;
  settledAt?: string;
  txMint?: string;
  txRedeem?: string;
  txSettle?: string; // post-expiry price push that froze the settlement price
}

export interface UserStatsDTO {
  gamesPlayed: number;
  wins: number;
  losses: number;
  winRate: number; // 0..1
  currentStreak: number; // signed: + win streak, - loss streak
  maxStreak: number;
  totalVolume: string; // DUSDC
  netPnl: string; // signed DUSDC
  firstPlayAt?: string;
  favoriteGame?: Game;
}

export interface AchievementDTO {
  slug: string;
  name: string;
  description: string;
  illo: string; // Illo name
  unlocked: boolean;
  unlockedAt?: string;
  progress?: { current: number; target: number };
}

// POST /wallet/withdraw -> the refreshed user (with the new balance) + the on-chain tx digest.
export interface WithdrawResult {
  user: UserDTO;
  digest: string;
}

// === Leaderboards ===
// Every board exposes username (or the generated displayName as a fallback), never the address.

export type Minigame = 'line-rider' | 'candle-hop';

// A PnL-ranked row (global Gainers / REKT).
export interface LeaderboardPnlEntryDTO {
  rank: number;
  username: string | null; // user-chosen handle; null until onboarded
  displayName: string; // generated handle fallback, never the wallet address
  netPnl: string; // signed DUSDC, e.g. "342.00" or "-128.50"
  gamesPlayed: number;
  isYou: boolean;
}

// A per-game ranked row (Lucky / Range), by summed PnL for that game. Used for both boards: signed
// so a gainers row reads positive and a rekt row reads negative.
export interface LeaderboardGameEntryDTO {
  rank: number;
  username: string | null;
  displayName: string;
  pnl: string; // signed summed DUSDC for this game (gainers positive, rekt negative)
  plays: number; // settled plays of this game
  isYou: boolean;
}

// A minigame high-score row (Line Rider / Flappy Piper).
export interface LeaderboardScoreEntryDTO {
  rank: number;
  username: string | null;
  displayName: string;
  score: number;
  isYou: boolean;
}

// GET /leaderboard
export interface GlobalLeaderboardDTO {
  gainers: LeaderboardPnlEntryDTO[]; // top 10 net-positive traders
  rekt: LeaderboardPnlEntryDTO[]; // top 10 net-negative traders, worst first
  you: {
    gainerRank: number | null; // your standing among gainers, null if not net-positive
    rektRank: number | null;
    netPnl: string;
    gamesPlayed: number;
  };
}

// GET /leaderboard/game/:game -> the two per-game boards: top gainers and top REKT.
export interface GameLeaderboardDTO {
  entries: LeaderboardGameEntryDTO[]; // top gainers, most profit first
  rekt: LeaderboardGameEntryDTO[]; // top REKT, deepest in the red first
}

// GET /leaderboard/minigame/:game
export interface MinigameLeaderboardDTO {
  entries: LeaderboardScoreEntryDTO[];
  best: number; // your own best for this game, 0 if none
}

// POST /leaderboard/minigame/:game -> the refreshed board + where this run landed
export interface MinigameSubmitDTO {
  entries: LeaderboardScoreEntryDTO[];
  rank: number; // your global rank after this run, 1-based
  best: number; // your best after this run
  isBest: boolean; // this run is a personal best AND now #1 overall
  prevBest: number; // your best before this run
}

// GET /leaderboard -> every board in one response, so the menu fetches once and switches tabs with
// no refetch. The in-game overlays still use the focused /game and /minigame endpoints.
export interface FullLeaderboardDTO {
  global: GlobalLeaderboardDTO;
  games: Record<Game, LeaderboardGameEntryDTO[]>; // lucky, range
  minigames: Record<Minigame, MinigameLeaderboardDTO>; // line-rider, candle-hop
}
