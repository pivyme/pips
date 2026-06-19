// The play lifecycle: create (mint), cash out (redeem), and expiry settle. The user's chips live
// in their PredictManager's BalanceManager: mint debits it, redeem credits it, so a play funds
// the manager up to the stake, then mints. Both modes finalize server-side: dev signs as the
// operator; privy signs with the user's embedded wallet via a session signer. No client round
// trip, no sponsor envelope.

import { Transaction } from '@mysten/sui/transactions';
import { coinWithBalance } from '@mysten/sui/transactions';

import type { Play, User } from '../../prisma/generated/client.js';
import { prismaQuery } from '../lib/prisma.ts';
import { SETTLE_MAX_REDEEMS_PER_TICK, LIVE_MARK_TTL_MS } from '../config/main-config.ts';
import { DUSDC_TYPE, usd1e9 } from '../lib/sui/config.ts';
import { getDusdcBalanceRaw } from '../lib/sui/dusdc.ts';
import {
  appendPriceUpdate,
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
  type OracleState,
  type RangeParams,
} from '../lib/sui/predict.ts';
import { getMarket, removeMarket } from '../lib/sui/markets.ts';
import { operatorCaps } from '../lib/sui/signer.ts';
import { gameSpot } from '../lib/game-price.ts';
import { executeForUser, executeAsOperator } from '../lib/sui/execute.ts';
import {
  resolveLucky,
  resolveRange,
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

// Best-effort spendable-total cache, keyed by user id, seeded by every real balance read (the
// background mint reads fresh each play). It exists ONLY to fast-reject an obviously-unaffordable
// bet on the optimistic hot path WITHOUT a ~1.5s manager devInspect: a fresh cache that says
// "insufficient" rejects before the reels spin; anything else proceeds and the background mint is
// the real check. So it can be stale-high (never wrongly rejects) but must not be stale-low after a
// credit, hence callers invalidate it on cash-out / settle wins. The manager read stays off the hot
// path entirely; it runs in the background mint.
const balCache = new Map<string, { total: bigint; at: number }>();
const BAL_TTL_MS = 8000;
const seedBalCache = (userId: string, total: bigint): void => {
  balCache.set(userId, { total, at: Date.now() });
  if (balCache.size > 512) for (const [k, v] of balCache) if (Date.now() - v.at >= BAL_TTL_MS) balCache.delete(k);
};
export const invalidateBal = (userId: string): void => {
  balCache.delete(userId);
};

// Wallet DUSDC + whatever already sits in the manager from prior plays, read in parallel (two
// independent RPCs). Returns the parts so the mint can reuse the manager figure for funding instead
// of reading it a second time. Seeds the spendable-total cache for the next play's hot-path gate.
async function loadBalances(user: User): Promise<Balances> {
  const [wallet, manager] = await Promise.all([
    getDusdcBalanceRaw(user.address),
    user.predictManagerId ? getManagerBalanceRaw(user.predictManagerId) : Promise.resolve(0n),
  ]);
  const total = wallet + manager;
  seedBalCache(user.id, total);
  return { wallet, manager, total };
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
  | { game: 'range'; stake: string | number; asset: string; widthPct: number };

export type CreateResult = { play: PlayDTO };

// What executeForUser needs to sign: the user (dev = operator-signed; privy = the user's wallet).
const userCtx = (user: User) => ({ address: user.address, walletId: user.privyWalletId, publicKey: user.suiPublicKey });

async function resolveByGame(input: CreatePlayInput, stakeRaw: bigint): Promise<Resolved> {
  if (input.game === 'lucky') return resolveLucky(stakeRaw);
  return resolveRange(stakeRaw, input.asset, input.widthPct);
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
// Exported so wallet withdrawals serialize on the same per-user chain as plays/cashouts (they spend
// the same owned DUSDC + gas coins, so they must never run concurrently and equivocate).
export function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
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

// The routed oracle expired (or got settled) during the mint. Retrying the SAME oracle just aborts
// again, so this case re-routes to a fresh one instead of rebuilding the dead params. This was the
// dominant cause of plays erroring after the reels snapped (mint outran a near-buzzer oracle).
const isOracleGone = (e: unknown): boolean => {
  const m = e instanceof Error ? e.message : String(e);
  return /assert_live_oracle|EOracleExpired|EOracleSettled|EOracleNotActive|interpolate_price|trade_prices/i.test(m);
};

// Optimistic create: resolve the deal (the only thing the player waits on, ~1 scan round trip),
// persist it 'pending', and return immediately so the reels snap on the real dealt asset/side/
// multiplier. The actual Predict mint (balance read, funding, build, sign, submit) runs in the
// BACKGROUND under the per-user lock and flips the play 'open' (or 'error'), surfaced live over the
// play SSE. Pre-deal failures (bad params, no market, plainly insufficient) still throw here so the
// client gets a clean error and shows no reel; only the rare post-deal mint failure is async.
export async function createPlay(user: User, input: CreatePlayInput): Promise<CreateResult> {
  const stakeRaw = parseStake(input.stake);
  if (!user.predictManagerId) throw new PlayError('MANAGER_NOT_READY', 'Your account is still getting ready');

  // Fast affordability gate: reject only when a FRESH cached total is confidently short, so the hot
  // path takes no ~1.5s manager devInspect. Anything else proceeds; the background mint reads the
  // real balance and is the source of truth (a wrong guess there just re-racks, gracefully).
  const cached = balCache.get(user.id);
  if (cached && Date.now() - cached.at < BAL_TTL_MS && cached.total < stakeRaw) {
    throw new PlayError('INSUFFICIENT_DUSDC', 'Not enough chips for that bet');
  }

  // Resolve + price the deal off the live oracle (honest multiplier). The player waits only on this.
  const resolved = await resolveByGame(input, stakeRaw);
  const play = await prismaQuery.play.create({ data: mapResolvedToPlay(user.id, resolved, stakeRaw) });

  // Mint behind the spin animation; mintPending never throws (it marks the play 'error' on failure).
  void withUserLock(user.id, () => mintPending(user, resolved, stakeRaw, play.id, input));
  return { play: await toPlayDTO(play) };
}

// Funding plan for one mint: how much to deposit given the freshly read balances. Funds a bit above
// the bet (FUND_BUFFER_PCT) so the post-trade mint price never overdraws, and in bulk
// (BULK_FUND_PLAYS) so the next few spins skip the deposit. Never above the player's chips.
function fundingPlan(stakeRaw: bigint, total: bigint): { cappedNeed: bigint; refillTo: bigint } {
  const need = stakeRaw + (stakeRaw * FUND_BUFFER_PCT) / 100n;
  const cappedNeed = need > total ? total : need;
  const bulk = stakeRaw * BULK_FUND_PLAYS;
  const refill = bulk > total ? total : bulk;
  return { cappedNeed, refillTo: refill < cappedNeed ? cappedNeed : refill };
}

// Background mint for an already-resolved, already-persisted pending play. Runs under the per-user
// lock so a user's owned deposit coins never equivocate. Retries the SAME dealt params on a transient
// race (a coin version still settling, a momentary tight price) and NEVER re-deals a result already
// shown; a dead oracle or a real failure marks the play 'error' so the player re-racks. Chips are
// safe either way: the fund+mint is one atomic PTB, so a failed mint debits nothing. Resolves quietly.
async function mintPending(user: User, resolved: Resolved, stakeRaw: bigint, playId: string, input: CreatePlayInput): Promise<void> {
  const managerId = user.predictManagerId!;
  try {
    const balances = await loadBalances(user);
    if (balances.total < stakeRaw) {
      await prismaQuery.play.update({ where: { id: playId }, data: { status: 'error' } });
      return;
    }
    // Funding is sized off the stake (unchanged by a re-route), and a failed mint reverts atomically
    // so nothing moves, so the plan + the on-hand manager figure stay valid across every attempt.
    const { cappedNeed, refillTo } = fundingPlan(stakeRaw, balances.total);

    const MAX_ATTEMPTS = 3;
    let cur = resolved;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const tx = new Transaction();
      fundManager(tx, managerId, cappedNeed, refillTo, balances.manager);
      if (cur.kind === 'binary') buildMint(tx, managerId, cur.params);
      else buildMintRange(tx, managerId, cur.params);
      try {
        const exec = await executeForUser(tx, userCtx(user));
        await prismaQuery.play.update({
          where: { id: playId },
          data: { status: 'open', txMint: exec.digest, openedAt: new Date() },
        });
        invalidateBal(user.id); // the manager just changed; the next gate re-reads
        return;
      } catch (e) {
        lastErr = e;
        if (attempt >= MAX_ATTEMPTS - 1) throw e;
        if (isOracleGone(e)) {
          // The routed oracle expired/settled mid-mint: re-route to a fresh one (same deal via the
          // seed) and persist the new market params so the result + countdown match what minted.
          // If no market is available to re-route to, give up with the original error.
          const next = await reResolve(input, stakeRaw, cur).catch(() => null);
          if (!next) throw e;
          cur = next;
          await prismaQuery.play.update({ where: { id: playId }, data: marketFieldsOf(next) });
          continue;
        }
        if (isRetriableMint(e)) continue; // transient (owned-coin version race): just rebuild + resubmit
        throw e;
      }
    }
    throw lastErr;
  } catch (e) {
    console.error(`[plays] mint failed for ${playId}:`, e instanceof Error ? e.message : e);
    await prismaQuery.play.update({ where: { id: playId }, data: { status: 'error' } }).catch(() => {});
    invalidateBal(user.id);
  }
}

// The market + pricing fields a resolve produces. Split out from the create payload so a re-route
// (mintPending) can overwrite exactly these on an existing play without touching userId/game/stake/seed.
function marketFieldsOf(r: Resolved) {
  const base = {
    asset: r.asset,
    oracleId: r.market.oracleId,
    marketKey: serializeKey(r),
    durationSec: r.duration,
    expiry: BigInt(r.market.expiryMs),
    entrySpot: r.entrySpot,
    entryCost: r.entryCost,
    multiplier: r.multiplier,
  };
  if (r.kind === 'binary') {
    // Store the dealt nominal tier in the legacy `leverage` column (rounded to the int field);
    // the honest, mintable multiple lives in `multiplier`.
    return { ...base, side: r.side, leverage: Math.round(r.tier), strike: r.strikeDisplay };
  }
  return { ...base, lower: r.lowerDisplay, upper: r.upperDisplay, widthPct: r.widthPct ?? null };
}

function mapResolvedToPlay(userId: string, r: Resolved, stakeRaw: bigint) {
  const seed = r.kind === 'binary' ? { rngSeed: r.seed } : {};
  return { userId, game: r.game, status: 'pending', stake: stakeRaw, ...seed, ...marketFieldsOf(r) };
}

// A fresh resolve on a NEW oracle for the same bet, used to re-route a mint whose routed oracle
// expired mid-flight. Lucky reuses the original seed so the dealt asset/side/tier (already on the
// reels) stay identical; range re-derives from the same asset + band width. The strike/quantity/
// multiplier re-price against the new oracle, which is honest (the closest mintable to the deal).
function reResolve(input: CreatePlayInput, stakeRaw: bigint, prev: Resolved): Promise<Resolved> {
  if (input.game === 'lucky') return resolveLucky(stakeRaw, prev.kind === 'binary' ? prev.seed : undefined);
  return resolveRange(stakeRaw, input.asset, input.widthPct);
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
  invalidateBal(play.userId); // the redeem credited the manager; the next gate must re-read
  await recordSettlement(play.userId, { game: play.game, stakeRaw: play.stake, pnlRaw: pnl, won: pnl > 0n });
  const unlocked = await evaluateAndUnlock(play.userId);
  return { play: await toPlayDTO(updated), unlocked };
}

// === Expiry settlement (worker) ===

// Mirror the on-chain settlement exactly (oracle::compute_price): UP pays iff settlement > strike,
// so DOWN (its complement) pays iff settlement <= strike. The `<=` matters only at the exact tie,
// but using `<` there records a loss while the chain pays, stranding the redeem.
const isItm = (key: PlayKey, settlement1e9: bigint): boolean =>
  key.kind === 'binary'
    ? key.params.side === 'up'
      ? settlement1e9 > key.params.strike1e9
      : settlement1e9 <= key.params.strike1e9
    : settlement1e9 > key.params.lower1e9 && settlement1e9 <= key.params.higher1e9;

// An optimistic play whose background mint never completed (process died/hung between persist and
// the open/error write) would otherwise sit 'pending' forever. Sweep any older than this to 'error'
// so the client stops waiting. The threshold is well beyond a real mint's worst case (build+sign+
// submit timeouts), so a still-in-flight mint is never swept out from under itself.
const STUCK_PENDING_MS = 60_000;
async function sweepStuckPendings(): Promise<void> {
  const res = await prismaQuery.play.updateMany({
    where: { status: 'pending', createdAt: { lt: new Date(Date.now() - STUCK_PENDING_MS) } },
    data: { status: 'error' },
  });
  if (res.count > 0) console.log(`[Settle] swept ${res.count} stuck pending play(s) to error`);
}

// Give-up thresholds for the evidence-based sweep in settleDuePlays (Phase 3). We never error a play
// on elapsed time alone, because that wrongly kills a play whose oracle is merely behind (a downtime
// backlog, a transient RPC blip, or a settled win whose redeem is still retrying). A play is only
// given up when its oracle is PROVABLY unsettleable:
//  - UNSETTLEABLE_MS: the oracle reads fine but is unsettled and authorizes no cap the operator holds
//    (a dead deployment). Well beyond the worst real settle, so a live round is never touched.
//  - ORPHAN_GIVEUP_MS: the oracle object cannot be read at all for this long (its chain is gone, e.g.
//    a wiped/redeployed localnet). Far beyond any downtime+recovery, so a brief read failure is safe.
const UNSETTLEABLE_MS = 5 * 60_000;
const ORPHAN_GIVEUP_MS = 30 * 60_000;

// The authorized OracleSVICap to push/settle an oracle with: the live ladder cache (the cap
// oracle-roll used this process), else a cap the oracle authorizes on-chain that the operator still
// holds (this is what survives a restart, the cache is gone but the chain still knows). Undefined
// for a dead-deployment oracle whose caps the operator no longer owns, so it's left for the give-up
// sweep instead of poisoning the batch with a guess that would abort.
function resolveOracleCap(st: OracleState): string | undefined {
  const cached = getMarket(st.oracleId)?.capId;
  if (cached) return cached;
  return st.authorizedCapIds.find((id) => operatorCaps.oracleCapIds.includes(id));
}

// The price to freeze an oracle at: the live game feed (the same synthetic vol the chart + pusher
// used, so a round settles where the player watched it land), falling back to the oracle's last
// on-chain spot if the feed is briefly down. Null if neither is usable.
async function settleSpotUsd(asset: string, lastSpot1e9: bigint): Promise<number | null> {
  const fresh = await gameSpot(asset).catch(() => null);
  const px = fresh ? fresh.price : Number(lastSpot1e9) / 1e9;
  return px > 0 ? px : null;
}

// Drive a batch of expired-unsettled oracles to settlement in ONE operator tx: a post-expiry price
// push freezes each one's settlement price on-chain (oracle.move update_prices). Batching collapses
// what would be N serial operator round trips (the dominant settle cost when several rounds expire
// together) into a single tx. The frozen price IS the value pushed, so the settled state is updated
// in place with no re-read. Returns true on success (marks the states settled, retires them from the
// cache); false if the tx reverts, so the caller can isolate a bad oracle and retry the rest.
async function settleOracles(items: Array<{ st: OracleState; cap: string; spotUsd: number }>, states: Map<string, OracleState | null>): Promise<boolean> {
  if (items.length === 0) return true;
  try {
    const tx = new Transaction();
    for (const it of items) appendPriceUpdate(tx, it.st.oracleId, it.cap, it.spotUsd);
    await executeAsOperator(tx, `settle-nudge x${items.length}`);
    for (const it of items) {
      removeMarket(it.st.oracleId);
      states.set(it.st.oracleId, { ...it.st, settled: true, active: false, settlementPrice1e9: usd1e9(it.spotUsd) });
    }
    return true;
  } catch (e) {
    console.error(`[Settle] settle-nudge x${items.length} failed, will retry:`, e instanceof Error ? e.message : e);
    return false;
  }
}

// Settle every open play whose round has expired. Self-healing and play-driven: it reads each backing
// oracle straight from chain (so a market that left the live cache, e.g. after a restart, still
// settles) and drives any expired-but-unsettled oracle to settlement HERE, not via the worker's
// in-memory ladder. The nudges are BATCHED into one operator tx so a tick stays cheap no matter how
// many rounds expired together; losing plays then resolve with no tx (instant); winning plays redeem
// through the operator, capped per tick so a backlog can't monopolize the serial executor.
export async function settleDuePlays(): Promise<void> {
  await sweepStuckPendings();
  const due = await prismaQuery.play.findMany({ where: { status: 'open', expiry: { lte: BigInt(Date.now()) } } });
  if (due.length === 0) return;

  const byOracle = new Map<string, Play[]>();
  for (const p of due) {
    const arr = byOracle.get(p.oracleId);
    if (arr) arr.push(p);
    else byOracle.set(p.oracleId, [p]);
  }

  const states = new Map<string, OracleState | null>();
  await Promise.all(
    [...byOracle.keys()].map(async (id) => {
      try {
        states.set(id, await readOracle(id));
      } catch {
        states.set(id, null);
      }
    }),
  );

  // Phase 1: settle every expired-unsettled oracle in one batched nudge. Skip oracles with no usable
  // cap (a dead deployment), the give-up sweep clears their plays; never feed a bad cap to the batch.
  const now = Date.now();
  const toNudge: Array<{ st: OracleState; cap: string; spotUsd: number }> = [];
  for (const [oracleId, plays] of byOracle) {
    const st = states.get(oracleId);
    if (!st || st.settled || st.expiryMs > now) continue;
    const cap = resolveOracleCap(st);
    if (!cap) continue;
    const spotUsd = await settleSpotUsd(plays[0].asset, st.spot1e9);
    if (spotUsd != null) toNudge.push({ st, cap, spotUsd });
  }
  if (toNudge.length > 0 && !(await settleOracles(toNudge, states))) {
    // The batch reverted (e.g. one oracle was settled out from under it): isolate, so one bad oracle
    // can't block the rest. Each retry is idempotent (an already-settled push just aborts harmlessly).
    for (const it of toNudge) await settleOracles([it], states);
  }

  // Phase 2: resolve plays whose oracle is now settled. Losing plays cost no tx; winning plays redeem
  // through the operator, capped per tick.
  let redeems = 0;
  for (const [oracleId, plays] of byOracle) {
    const st = states.get(oracleId);
    if (!st?.settled || st.settlementPrice1e9 == null) continue;
    for (const play of plays) {
      const itm = isItm(deserializeKey(play), st.settlementPrice1e9);
      if (itm && redeems >= SETTLE_MAX_REDEEMS_PER_TICK) continue; // over the per-tick redeem budget
      try {
        await settleOnePlay(play, st.settlementPrice1e9);
        if (itm) redeems++;
      } catch (e) {
        console.error(`[Settle] play ${play.id} settle failed:`, e instanceof Error ? e.message : e);
      }
    }
  }

  // Phase 3: give up ONLY on plays whose oracle is provably unsettleable, never on elapsed time alone.
  // This runs AFTER the settle attempt above, so a play that could still settle (its oracle just rolled
  // behind, the chain was briefly down, or a settled win is mid-redeem) is left 'open' to resolve on a
  // later tick instead of being wrongly flipped to 'error'. The `status: 'open'` guard also skips any
  // play Phase 2 just resolved. Errors here mean "real position we genuinely cannot settle", not "slow".
  const deadBefore = BigInt(now - UNSETTLEABLE_MS);
  const orphanBefore = BigInt(now - ORPHAN_GIVEUP_MS);
  const giveUp: string[] = [];
  for (const [oracleId, plays] of byOracle) {
    const st = states.get(oracleId);
    const readableDead = !!st && !st.settled && !resolveOracleCap(st); // dead deployment: no cap we hold
    const unreadable = !st; // oracle object gone / chain wiped
    if (!readableDead && !unreadable) continue;
    const cutoff = readableDead ? deadBefore : orphanBefore;
    for (const p of plays) if (p.expiry < cutoff) giveUp.push(p.id);
  }
  if (giveUp.length > 0) {
    const res = await prismaQuery.play.updateMany({ where: { id: { in: giveUp }, status: 'open' }, data: { status: 'error' } });
    if (res.count > 0) console.log(`[Settle] gave up on ${res.count} unsettleable play(s)`);
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
    data: {
      status: itm ? 'won' : 'lost',
      payout: payoutRaw,
      markValue: payoutRaw,
      pnl,
      // The frozen settlement price (display): what the round actually settled at, for debug/audit.
      settlePrice: String(Number(settlement1e9) / 1e9),
      txRedeem: digest ?? play.txRedeem,
      settledAt: new Date(),
    },
  });
  if (itm) invalidateBal(play.userId); // the settle redeem credited the manager; the next gate re-reads
  await recordSettlement(play.userId, { game: play.game, stakeRaw: play.stake, pnlRaw: pnl, won: itm });
  await evaluateAndUnlock(play.userId);
}

// === Reads / DTO ===

// Live cash-out value for an open play (the redeem bid). Settled/closed plays use the
// stored payout. The raw read is a ~1.5s devInspect on the remote node.
export async function getLiveMarkRaw(play: Play): Promise<bigint> {
  if (play.status !== 'open') return play.payout ?? play.markValue ?? 0n;
  const key = deserializeKey(play);
  const amounts = key.kind === 'binary' ? await previewRedeem(key.params) : await previewRange(key.params);
  return amounts.payout;
}

// Cached live mark for the hot read paths (the play SSE tick + /plays/:id). A binary/range mark
// barely moves second to second, so a short TTL collapses the per-open-play devInspect storm that
// otherwise saturates the single-validator remote node (and starves the operator ladder). Pending/
// settled plays never hit the chain here. The cache holds the in-flight promise, not just the resolved
// value, so several concurrent readers of the same play (multiple SSE clients + the watchdog poll)
// share ONE ~1.5s devInspect instead of each firing their own. A failed read is evicted so it retries.
const markCache = new Map<string, { p: Promise<bigint>; at: number }>();
export async function getLiveMarkCached(play: Play): Promise<bigint> {
  if (play.status !== 'open') return play.payout ?? play.markValue ?? 0n;
  const now = Date.now();
  const hit = markCache.get(play.id);
  if (hit && now - hit.at < LIVE_MARK_TTL_MS) return hit.p;
  const entry = { p: getLiveMarkRaw(play), at: now };
  markCache.set(play.id, entry);
  // Don't pin a failed read; let the next tick re-read. Evict by identity so a slow read that rejects
  // after a fresher entry already replaced it can't delete that newer in-flight promise.
  entry.p.catch(() => { if (markCache.get(play.id) === entry) markCache.delete(play.id); });
  if (markCache.size > 512) for (const [k, v] of markCache) if (now - v.at >= LIVE_MARK_TTL_MS) markCache.delete(k);
  return entry.p;
}

const money = (raw: bigint): string => (Number(raw) / 1_000_000).toFixed(2);

function paramsDTO(play: Play): PlayDTO['params'] {
  // 'tap' is retired; any legacy tap rows were stored range-style (lower/upper), so render them as range.
  if (play.game === 'range' || play.game === 'tap') {
    return { asset: play.asset, lower: play.lower ?? '', upper: play.upper ?? '', widthPct: play.widthPct ?? 0, duration: play.durationSec };
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
    entrySpot: play.entrySpot ?? undefined,
    settlePrice: play.settlePrice ?? undefined,
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
  // Past the buzzer the mark is moot (about to become the payout), so skip its ~1.5s devInspect: the
  // client watchdog polls this fast during settling and only needs the status to flip. Mirror the SSE.
  const settling = play.status === 'open' && Date.now() >= Number(play.expiry);
  const mark = play.status === 'open' && !settling ? await getLiveMarkCached(play).catch(() => undefined) : undefined;
  return toPlayDTO(play, mark);
}

// Normalize any thrown value into a PlayError with a friendly code.
function asPlayError(e: unknown, code: PlayErrorCode, message: string): PlayError {
  if (e instanceof PlayError) return e;
  console.error('[plays]', message, e instanceof Error ? e.message : e);
  return new PlayError(code, message);
}
