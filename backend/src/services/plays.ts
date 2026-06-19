// The play lifecycle: create (mint), cash out (redeem), and expiry settle. The user's chips live
// in their PredictManager's BalanceManager: mint debits it, redeem credits it, so a play funds
// the manager up to the stake, then mints. Both modes finalize server-side: dev signs as the
// operator; privy signs with the user's embedded wallet via a session signer. No client round
// trip, no sponsor envelope.

import { Transaction } from '@mysten/sui/transactions';
import { coinWithBalance } from '@mysten/sui/transactions';

import type { Play, User } from '../../prisma/generated/client.js';
import { prismaQuery } from '../lib/prisma.ts';
import { AUTH_MODE } from '../config/main-config.ts';
import { DUSDC_TYPE } from '../lib/sui/config.ts';
import { getDusdcBalanceRaw } from '../lib/sui/dusdc.ts';
import {
  buildDeposit,
  buildMint,
  buildMintRange,
  buildRedeem,
  buildRedeemRange,
  buildRedeemPermissionless,
  getManagerBalanceRaw,
  previewRange,
  previewRedeem,
  readOracle,
  type BinaryParams,
  type RangeParams,
} from '../lib/sui/predict.ts';
import { executeForUser, executeAsOperator } from '../lib/sui/execute.ts';
import {
  resolveLucky,
  resolveRange,
  resolveTap,
  parseStake,
  PlayError,
  type PlayErrorCode,
  type Resolved,
} from './games.ts';
import { recordSettlement } from './stats.ts';
import { evaluateAndUnlock } from './achievements.ts';
import type { Game, PlayDTO, PlayStatus, Side } from '../types/api.ts';

// === Redeem key descriptor (stored on Play.marketKey) ===
// Holds the exact 1e9 strikes + quantity so redeem reconstructs the on-chain key precisely,
// without re-deriving from lossy display strings.

type BinaryKey = { kind: 'binary'; params: BinaryParams };
type RangeKeyD = { kind: 'range'; params: RangeParams };
type PlayKey = BinaryKey | RangeKeyD;

const serializeKey = (r: Resolved): string =>
  JSON.stringify(
    r.kind === 'binary'
      ? { kind: 'binary', oracleId: r.params.oracleId, expiry: r.params.expiryMs, strike1e9: r.params.strike1e9.toString(), side: r.params.side, quantity: r.params.quantity.toString() }
      : { kind: 'range', oracleId: r.params.oracleId, expiry: r.params.expiryMs, lower1e9: r.params.lower1e9.toString(), higher1e9: r.params.higher1e9.toString(), quantity: r.params.quantity.toString() },
  );

function deserializeKey(play: Play): PlayKey {
  const d = JSON.parse(play.marketKey) as Record<string, string>;
  if (d.kind === 'binary') {
    return {
      kind: 'binary',
      params: { oracleId: d.oracleId, expiryMs: Number(d.expiry), strike1e9: BigInt(d.strike1e9), side: d.side as Side, quantity: BigInt(d.quantity) },
    };
  }
  return {
    kind: 'range',
    params: { oracleId: d.oracleId, expiryMs: Number(d.expiry), lower1e9: BigInt(d.lower1e9), higher1e9: BigInt(d.higher1e9), quantity: BigInt(d.quantity) },
  };
}

// === Balance ===

// Spendable chips = wallet DUSDC + whatever already sits in the manager from prior plays.
export async function playableBalanceRaw(user: User): Promise<bigint> {
  const wallet = await getDusdcBalanceRaw(user.address);
  const manager = user.predictManagerId ? await getManagerBalanceRaw(user.predictManagerId) : 0n;
  return wallet + manager;
}

// Top the manager up to `needRaw` from the wallet (only the shortfall, so winnings already
// in the manager are reused before pulling fresh coins).
async function fundManager(tx: Transaction, managerId: string, needRaw: bigint): Promise<void> {
  const have = await getManagerBalanceRaw(managerId);
  if (have >= needRaw) return;
  const coin = coinWithBalance({ type: DUSDC_TYPE, balance: needRaw - have })(tx);
  buildDeposit(tx, managerId, coin);
}

// === Create ===

export type CreatePlayInput =
  | { game: 'lucky'; stake: string | number }
  | { game: 'range'; stake: string | number; asset: string; widthPct: number; duration: number }
  | { game: 'tap'; stake: string | number; asset: string; band: { lower: number; upper: number }; duration: number };

export type CreateResult = { play: PlayDTO };

// What executeForUser needs to sign: the user (dev = operator-signed; privy = the user's wallet).
const userCtx = (user: User) => ({ address: user.address, walletId: user.privyWalletId, publicKey: user.suiPublicKey });

async function resolveByGame(input: CreatePlayInput, stakeRaw: bigint): Promise<Resolved> {
  if (input.game === 'lucky') return resolveLucky(stakeRaw);
  if (input.game === 'range') return resolveRange(stakeRaw, input.asset, input.widthPct, input.duration);
  return resolveTap(stakeRaw, input.asset, input.band, input.duration);
}

