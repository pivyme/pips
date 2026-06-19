// Shared API DTOs (the wire shape between backend and web). DUSDC amounts cross the wire
// as human-readable decimal strings, never raw 6dp integers or JS numbers. See 02-API.md.

export type Game = 'lucky' | 'range';
export type PlayStatus = 'pending' | 'open' | 'won' | 'lost' | 'cashed_out' | 'error';
export type Side = 'up' | 'down'; // up = call/long, down = put/short

export interface UserDTO {
  id: string;
  address: string; // Sui address (Privy embedded wallet or dev wallet)
  displayName: string; // generated handle, e.g. "Lucky Otter"
  provider: 'privy' | 'dev';
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
  openedAt?: string;
  settledAt?: string;
  txMint?: string;
  txRedeem?: string;
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
