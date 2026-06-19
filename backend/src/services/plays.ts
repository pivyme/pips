// The play lifecycle: create (mint), cash out (redeem), and expiry settle. The user's chips live
// in their PredictManager's BalanceManager: mint debits it, redeem credits it, so a play funds
// the manager up to the stake, then mints. Both modes finalize server-side: dev signs as the
// operator; privy signs with the user's embedded wallet via a session signer. No client round
// trip, no sponsor envelope.

import { Transaction } from '@mysten/sui/transactions';
import { coinWithBalance } from '@mysten/sui/transactions';

import type { Play, User } from '../../prisma/generated/client.js';
import { prismaQuery } from '../lib/prisma.ts';
import { DUSDC_TYPE } from '../lib/sui/config.ts';
import { getDusdcBalanceRaw } from '../lib/sui/dusdc.ts';
import {
  buildDeposit,
  buildMint,
  buildMintRange,
  buildRedeem,
  buildRedeemRange,
  buildRedeemPermissionless,
  buildRedeemRangePermissionless,
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

type Balances = { wallet: bigint; manager: bigint; total: bigint };

// Wallet DUSDC + whatever already sits in the manager from prior plays, read in parallel (two
// independent RPCs). Returns the parts so createPlay can reuse the manager figure for funding
// instead of reading it a second time.
async function loadBalances(user: User): Promise<Balances> {
  const [wallet, manager] = await Promise.all([
    getDusdcBalanceRaw(user.address),
    user.predictManagerId ? getManagerBalanceRaw(user.predictManagerId) : Promise.resolve(0n),
  ]);
  return { wallet, manager, total: wallet + manager };
}

// Spendable chips. Kept as a thin wrapper for callers outside the play hot path.
export async function playableBalanceRaw(user: User): Promise<bigint> {
  return (await loadBalances(user)).total;
}

// Fund the manager from the wallet only when it can't cover this play, reusing the already-read
// manager balance (no extra RPC). `needRaw` is what this single play requires (bet + impact buffer);
// when the manager is short we top it up to `refillToRaw`, a BULK target covering several spins, so
// the following plays skip the deposit entirely. We fund a little ABOVE each bet so the mint, which
// prices against the post-trade vault (its own size nudges the ask up), can never overdraw the
// manager. Surplus is not spent: it stays in the manager as the user's chips and funds later plays.
function fundManager(tx: Transaction, managerId: string, needRaw: bigint, refillToRaw: bigint, haveRaw: bigint): void {
  if (haveRaw >= needRaw) return;
  const top = refillToRaw - haveRaw;
  if (top <= 0n) return;
  const coin = coinWithBalance({ type: DUSDC_TYPE, balance: top })(tx);
  buildDeposit(tx, managerId, coin);
}

// === Create ===

export type CreatePlayInput =
  | { game: 'lucky'; stake: string | number }
  | { game: 'range'; stake: string | number; asset: string; widthPct: number }
  | { game: 'tap'; stake: string | number; asset: string; band: { lower: number; upper: number }; duration: number };

export type CreateResult = { play: PlayDTO };

// What executeForUser needs to sign: the user (dev = operator-signed; privy = the user's wallet).
const userCtx = (user: User) => ({ address: user.address, walletId: user.privyWalletId, publicKey: user.suiPublicKey });

async function resolveByGame(input: CreatePlayInput, stakeRaw: bigint): Promise<Resolved> {
  if (input.game === 'lucky') return resolveLucky(stakeRaw);
  if (input.game === 'range') return resolveRange(stakeRaw, input.asset, input.widthPct);
  return resolveTap(stakeRaw, input.asset, input.band, input.duration);
}

// How far above the bet we fund the manager so the post-trade mint price (the position's own
// market impact) never overdraws it. Surplus stays in the manager and funds the next play.
const FUND_BUFFER_PCT = 12n;

// Bulk-refill horizon. A deposit is the slow part of a repeat spin: it forces a DUSDC coin read in
// tx.build and a bigger mint tx. So when the manager runs short we don't just top it to one bet, we
// fund this many bets' worth (capped at the player's chips), and the next several spins mint with no
// deposit at all (faster build, smaller tx). Tuned modest so we don't park a big idle balance for a
// one-off player; a session of spins still amortizes a single deposit across ~this many plays.
const BULK_FUND_PLAYS = 5n;

// Serialize each user's own transactions. A play/cashout consumes that user's owned gas + DUSDC
// coins, so two in flight at once pick the same coin versions and equivocate ("object unavailable
// for consumption / already locked by a different transaction"), which on a single-validator node
// cascades into slow devInspects and stuck submits. One promise chain per user makes their txs
// strictly sequential; different users still run fully in parallel.
const userChains = new Map<string, Promise<unknown>>();
function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const run = (userChains.get(userId) ?? Promise.resolve()).then(fn, fn);
  userChains.set(
    userId,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}

// A mint can abort or be rejected at execution for transient, recoverable reasons: the routed
// oracle ticking past expiry, a tight post-trade price, or an owned-coin version race (the
// fullnode still serving a pre-previous-tx coin version). All are safe to retry, because a fresh
// resolve re-routes to a live oracle and tx.build re-selects current coin versions. Auth/balance/
// param errors are not, so only these retry.
const isRetriableMint = (e: unknown): boolean => {
  const m = e instanceof Error ? e.message : String(e);
  return /assert_live_oracle|EOracleExpired|withdraw|interpolate_price|trade_prices|MoveAbort|MovePrimitiveRuntimeError|unavailable for consumption|not available|needs to be rebuilt|already locked|rejected as invalid|equivocat|reserved for another/i.test(
    m,
  );
};

export function createPlay(user: User, input: CreatePlayInput): Promise<CreateResult> {
  return withUserLock(user.id, () => createPlayLocked(user, input));
}

async function createPlayLocked(user: User, input: CreatePlayInput): Promise<CreateResult> {
  const stakeRaw = parseStake(input.stake);
  const managerId = user.predictManagerId;
  if (!managerId) throw new PlayError('MANAGER_NOT_READY', 'Your account is still getting ready');

  // Up to 3 attempts. A mint that aborts on a stale oracle, a tight post-trade price, the matrix
  // pricing edge, or an owned-coin version race is re-resolved: each retry re-draws a fresh
  // asset/side/tier (so a different strike + quantity) and re-selects current coins, so independent
  // attempts converge fast. The balance read runs concurrently with the (chain-bound) resolve.
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const [balances, resolved] = await Promise.all([loadBalances(user), resolveByGame(input, stakeRaw)]);
    if (balances.total < stakeRaw) throw new PlayError('INSUFFICIENT_DUSDC', 'Not enough chips for that bet');

    // What this one play needs in the manager (bet + impact buffer), capped at the player's chips.
    const need = stakeRaw + (stakeRaw * FUND_BUFFER_PCT) / 100n;
    const cappedNeed = need > balances.total ? balances.total : need;
    // When the manager is short, refill in bulk (several bets' worth) so the next spins skip funding.
    // Never below this play's need, never above what the player holds.
    const bulkRefill = stakeRaw * BULK_FUND_PLAYS;
    const refillTo = bulkRefill > balances.total ? balances.total : bulkRefill;
    const refillToFinal = refillTo < cappedNeed ? cappedNeed : refillTo;

    const tx = new Transaction();
    fundManager(tx, managerId, cappedNeed, refillToFinal, balances.manager);
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
      lastErr = e;
      if (attempt < MAX_ATTEMPTS - 1 && isRetriableMint(e)) continue;
      throw asPlayError(e, 'MINT_FAILED', 'Could not place that play. Your chips are safe.');
    }
  }
  throw asPlayError(lastErr, 'MINT_FAILED', 'Could not place that play. Your chips are safe.');
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