export async function createPlay(user: User, input: CreatePlayInput): Promise<CreateResult> {
  const stakeRaw = parseStake(input.stake);
  if ((await playableBalanceRaw(user)) < stakeRaw) {
    throw new PlayError('INSUFFICIENT_DUSDC', 'Not enough chips for that bet');
  }
  const managerId = user.predictManagerId;
  if (!managerId) throw new PlayError('MANAGER_NOT_READY', 'Your account is still getting ready');

  const resolved = await resolveByGame(input, stakeRaw);

  const tx = new Transaction();
  await fundManager(tx, managerId, stakeRaw);
  if (resolved.kind === 'binary') buildMint(tx, managerId, resolved.params);
  else buildMintRange(tx, managerId, resolved.params);

  // Persist pending first so we hold an id even if signing/submit throws.
  const play = await prismaQuery.play.create({ data: mapResolvedToPlay(user.id, resolved, stakeRaw) });

  try {
    const exec = await executeForUser(tx, userCtx(user));
    const opened = await prismaQuery.play.update({
      where: { id: play.id },
      data: { status: 'open', txMint: exec.digest, openedAt: new Date() },
    });
    return { play: await toPlayDTO(opened) };
  } catch (e) {
    await prismaQuery.play.update({ where: { id: play.id }, data: { status: 'error' } });
    throw asPlayError(e, 'MINT_FAILED', 'Could not place that play. Your chips are safe.');
  }
}

function mapResolvedToPlay(userId: string, r: Resolved, stakeRaw: bigint) {
  const base = {
    userId,
    game: r.game,
    status: 'pending',
    asset: r.asset,
    oracleId: r.market.oracleId,
    marketKey: serializeKey(r),
    durationSec: r.duration,
    expiry: BigInt(r.market.expiryMs),
    stake: stakeRaw,
    entryCost: r.entryCost,
    multiplier: r.multiplier,
  };
  if (r.kind === 'binary') {
    // Store the dealt nominal tier in the legacy `leverage` column (rounded to the int field);
    // the honest, mintable multiple lives in `multiplier`.
    return { ...base, side: r.side, leverage: Math.round(r.tier), strike: r.strikeDisplay, rngSeed: r.seed };
  }
  return { ...base, lower: r.lowerDisplay, upper: r.upperDisplay, widthPct: r.widthPct ?? null };
}

// === Cash out (redeem at the live mark) ===

export type CashoutResult = { play: PlayDTO; unlocked: string[] };

export async function cashoutPlay(user: User, playId: string): Promise<CashoutResult> {
  const play = await prismaQuery.play.findFirst({ where: { id: playId, userId: user.id } });
  if (!play) throw new PlayError('PLAY_NOT_OPEN', 'Play not found');
  if (play.status !== 'open') throw new PlayError('PLAY_NOT_OPEN', 'This play is not open');
  const managerId = user.predictManagerId;
  if (!managerId) throw new PlayError('MANAGER_NOT_READY', 'Your account is still getting ready');

  const key = deserializeKey(play);
  const amounts = key.kind === 'binary' ? await previewRedeem(key.params) : await previewRange(key.params);

  const tx = new Transaction();
  if (key.kind === 'binary') buildRedeem(tx, managerId, key.params);
  else buildRedeemRange(tx, managerId, key.params);

  try {
    const exec = await executeForUser(tx, userCtx(user));
    return finalizeCashout(play, amounts.payout, exec.digest);
  } catch (e) {
    throw asPlayError(e, 'REDEEM_FAILED', 'Could not cash out right now. Try again.');
  }
}

async function finalizeCashout(play: Play, payoutRaw: bigint, digest: string): Promise<{ play: PlayDTO; unlocked: string[] }> {
  const pnl = payoutRaw - play.entryCost;
  const updated = await prismaQuery.play.update({
    where: { id: play.id },
    data: { status: 'cashed_out', payout: payoutRaw, markValue: payoutRaw, pnl, txRedeem: digest, settledAt: new Date() },
  });
  await recordSettlement(play.userId, { game: play.game, stakeRaw: play.stake, pnlRaw: pnl, won: pnl > 0n });
  const unlocked = await evaluateAndUnlock(play.userId);
  return { play: await toPlayDTO(updated), unlocked };
}

// === Expiry settlement (worker) ===

const isItm = (key: PlayKey, settlement1e9: bigint): boolean =>
  key.kind === 'binary'
    ? key.params.side === 'up'
      ? settlement1e9 > key.params.strike1e9
      : settlement1e9 < key.params.strike1e9
    : settlement1e9 > key.params.lower1e9 && settlement1e9 <= key.params.higher1e9;

// Settle every open play whose oracle has settled. Reads the oracle directly so it works
// even after the market left the live cache. Idempotent: only touches status 'open' plays.
export async function settleDuePlays(): Promise<void> {
  const due = await prismaQuery.play.findMany({ where: { status: 'open', expiry: { lte: BigInt(Date.now()) } } });
  for (const play of due) {
    try {
      const st = await readOracle(play.oracleId);
      if (!st || !st.settled || st.settlementPrice1e9 == null) continue; // not settled yet, retry next tick
      await settleOnePlay(play, st.settlementPrice1e9);
    } catch (e) {
      console.error(`[Settle] play ${play.id} settle failed:`, e instanceof Error ? e.message : e);
    }
  }
}

