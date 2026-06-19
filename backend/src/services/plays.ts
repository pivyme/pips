// The play lifecycle: create (mint), cash out (redeem), and expiry settle. The user's chips live
// in their PredictManager's BalanceManager: mint debits it, redeem credits it, so a play funds
// the manager up to the stake, then mints. Both modes finalize server-side: dev signs as the
// operator; privy signs with the user's embedded wallet via a session signer. No client round
// trip, no sponsor envelope.

import { Transaction } from '@mysten/sui/transactions';
import { coinWithBalance } from '@mysten/sui/transactions';

import type { Play, User } from '../../prisma/generated/client.js';
import { prismaQuery } from '../lib/prisma.ts';
import { SETTLE_MAX_REDEEMS_PER_TICK, LIVE_MARK_TTL_MS, ORACLE_ASSETS } from '../config/main-config.ts';
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
const invalidateBal = (userId: string): void => {
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
  void withUserLock(user.id, () => mintPending(user, resolved, stakeRaw, play.id));
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
async function mintPending(user: User, resolved: Resolved, stakeRaw: bigint, playId: string): Promise<void> {
  const managerId = user.predictManagerId!;
  try {
    const balances = await loadBalances(user);
    if (balances.total < stakeRaw) {
      await prismaQuery.play.update({ where: { id: playId }, data: { status: 'error' } });
      return;
    }
    const { cappedNeed, refillTo } = fundingPlan(stakeRaw, balances.total);

    const MAX_ATTEMPTS = 2;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const tx = new Transaction();
      fundManager(tx, managerId, cappedNeed, refillTo, balances.manager);
      if (resolved.kind === 'binary') buildMint(tx, managerId, resolved.params);
      else buildMintRange(tx, managerId, resolved.params);
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
        if (attempt < MAX_ATTEMPTS - 1 && isRetriableMint(e)) continue;
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

// The authorized OracleSVICap to push/settle an oracle with. Prefer the live ladder cache (the cap
// oracle-roll used this process), else a cap the oracle itself authorizes on-chain that the operator
// still holds (this is what survives a restart: the cache is gone but the chain still knows), else
// derive from the asset's push lane (oracle-roll round-robins caps by asset index). Undefined only
// when the operator holds no oracle cap at all.
function resolveOracleCap(st: OracleState, asset: string): string | undefined {
  const cached = getMarket(st.oracleId)?.capId;
  if (cached) return cached;
  const held = st.authorizedCapIds.find((id) => operatorCaps.oracleCapIds.includes(id));
  if (held) return held;
  const caps = operatorCaps.oracleCapIds;
  if (caps.length === 0) return undefined;
  const i = ORACLE_ASSETS.indexOf(asset.toUpperCase());
  return i >= 0 ? caps[i % caps.length] : caps[0];
}

// Drive an expired-but-unsettled oracle to settlement: a post-expiry price push freezes its
// settlement price on-chain (oracle.move update_prices). The frozen price IS the value we push, so
// we return the settled state without a re-read. Returns null if no authorized cap is available or
// the push reverts (a retry next tick is safe: once settled the push aborts EOracleSettled and the
// caller just reads it settled). Retires it from the live cache. This is the self-heal that makes
// settlement independent of the in-memory ladder, so a play never sits 'open' past expiry forever.
async function settleOracleOnChain(st: OracleState, asset: string): Promise<OracleState | null> {
  const cap = resolveOracleCap(st, asset);
  if (!cap) {
    console.error(`[Settle] no authorized cap to settle ${asset} oracle ${st.oracleId}`);
    return null;
  }
  // Settle at the live game price (the same synthetic feed the chart + pusher used), falling back to
  // the oracle's last on-chain spot if the feed is briefly down, so settlement never stalls.
  const fresh = await gameSpot(asset).catch(() => null);
  const spotUsd = fresh ? fresh.price : Number(st.spot1e9) / 1e9;
  if (!(spotUsd > 0)) {
    console.error(`[Settle] no settle price for ${asset} oracle ${st.oracleId}`);
    return null;
  }
  try {
    const tx = new Transaction();
    appendPriceUpdate(tx, st.oracleId, cap, spotUsd);
    await executeAsOperator(tx, `settle-nudge ${asset} ${st.oracleId}`);
    removeMarket(st.oracleId);
    return { ...st, settled: true, active: false, settlementPrice1e9: usd1e9(spotUsd) };
  } catch (e) {
    console.error(`[Settle] settle-nudge failed for ${asset} oracle ${st.oracleId}, will retry:`, e instanceof Error ? e.message : e);
    return null;
  }
}

// Settle every open play whose round has expired. Self-healing and play-driven: it reads each
// backing oracle straight from chain (so a market that left the live cache, e.g. after a restart, is
// fine) and, if that oracle is expired but not yet settled, drives it to settlement HERE rather than
// depending on the worker's in-memory ladder. Grouped by oracle so each is read + settled once.
// One per-tick budget caps the operator txs (settle nudges + ITM redeems both go through the single
// serial executor); the rest carry to the next tick. Losing plays settle with no on-chain tx.
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

  const now = Date.now();
  let ops = 0; // operator txs this tick (settle nudges + ITM redeems), capped to spare the executor
  for (const [oracleId, plays] of byOracle) {
    let st = states.get(oracleId) ?? null;
    if (!st) continue; // oracle object gone (e.g. an old deployment); nothing we can settle against

    if (!st.settled) {
      if (st.expiryMs > now) continue; // not actually past expiry on-chain yet; next tick
      if (ops >= SETTLE_MAX_REDEEMS_PER_TICK) continue; // over budget; next tick picks it up
      const settled = await settleOracleOnChain(st, plays[0].asset);
      if (!settled) continue; // nudge failed; retry next tick (resilient, not permanent)
      ops++;
      st = settled;
    }
    if (st.settlementPrice1e9 == null) continue;

    for (const play of plays) {
      const itm = isItm(deserializeKey(play), st.settlementPrice1e9);
      if (itm && ops >= SETTLE_MAX_REDEEMS_PER_TICK) continue; // over the per-tick redeem budget
      try {
        await settleOnePlay(play, st.settlementPrice1e9);
        if (itm) ops++;
      } catch (e) {
        console.error(`[Settle] play ${play.id} settle failed:`, e instanceof Error ? e.message : e);
      }
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
// settled plays never hit the chain here.
const markCache = new Map<string, { mark: bigint; at: number }>();
export async function getLiveMarkCached(play: Play): Promise<bigint> {
  if (play.status !== 'open') return play.payout ?? play.markValue ?? 0n;
  const now = Date.now();
  const hit = markCache.get(play.id);
  if (hit && now - hit.at < LIVE_MARK_TTL_MS) return hit.mark;
  const mark = await getLiveMarkRaw(play);
  markCache.set(play.id, { mark, at: now });
  if (markCache.size > 512) for (const [k, v] of markCache) if (now - v.at >= LIVE_MARK_TTL_MS) markCache.delete(k);
  return mark;
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
  const mark = play.status === 'open' ? await getLiveMarkCached(play).catch(() => undefined) : undefined;
  return toPlayDTO(play, mark);
}

// Normalize any thrown value into a PlayError with a friendly code.
function asPlayError(e: unknown, code: PlayErrorCode, message: string): PlayError {
  if (e instanceof PlayError) return e;
  console.error('[plays]', message, e instanceof Error ? e.message : e);
  return new PlayError(code, message);
}