export function cashoutPlay(user: User, playId: string): Promise<CashoutResult> {
  return withUserLock(user.id, () => cashoutPlayLocked(user, playId));
}

async function cashoutPlayLocked(user: User, playId: string): Promise<CashoutResult> {
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

  // An in-the-money settle sweeps the $1/contract payout into the user's manager. Both legs use a
  // permissionless redeem (no owner check once settled), so the operator finalizes the win in
  // either auth mode. Mark the play won ONLY after that redeem confirms on-chain, so the record
  // never claims a payout the chain did not move; a failed redeem leaves the play open to retry on
  // the next settle tick. A losing play has nothing to redeem, so it settles immediately.
  let digest: string | undefined;
  if (itm) {
    const user = await prismaQuery.user.findUnique({ where: { id: play.userId } });
    if (!user?.predictManagerId) {
      console.error(`[Settle] play ${play.id} is ITM but the user has no manager; will retry`);
      return;
    }
    try {
      const tx = new Transaction();
      if (key.kind === 'binary') buildRedeemPermissionless(tx, user.predictManagerId, key.params);
      else buildRedeemRangePermissionless(tx, user.predictManagerId, key.params);
      digest = (await executeAsOperator(tx, `settle-redeem ${play.id}`)).digest;
    } catch (e) {
      console.error(`[Settle] on-chain redeem failed for ${play.id}, will retry:`, e instanceof Error ? e.message : e);
      return; // leave status 'open' so the next settle tick retries the redeem
    }
  }

  const payoutRaw = itm ? key.params.quantity : 0n; // settled ITM pays $1 per contract, else 0
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