async function settleOnePlay(play: Play, settlement1e9: bigint): Promise<void> {
  const key = deserializeKey(play);
  const itm = isItm(key, settlement1e9);
  const payoutRaw = itm ? key.params.quantity : 0n; // settled ITM pays $1 per contract
  let digest: string | undefined;

  if (itm) {
    const user = await prismaQuery.user.findUnique({ where: { id: play.userId } });
    if (user?.predictManagerId) {
      try {
        const tx = new Transaction();
        if (key.kind === 'binary') {
          buildRedeemPermissionless(tx, user.predictManagerId, key.params);
          digest = (await executeAsOperator(tx, `settle-redeem ${play.id}`)).digest;
        } else if (AUTH_MODE === 'dev') {
          // No permissionless range redeem on-chain; in dev the operator owns the manager.
          buildRedeemRange(tx, user.predictManagerId, key.params);
          digest = (await executeAsOperator(tx, `settle-redeem-range ${play.id}`)).digest;
        }
      } catch (e) {
        console.error(`[Settle] on-chain redeem failed for ${play.id}:`, e instanceof Error ? e.message : e);
      }
    }
  }

  const pnl = payoutRaw - play.entryCost;
  await prismaQuery.play.update({
    where: { id: play.id },
    data: { status: itm ? 'won' : 'lost', payout: payoutRaw, markValue: payoutRaw, pnl, txRedeem: digest ?? play.txRedeem, settledAt: new Date() },
  });
  await recordSettlement(play.userId, { game: play.game, stakeRaw: play.stake, pnlRaw: pnl, won: itm });
  await evaluateAndUnlock(play.userId);
}

// === Reads / DTO ===

// Live cash-out value for an open play (the redeem bid). Settled/closed plays use the
// stored payout. Used by /plays/:id and the play SSE stream.
export async function getLiveMarkRaw(play: Play): Promise<bigint> {
  if (play.status !== 'open') return play.payout ?? play.markValue ?? 0n;
  const key = deserializeKey(play);
  const amounts = key.kind === 'binary' ? await previewRedeem(key.params) : await previewRange(key.params);
  return amounts.payout;
}

const money = (raw: bigint): string => (Number(raw) / 1_000_000).toFixed(2);

function paramsDTO(play: Play): PlayDTO['params'] {
  if (play.game === 'range') {
    return { asset: play.asset, lower: play.lower ?? '', upper: play.upper ?? '', widthPct: play.widthPct ?? 0, duration: play.durationSec };
  }
  if (play.game === 'tap') {
    return { asset: play.asset, band: { lower: play.lower ?? '', upper: play.upper ?? '' }, duration: play.durationSec };
  }
  return { asset: play.asset, side: (play.side as Side) ?? 'up', multiplier: play.multiplier ?? 0, duration: play.durationSec };
}

export async function toPlayDTO(play: Play, liveMark?: bigint): Promise<PlayDTO> {
  const settled = play.status !== 'open' && play.status !== 'pending';
  const markRaw = settled ? (play.payout ?? 0n) : (liveMark ?? play.markValue ?? play.entryCost);
  const pnlRaw = play.pnl ?? markRaw - play.entryCost;

  return {
    id: play.id,
    game: play.game as Game,
    status: play.status as PlayStatus,
    stake: money(play.stake),
    params: paramsDTO(play),
    market: {
      asset: play.asset,
      oracleId: play.oracleId,
      expiry: Number(play.expiry),
      strike: play.strike ?? undefined,
      lower: play.lower ?? undefined,
      upper: play.upper ?? undefined,
    },
    entryValue: money(play.entryCost),
    markValue: money(markRaw),
    pnl: money(pnlRaw),
    multiplier: play.multiplier ?? 0,
    payout: play.payout != null ? money(play.payout) : undefined,
    openedAt: play.openedAt?.toISOString(),
    settledAt: play.settledAt?.toISOString(),
    txMint: play.txMint ?? undefined,
    txRedeem: play.txRedeem ?? undefined,
  };
}

export async function listPlays(userId: string, opts: { status?: string; limit?: number } = {}): Promise<PlayDTO[]> {
  const plays = await prismaQuery.play.findMany({
    where: { userId, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts.limit ?? 20, 100),
  });
  return Promise.all(plays.map((p) => toPlayDTO(p)));
}

export async function getPlay(userId: string, playId: string): Promise<PlayDTO | null> {
  const play = await prismaQuery.play.findFirst({ where: { id: playId, userId } });
  if (!play) return null;
  const mark = play.status === 'open' ? await getLiveMarkRaw(play).catch(() => undefined) : undefined;
  return toPlayDTO(play, mark);
}

// Normalize any thrown value into a PlayError with a friendly code.
function asPlayError(e: unknown, code: PlayErrorCode, message: string): PlayError {
  if (e instanceof PlayError) return e;
  console.error('[plays]', message, e instanceof Error ? e.message : e);
  return new PlayError(code, message);
}
