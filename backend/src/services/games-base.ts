import { MAX_STAKE, MIN_STAKE } from '../config/main-config.ts';
import { toDusdcRaw } from '../lib/sui/config.ts';
import type { Market } from '../lib/sui/markets.ts';
import type { BinaryParams, RangeParams, Side } from '../lib/sui/predict.ts';

export type PlayErrorCode =
  | 'MARKET_UNAVAILABLE'
  | 'ORACLE_STALE'
  | 'INSUFFICIENT_DUSDC'
  | 'MINT_FAILED'
  | 'REDEEM_FAILED'
  | 'PLAY_NOT_OPEN'
  | 'INVALID_PARAMS'
  | 'MANAGER_NOT_READY'
  | 'PREDICT_VAULT_CAPACITY'
  | 'PLAYS_PAUSED'
  | 'RATE_LIMITED';

export class PlayError extends Error {
  code: PlayErrorCode;
  constructor(code: PlayErrorCode, message: string) {
    super(message);
    this.name = 'PlayError';
    this.code = code;
  }
}

export const httpStatusForPlayError = (code: PlayErrorCode): number => {
  switch (code) {
    case 'INVALID_PARAMS':
    case 'INSUFFICIENT_DUSDC':
      return 400;
    case 'MARKET_UNAVAILABLE':
    case 'ORACLE_STALE':
    case 'PREDICT_VAULT_CAPACITY':
    case 'PLAY_NOT_OPEN':
    case 'MANAGER_NOT_READY':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'PLAYS_PAUSED':
      return 503;
    case 'MINT_FAILED':
    case 'REDEEM_FAILED':
      return 502;
    default:
      return 500;
  }
};

export function parseStake(stake: string | number): bigint {
  const n = typeof stake === 'number' ? stake : Number(stake);
  if (!Number.isFinite(n) || n <= 0) throw new PlayError('INVALID_PARAMS', 'Enter a valid play amount');
  if (n < MIN_STAKE) throw new PlayError('INVALID_PARAMS', `Minimum play amount is $${MIN_STAKE}`);
  if (n > MAX_STAKE) throw new PlayError('INVALID_PARAMS', `Maximum play amount is $${MAX_STAKE}`);
  return toDusdcRaw(n);
}

export type ResolvedBinary = {
  kind: 'binary';
  game: 'lucky' | 'moonshot';
  market: Market;
  params: BinaryParams;
  asset: string;
  side: Side;
  tier: number;
  duration: number;
  strikeDisplay: string;
  entrySpot: string;
  entryCost: bigint;
  maxPayout: bigint;
  multiplier: number;
  seed: string;
};

export type ResolvedRange = {
  kind: 'range';
  game: 'range';
  market: Market;
  params: RangeParams;
  asset: string;
  lowerDisplay: string;
  upperDisplay: string;
  widthPct?: number;
  duration: number;
  entrySpot: string;
  entryCost: bigint;
  maxPayout: bigint;
  multiplier: number;
};

export type Resolved = ResolvedBinary | ResolvedRange;
