// Play lifecycle: create (mint), cash out (redeem), expiry settle. Chips live in the user's
// PredictManager BalanceManager (mint debits, redeem credits); dev signs as operator, privy signs via the embedded wallet, no client round trip.

import { Transaction } from '@mysten/sui/transactions';

import type { Play, Prisma, User } from '../../prisma/generated/client.js';
import { prismaQuery } from '../lib/prisma.ts';
import { publishPlay } from '../lib/play-bus.ts';
import { SETTLE_MAX_REDEEMS_PER_TICK, LIVE_MARK_TTL_MS } from '../config/main-config.ts';
import { fromDusdcRaw, multiplier as multiplierOf } from '../lib/sui/config.ts';
import { getDusdcBalanceRaw } from '../lib/sui/dusdc.ts';
import {
  buildRedeemSettled,
  buildMintPlay,
  buildRedeemLivePlay,
  decodeOrderId,
  findRealRedeem,
  LEVERAGE_ONE,
  parseMint,
  parseRedeem,
  readMarketSettlement,
  readWrapper,
  readWrapperBalanceRaw,
  resolveWrapper,
} from '../lib/sui/predict-real.ts';
import { rakeOf, revenueAddress } from '../lib/sui/house.ts';
import { alert } from '../lib/alert.ts';
import { checkPlayAllowed, recordPlay, clearPlay } from '../lib/sui/play-safety.ts';
import { executeForUser, executeRealSettle, userContext } from '../lib/sui/execute.ts';
import {
  resolveReal,
  restrikeBinary,
  parseStake,
  PlayError,
  type PlayErrorCode,
  type ResolvedReal,
} from './games.ts';
import { recordSettlement } from './stats.ts';
import { evaluateAndUnlock } from './achievements.ts';
import type { Game, PlayDTO, PlayStatus, Side } from '../types/api.ts';

// Bright-yellow console line for the two round moments the player feels (open + settle); SETTLE
// prints how long after expiry it landed, so a stuck settle is obvious at a glance.
const hhmmss = (): string => new Date().toTimeString().slice(0, 8);
const roundLog = (msg: string): void => console.log(`\x1b[33m${msg}\x1b[0m`);

// Commit a play-row update, then notify the play bus, the single choke point for every status write
// so the SSE push is never missed. Emit strictly after commit: emitting before would push the SSE a stale row.
async function commitPlay(playId: string, data: Prisma.PlayUpdateInput): Promise<Play> {
  const updated = await prismaQuery.play.update({ where: { id: playId }, data });
  publishPlay(playId, updated); // hand the fresh row through so the SSE pushes it with no DB re-read
  return updated;
}

// === Balance ===

// Best-effort spendable-total cache (per user), seeded by every real balance read. Exists only to
// fast-reject an obviously-unaffordable bet without a ~1.5s manager devInspect; safe to be stale-high, never stale-low, so callers invalidate it on cash-out / settle wins.
const balCache = new Map<string, { total: bigint; at: number }>();
const BAL_TTL_MS = 8000;
const seedBalCache = (userId: string, total: bigint): void => {
  balCache.set(userId, { total, at: Date.now() });
  if (balCache.size > 512) for (const [k, v] of balCache) if (Date.now() - v.at >= BAL_TTL_MS) balCache.delete(k);
};
export const invalidateBal = (userId: string): void => {
  balCache.delete(userId);
};

// === Create ===

export type CreatePlayInput =
  | { game: 'lucky'; stake: string | number }
  | { game: 'range'; stake: string | number; asset: string; widthPct: number }
  | { game: 'moonshot'; stake: string | number; asset: string; side: Side; reach: number };

export type CreateResult = { play: PlayDTO };

// What executeForUser needs to sign for this user (dev = operator, privy = embedded wallet, wallet = custodial); one shared builder keeps every signing path consistent.
const userCtx = userContext;

// Bulk-refill horizon: a deposit is the slow part of a spin (forces a coin read + bigger tx), so a short wrapper tops to this many bets' worth (capped at the player's chips) instead of just one.
// Modest on purpose, to avoid parking a big idle balance for a one-off player.
const BULK_FUND_PLAYS = 5n;

// Serialize each user's own txs: a play/cashout spends that user's owned gas + DUSDC coins, so two in flight pick the same coin version and equivocate.
// One promise chain per user keeps their txs strictly sequential; different users still run fully in parallel.
const userChains = new Map<string, Promise<unknown>>();
// Exported so wallet withdrawals serialize on the same per-user chain as plays/cashouts, they spend the same owned coins and must never run concurrently.
export function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const run = (userChains.get(userId) ?? Promise.resolve()).then(fn, fn);
  userChains.set(
    userId,
    run.then(
      () => { },
      () => { },
    ),
  );
  return run;
}

// Transient, retryable mint failures: an oracle ticking past expiry, a tight post-trade price, or an owned-coin version race (fullnode serving a stale coin).
// A fresh resolve/tx.build fixes all three; auth/balance/param errors are not retried.
const isRetriableMint = (e: unknown): boolean => {
  const m = e instanceof Error ? e.message : String(e);
  return /assert_live_oracle|EOracleExpired|withdraw|interpolate_price|trade_prices|MoveAbort|MovePrimitiveRuntimeError|unavailable for consumption|not available|needs to be rebuilt|already locked|rejected as invalid|equivocat|reserved for another/i.test(
    m,
  );
};

// Optimistic create: resolve the deal (~1 scan round trip, the only wait), persist 'pending', return immediately so the reels snap on the real dealt outcome.
// The actual mint runs in the background under the per-user lock and flips the play open/error over the SSE; pre-deal failures still throw here for a clean client error.
export async function createPlay(user: User, input: CreatePlayInput): Promise<CreateResult> {
  // Real-mode safety gate (no-op in fork): refuse if the gas sponsor is paused (reserve below floor), and rate-limit per user so finite testnet gas isn't burned by a spammer.
  const block = checkPlayAllowed(user.id);
  if (block) throw new PlayError(block.code, block.message);
  recordPlay(user.id); // reserve the cooldown slot so a double-tap can't slip two plays past the gate

  try {
    const stakeRaw = parseStake(input.stake);
    // Fast affordability gate: reject only when a fresh cached total is confidently short, so the hot path skips the ~1.5s balance devInspect.
    // Anything else proceeds, the background mint reads the real balance and is the source of truth.
    const cached = balCache.get(user.id);
    if (cached && Date.now() - cached.at < BAL_TTL_MS && cached.total < stakeRaw) {
      throw new PlayError('INSUFFICIENT_DUSDC', 'Not enough chips for that play');
    }
    return await createPlayReal(user, input, stakeRaw);
  } catch (e) {
    clearPlay(user.id); // the play never landed (bad params / no market); don't hold the cooldown
    throw e;
  }
}

// Create path: per-owner AccountWrapper, deposit->mint dance in one sponsored PTB, optimistic.
// Resolves the deal, persists 'pending' with the market id in oracleId, returns for the reel snap; mintPendingReal fills in the order id + real multiplier in the background.
async function createPlayReal(user: User, input: CreatePlayInput, stakeRaw: bigint): Promise<CreateResult> {
  // Same net/stake split as the fork: mint budget sized off net, wrapper funded to the full stake so the rake withdraws cleanly post-mint (rake = 0 unless a wallet is set).
  const { rake, net } = rakeOf(stakeRaw);
  const resolved = await resolveReal(input, net, stakeRaw);
  const play = await prismaQuery.play.create({ data: mapRealResolvedToPlay(user.id, resolved, stakeRaw, rake) });
  void withUserLock(user.id, () => mintPendingReal(user, resolved, stakeRaw, rake, play.id, input));
  return { play: await toPlayDTO(play) };
}

// Deposit sizing for a mint: a wrapper already holding a full stake needs no deposit, since the mint draw is always <= stake.
// Otherwise tops to BULK_FUND_PLAYS worth (capped at the player's chips) so later spins mint deposit-free.
function realDeposit(stakeRaw: bigint, wrapperBal: bigint, wallet: bigint): bigint {
  if (wrapperBal >= stakeRaw) return 0n; // a full stake already sits in the wrapper: deposit-free
  const total = wrapperBal + wallet;
  const bulk = stakeRaw * BULK_FUND_PLAYS;
  const target = bulk < total ? bulk : total; // never target more than the player's chips
  const deposit = target - wrapperBal; // <= wallet since target <= total
  return deposit > 0n ? deposit : 0n;
}

// === Create / mint ===
// Resolve to ticks + a premium budget, then ensure the wrapper, deposit the shortfall, and mint in one sponsored PTB in the background.
// The order id and minted multiplier are only known post-mint, so the pending play carries a placeholder that mintPendingReal fills in.

// The real-play market/pricing fields a resolve produces (re-route overwrites exactly these).
function realMarketFieldsOf(r: ResolvedReal) {
  const base = { asset: r.asset, oracleId: r.marketId, durationSec: r.duration, expiry: BigInt(r.expiryMs), entrySpot: r.entrySpot };
  if (r.kind === 'binary') return { ...base, side: r.side, strike: r.strikeDisplay };
  return { ...base, lower: r.lowerDisplay, upper: r.upperDisplay, widthPct: r.widthPct ?? null };
}

function mapRealResolvedToPlay(userId: string, r: ResolvedReal, stakeRaw: bigint, rakeRaw: bigint) {
  const seed = r.game === 'lucky' && r.seed ? { rngSeed: r.seed } : {};
  return {
    userId,
    game: r.game,
    status: 'pending',
    stake: stakeRaw,
    marketKey: '', // real: filled with the u256 order id after mint (settle reads this)
    entryCost: r.amountRaw + rakeRaw, // provisional all-in budget (mint budget + rake); snapped after mint
    multiplier: r.tierMultiplier, // reel estimate; snapped to the real minted multiplier after mint
    leverage: Number(r.leverage1e9) / 1e9, // reel/quote estimate; snapped to the REAL admitted leverage after mint
    ...seed,
    ...realMarketFieldsOf(r),
  };
}

// Fresh real resolve on a live market for the same bet, to re-route a mint whose market expired mid-flight; Lucky keeps its seed, null if none is live.
async function reResolveReal(input: CreatePlayInput, netRaw: bigint, stakeRaw: bigint, prev: ResolvedReal): Promise<ResolvedReal | null> {
  try {
    return await resolveReal(input, netRaw, stakeRaw, prev.game === 'lucky' ? prev.seed : undefined);
  } catch {
    return null;
  }
}

// Market expired/settled or paused mid mint/redeem (pricer can't load / mint not allowed): re-route (mint) or lock-in (cash-out) rather than retry the dead market.
const isRealMarketGone = (e: unknown): boolean =>
  /assert_live_mint|assert_quoteable|EMarket|EOracle|expired|settled|mint_paused|not live|load_live_pricer/i.test(
    e instanceof Error ? e.message : String(e),
  );

// Cached wrapper id is stale (a devnet wipe deleted the shared object) so the mint aborts on a missing input; only meaningful when a cache exists, a first play derives fresh.
const isWrapperGone = (e: unknown): boolean =>
  /not found|does not exist|no such object|deleted|notexist/i.test(e instanceof Error ? e.message : String(e));

// Admission abort from strike_exposure_config (LUCKY.md §5b): leverage exceeds the tier's probability-gated cap, strike probability out of bounds, premium below $1, or opens below liquidation.
// Fallback drops leverage to 1x (closest achievable tier) and retries the same strike.
const isAdmissionAbort = (e: unknown): boolean =>
  /strike_exposure_config|ELeverageAboveAdmission|EInvalidLeverage|EEntryProbabilityOutOfBounds|ENetPremiumBelowMinimum|EOrderBelowLiquidationThreshold/i.test(
    e instanceof Error ? e.message : String(e),
  );

// Routed market's payout backing is short of what this mint needs (expiry_cash::assert_backing abort 0): just rolled its 1-min cadence unfunded, or drained by open interest.
// Mint only asserts backing, never pulls pool cash, so recovery rebalances first (plp::rebalance_expiry_cash) folded into the retry PTB.
const isBackingAbort = (e: unknown): boolean =>
  /expiry_cash|assert_backing|EInsufficientBacking/i.test(e instanceof Error ? e.message : String(e));

async function mintPendingReal(user: User, resolved: ResolvedReal, stakeRaw: bigint, rakeRaw: bigint, playId: string, input: CreatePlayInput): Promise<void> {
  let cur = resolved;
  const net = stakeRaw - rakeRaw; // sizing stake a re-route re-prices against (== stake at rake 0)
  let acct = user; // may lose a stale wrapper-id cache mid-flight (self-heal)
  let rebalanceBacking = false; // set after an assert_backing abort: fund the market in the retry PTB
  try {
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const w = await resolveWrapper(acct.address, acct.predictWrapperId);
      // Mint draws from the wrapper's internal balance (spendable = wallet + internal chips); read both in parallel like the fork's loadBalances instead of serially.
      const [wrapperBal, wallet] = await Promise.all([
        w.exists ? readWrapperBalanceRaw(w.wrapperId, acct.address).catch(() => 0n) : Promise.resolve(0n),
        getDusdcBalanceRaw(acct.address),
      ]);
      const total = wallet + wrapperBal;
      seedBalCache(acct.id, total);
      if (total < stakeRaw) {
        await commitPlay(playId, { status: 'error' });
        return;
      }
      // Bulk-fund the wrapper so most spins mint with no deposit (smaller PTB): top in bulk when short, draw from the internal balance when it already holds a stake.
      const depositRaw = realDeposit(stakeRaw, wrapperBal, wallet);

      const tx = new Transaction();
      buildMintPlay(tx, {
        marketId: cur.marketId,
        wrapperId: w.wrapperId,
        wrapperExists: w.exists,
        rebalanceBacking,
        depositRaw,
        amountRaw: cur.amountRaw,
        minQuantityRaw: cur.minQuantityRaw,
        leverage1e9: cur.leverage1e9,
        lowerTick: cur.lowerTick,
        higherTick: cur.higherTick,
        // House rake: withdrawn from the wrapper after the mint and sent to revenue (no-op at rake 0).
        rakeRaw,
        revenueAddress: rakeRaw > 0n ? revenueAddress : undefined,
      });

      try {
        const exec = await executeForUser(tx, userCtx(acct));
        const mint = parseMint(exec.events);
        // Cache the derived wrapper id after a first-ever create so later plays skip the derive read.
        if (!w.exists && !acct.predictWrapperId) {
          await prismaQuery.user.update({ where: { id: acct.id }, data: { predictWrapperId: w.wrapperId } }).catch(() => {});
        }
        const actualMultiplier = multiplierOf(mint.costRaw, mint.quantityRaw);
        roundLog(
          `[Round OPEN]   ${cur.game.padEnd(5)} BTC  ` +
          (cur.kind === 'binary' ? `${(cur.side ?? '').toUpperCase().padEnd(4)} strike=${cur.strikeDisplay}` : `band=(${cur.lowerDisplay}, ${cur.upperDisplay}]`) +
          `  x${actualMultiplier.toFixed(2)}  lev=${Number(cur.leverage1e9) / 1e9}  entry=$${fromDusdcRaw(mint.costRaw).toFixed(2)}` +
          `  order=${mint.orderId.toString().slice(0, 10)}…  expires in ${Math.max(0, Math.round((cur.expiryMs - Date.now()) / 1000))}s @${hhmmss()} tx=${exec.digest.slice(0, 8)}`,
        );
        await commitPlay(playId, {
          status: 'open',
          txMint: exec.digest,
          marketKey: mint.orderId.toString(), // the settle worker's key (decodeOrderId derives the close qty)
          // All-in cost = on-chain mint cost + the rake withdrawn to revenue (== mint.costRaw at rake 0).
          entryCost: mint.costRaw + rakeRaw,
          rake: rakeRaw, // exact fee collected: the auditable ground truth for referral revshare (referral.ts). Only minted plays carry rake > 0.
          multiplier: actualMultiplier,
          leverage: Number(mint.leverage1e9) / 1e9, // the REAL admitted leverage (may be trimmed from the request)
          openedAt: new Date(),
        });
        invalidateBal(acct.id);
        return;
      } catch (e) {
        lastErr = e;
        if (attempt >= MAX_ATTEMPTS - 1) throw e;
        // Stale wrapper-id cache (devnet wipe): drop it and re-derive on the next attempt.
        if (acct.predictWrapperId && isWrapperGone(e)) {
          await prismaQuery.user.update({ where: { id: acct.id }, data: { predictWrapperId: null } }).catch(() => {});
          acct = { ...acct, predictWrapperId: null };
          continue;
        }
        // Routed market expired/settled mid-mint: re-route to a fresh live one (keeps the dealt draw).
        if (isRealMarketGone(e)) {
          const next = await reResolveReal(input, net, stakeRaw, cur);
          if (!next) throw e;
          cur = next;
          await prismaQuery.play.update({ where: { id: playId }, data: realMarketFieldsOf(next) });
          continue;
        }
        // Admission abort (LUCKY.md §5b): drop to leverage 1x, and for a binary also re-price the strike for that leverage (it was priced assuming the rejected higher leverage); RANGE keeps its band as-is.
        // Already at 1x means genuinely unmintable, so fall through to error instead of looping a doomed mint.
        if (isAdmissionAbort(e) && cur.leverage1e9 > LEVERAGE_ONE) {
          cur = cur.kind === 'binary' ? restrikeBinary(cur, LEVERAGE_ONE) : { ...cur, leverage1e9: LEVERAGE_ONE };
          await prismaQuery.play
            .update({ where: { id: playId }, data: cur.kind === 'binary' ? { leverage: 1, strike: cur.strikeDisplay } : { leverage: 1 } })
            .catch(() => {});
          continue;
        }
        // Market backing short: prepend a permissionless rebalance into the retry PTB so fund+mint lands atomically. Sticky once set, so every later attempt keeps funding.
        // If it still aborts, the pool's idle liquidity is genuinely dry, falls through to error with chips safe.
        if (isBackingAbort(e) && !rebalanceBacking) {
          rebalanceBacking = true;
          continue;
        }
        if (isRetriableMint(e)) continue; // transient owned-coin version race: rebuild + resubmit
        throw e;
      }
    }
    throw lastErr;
  } catch (e) {
    console.error(`[plays] real mint failed for ${playId}:`, e instanceof Error ? e.message : e);
    await commitPlay(playId, { status: 'error' }).catch(() => {});
    invalidateBal(acct.id);
  }
}

// === Cash out (redeem at the live mark) ===

export type CashoutResult = { play: PlayDTO; unlocked: string[] };

export function cashoutPlay(user: User, playId: string): Promise<CashoutResult> {
  return withUserLock(user.id, () => cashoutRealLocked(user, playId));
}

// Live cash-out: redeem_live (owner-authed, mark-to-market) closes the full position, payout credited into the wrapper's internal balance.
// Close quantity is decoded from the packed order id, so no extra column is needed.
async function cashoutRealLocked(user: User, playId: string): Promise<CashoutResult> {
  const play = await prismaQuery.play.findFirst({ where: { id: playId, userId: user.id } });
  if (!play) throw new PlayError('PLAY_NOT_OPEN', 'Play not found');
  if (play.status !== 'open') throw new PlayError('PLAY_NOT_OPEN', 'This play is not open');
  if (!play.marketKey) throw new PlayError('PLAY_NOT_OPEN', 'Play is still opening');

  const w = await resolveWrapper(user.address, user.predictWrapperId);
  const { orderId, quantityRaw } = realOrderOf(play);
  const tx = new Transaction();
  buildRedeemLivePlay(tx, { marketId: play.oracleId, wrapperId: w.wrapperId, orderId, closeQuantityRaw: quantityRaw });
  try {
    const exec = await executeForUser(tx, userCtx(user));
    const r = parseRedeem(exec.events);
    return finalizeCashout(play, r.payoutRaw, exec.digest);
  } catch (e) {
    // Buzzer beat the cash-out: past expiry the market is no longer quoteable, so the position settles to win/loss; the settle worker finalizes it shortly.
    if (isOracleExpiredAbort(e) || isRealMarketGone(e)) throw new PlayError('PLAY_NOT_OPEN', 'Round is settling, your result is locking in');
    throw asPlayError(e, 'REDEEM_FAILED', 'Could not cash out right now. Try again.');
  }
}

// Redeem lost the race to the buzzer: the market crossed expiry into the unsettled gap (assert_quoteable_oracle/EOracleExpired) or already settled.
// Either way the round is over and resolves via settlement, not a retry.
const isOracleExpiredAbort = (e: unknown): boolean => {
  const m = e instanceof Error ? e.message : String(e);
  return /assert_quoteable_oracle|EOracleExpired|EOracleSettled/i.test(m);
};

async function finalizeCashout(play: Play, payoutRaw: bigint, digest: string): Promise<{ play: PlayDTO; unlocked: string[] }> {
  const pnl = payoutRaw - play.entryCost;
  const updated = await commitPlay(play.id, {
    status: 'cashed_out',
    payout: payoutRaw,
    markValue: payoutRaw,
    pnl,
    txRedeem: digest,
    settlePrice: null,
    settledAt: new Date(),
  });
  invalidateBal(play.userId); // the redeem credited the manager; the next gate must re-read
  await recordSettlement(play.userId);
  const unlocked = await evaluateAndUnlock(play.userId);
  return { play: await toPlayDTO(updated), unlocked };
}

// === Expiry settlement (worker) ===

// A play whose background mint never completed (process died between persist and open/error) would sit 'pending' forever, so sweep any older than this to 'error'.
// Threshold is well beyond a real mint's worst case, so a still-in-flight mint is never swept out from under itself.
const STUCK_PENDING_MS = 60_000;
async function sweepStuckPendings(): Promise<void> {
  const stuck = await prismaQuery.play.findMany({
    where: { status: 'pending', createdAt: { lt: new Date(Date.now() - STUCK_PENDING_MS) } },
    select: { id: true },
  });
  if (stuck.length === 0) return;
  const ids = stuck.map((p) => p.id);
  const res = await prismaQuery.play.updateMany({ where: { id: { in: ids }, status: 'pending' }, data: { status: 'error' } });
  // Push the error to any SSE still holding one of these pending plays so it resolves at once instead of waiting out the watchdog.
  for (const id of ids) publishPlay(id);
  if (res.count > 0) console.log(`[Settle] swept ${res.count} stuck pending play(s) to error`);
}

// Give-up thresholds for the evidence-based sweep in settleDuePlaysReal: never error on elapsed time alone, only when the market is provably unsettleable.
const UNSETTLEABLE_MS = 5 * 60_000; // market reads fine but unsettled far longer than any settle should take
const ORPHAN_GIVEUP_MS = 30 * 60_000; // market object unreadable this long (chain gone)

// === Settlement ===
// Mysten's Predict settles from Pyth-at-expiry, not a price we push, so there's no operator nudge: redeem_settled (permissionless, full-close) drives ensure_settled then pays $1*qty or 0 into the wrapper.
// Self-healing: reconciles an already-closed position against its on-chain redeem event, gives up only on a provably-stuck/gone market. Stores the ExpiryMarket id in oracleId, the u256 order id in marketKey (quantity decoded from it).

// Full close quantity for a real play, decoded from its packed order id.
const realOrderOf = (play: Play): { orderId: bigint; quantityRaw: bigint } => {
  const orderId = BigInt(play.marketKey);
  return { orderId, quantityRaw: decodeOrderId(orderId).quantityRaw };
};

// Resolve the user's wrapper id for a settle: the cached column, else the deterministic derived address.
async function wrapperIdForUser(userId: string): Promise<string | null> {
  const user = await prismaQuery.user.findUnique({ where: { id: userId }, select: { predictWrapperId: true, address: true } });
  if (user?.predictWrapperId) return user.predictWrapperId;
  if (!user?.address) return null;
  return (await readWrapper(user.address)).wrapperId;
}

// Write the resolved outcome for a play: a settled win pays into the wrapper (invalidate the balance gate), a loss/liquidation pays 0.
async function finalizeRealSettle(
  play: Play,
  outcome: { payoutRaw: bigint; status: PlayStatus; settlePrice1e9: bigint | null; digest?: string },
): Promise<void> {
  const won = outcome.status === 'won';
  const pnl = outcome.payoutRaw - play.entryCost;
  await commitPlay(play.id, {
    status: outcome.status,
    payout: outcome.payoutRaw,
    markValue: outcome.payoutRaw,
    pnl,
    settlePrice: outcome.settlePrice1e9 != null ? String(Number(outcome.settlePrice1e9) / 1e9) : play.settlePrice,
    txRedeem: outcome.digest ?? play.txRedeem,
    settledAt: new Date(),
  });
  if (won || outcome.status === 'cashed_out') invalidateBal(play.userId);
  await recordSettlement(play.userId);
  await evaluateAndUnlock(play.userId);
}

// Reconcile a real play whose redeem_settled failed, in order: (1) already redeemed on chain, recover the true payout, (2) market not settleable yet, retry next tick, (3) provably gone/stuck for far longer than any settle, give up to error.
// Leaves the play 'open' when a later tick can still resolve it.
async function reconcileRealSettle(play: Play, wrapperId: string, orderId: bigint, now: number, err: unknown): Promise<void> {
  const onChain = await findRealRedeem(wrapperId, orderId).catch(() => null);
  if (onChain) {
    const status: PlayStatus = onChain.liquidated ? 'lost' : onChain.settled ? (onChain.payoutRaw > 0n ? 'won' : 'lost') : 'cashed_out';
    const settle = onChain.settled ? await readMarketSettlement(play.oracleId).catch(() => null) : null;
    await finalizeRealSettle(play, { payoutRaw: onChain.payoutRaw, status, settlePrice1e9: settle?.settlementPrice1e9 ?? null, digest: onChain.digest });
    console.log(`\x1b[33m[Settle] reconciled real ${play.id}: already ${status} on-chain, payout=$${fromDusdcRaw(onChain.payoutRaw).toFixed(2)}\x1b[0m`);
    return;
  }
  const ms = await readMarketSettlement(play.oracleId).catch(() => null);
  const unreadable = ms === null;
  const cutoff = BigInt(now - (unreadable ? ORPHAN_GIVEUP_MS : UNSETTLEABLE_MS));
  if (play.expiry < cutoff) {
    await commitPlay(play.id, { status: 'error', settledAt: new Date() });
    console.warn(`[Settle] real ${play.id} unsettleable (${unreadable ? 'market gone' : 'not settled'}); marked error`);
    // Real-mode give-up after the orphan window; alert so a human can look, since real chips are involved (L-008/L-011).
    alert('critical', 'real play unsettleable after orphan window, marked error', { playId: play.id, reason: unreadable ? 'market gone' : 'not settled' });
    return;
  }
  // Market not settled yet, or a transient tx failure: leave 'open' to retry on a later tick.
  console.error(`[Settle] real ${play.id} redeem_settled failed, will retry:`, err instanceof Error ? err.message : err);
}

// Settle one open real play; returns true iff it spent a redeem tx (for the per-tick budget), false if not-yet-settleable so it doesn't burn the budget.
async function settleOnePlayReal(play: Play, now: number): Promise<boolean> {
  const wrapperId = await wrapperIdForUser(play.userId);
  if (!wrapperId) {
    console.error(`[Settle] real ${play.id}: user has no wrapper; will retry`);
    return false;
  }
  const { orderId, quantityRaw } = realOrderOf(play);
  const lagS = Math.round((now - Number(play.expiry)) / 1000);
  try {
    const tx = new Transaction();
    buildRedeemSettled(tx, { marketId: play.oracleId, wrapperId, orderId, closeQuantityRaw: quantityRaw });
    // Direct build-sign-submit, not the coin-caching serial executor: redeem_settled is all-shared-input, so testnet pays gas from the settle wallet's address balance, which the serial executor's post-exec gas-coin cache chokes on.
    // The direct path reads effects.status only, so a settled redeem resolves this tick.
    const exec = await executeRealSettle(tx, `settle-redeem-real ${play.id}`);
    const r = parseRedeem(exec.events);
    const status: PlayStatus = r.liquidated ? 'lost' : r.payoutRaw > 0n ? 'won' : 'lost';
    roundLog(`[Round SETTLE] ${play.game.padEnd(5)} ${play.asset.padEnd(4)} real order=${orderId.toString().slice(0, 8)}… ${status === 'won' ? 'WIN ' : 'LOSS'} payout=$${fromDusdcRaw(r.payoutRaw).toFixed(2)} (expired ${lagS}s ago) @${hhmmss()}`);
    await finalizeRealSettle(play, { payoutRaw: r.payoutRaw, status, settlePrice1e9: r.settlementPrice1e9, digest: exec.digest });
    return true;
  } catch (e) {
    await reconcileRealSettle(play, wrapperId, orderId, now, e);
    return false;
  }
}

// Settle every open real play whose 1m round has expired, budget-capped per tick like the fork.
export async function settleDuePlaysReal(): Promise<void> {
  await sweepStuckPendings();
  const due = await prismaQuery.play.findMany({ where: { status: 'open', expiry: { lte: BigInt(Date.now()) } } });
  if (due.length === 0) return;
  const now = Date.now();
  let redeems = 0;
  for (const play of due) {
    if (redeems >= SETTLE_MAX_REDEEMS_PER_TICK) break;
    try {
      if (await settleOnePlayReal(play, now)) redeems++;
    } catch (e) {
      console.error(`[Settle] real play ${play.id} settle failed:`, e instanceof Error ? e.message : e);
    }
  }
}

// === Reads / DTO ===

// Live cash-out value for an open play. Live P/L is chart-synced on the client, and a backend redeem_live
// devInspect needs a funded wrapper + same-PTB pricer, so we don't poll a server mark: return the entry as
// a neutral mark and the client draws the live swing off the chart. Settled/closed plays use the stored payout.
export async function getLiveMarkRaw(play: Play): Promise<bigint> {
  if (play.status !== 'open') return play.payout ?? play.markValue ?? 0n;
  return play.markValue ?? play.entryCost;
}

// Cached live mark for the hot read paths (play SSE tick + /plays/:id): a short TTL collapses the per-open-play devInspect storm that would otherwise saturate the remote node.
// Caches the in-flight promise (not just the value) so concurrent readers share one devInspect; a failed read is evicted so it retries.
const markCache = new Map<string, { p: Promise<bigint>; at: number }>();
export async function getLiveMarkCached(play: Play): Promise<bigint> {
  if (play.status !== 'open') return play.payout ?? play.markValue ?? 0n;
  const now = Date.now();
  const hit = markCache.get(play.id);
  if (hit && now - hit.at < LIVE_MARK_TTL_MS) return hit.p;
  const entry = { p: getLiveMarkRaw(play), at: now };
  markCache.set(play.id, entry);
  // Evict by identity on failure (not by key) so a stale rejecting read can't delete a fresher in-flight promise that already replaced it.
  entry.p.catch(() => { if (markCache.get(play.id) === entry) markCache.delete(play.id); });
  if (markCache.size > 512) for (const [k, v] of markCache) if (now - v.at >= LIVE_MARK_TTL_MS) markCache.delete(k);
  return entry.p;
}

const money = (raw: bigint): string => fromDusdcRaw(raw).toFixed(2);

function paramsDTO(play: Play): PlayDTO['params'] {
  // 'tap' is retired; any legacy tap rows were stored range-style (lower/upper), so render them as range.
  if (play.game === 'range' || play.game === 'tap') {
    return { asset: play.asset, lower: play.lower ?? '', upper: play.upper ?? '', widthPct: play.widthPct ?? 0, duration: play.durationSec };
  }
  return { asset: play.asset, side: (play.side as Side) ?? 'up', multiplier: play.multiplier ?? 0, duration: play.durationSec };
}

// Exact settlement price for the short window after the market settles but before this play's redeem/DB finalization completes.
// Before the chain sets settlement_price there's no result, so we return nothing instead of presenting the last live spot as a locked outcome.
async function lockPriceOf(play: Play): Promise<string | undefined> {
  if (play.status !== 'open') return undefined;
  if (Date.now() < Number(play.expiry)) return undefined;
  // Read the ExpiryMarket's frozen settlement_price (Mysten/Pyth settle it), null until frozen.
  const ms = await readMarketSettlement(play.oracleId).catch(() => null);
  if (!ms?.settled || ms.settlementPrice1e9 == null) return undefined;
  const px = Number(ms.settlementPrice1e9) / 1e9;
  return px > 0 ? String(px) : undefined;
}

// marketKey is a decimal order id, but plays from before the fork->real-Predict switch stored a JSON key there; parse defensively so listing old plays doesn't 500.
function parseOrderId(marketKey: string): bigint | null {
  if (!marketKey) return null;
  try {
    return BigInt(marketKey);
  } catch {
    return null;
  }
}

export async function toPlayDTO(play: Play, liveMark?: bigint): Promise<PlayDTO> {
  const settled = play.status !== 'open' && play.status !== 'pending';
  const markRaw = settled ? (play.payout ?? 0n) : (liveMark ?? play.markValue ?? play.entryCost);
  const pnlRaw = play.pnl ?? markRaw - play.entryCost;
  // Max payout = position quantity ($1 each at settle), decoded from the order id (empty until mint lands).
  // Legacy plays stored a JSON key in this column instead of a decimal order id, so guard the parse and fall back to stake for those.
  const realOrderId = parseOrderId(play.marketKey);
  const maxPayoutRaw = realOrderId != null ? decodeOrderId(realOrderId).quantityRaw : play.stake;

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
    maxPayout: money(maxPayoutRaw),
    payout: play.payout != null ? money(play.payout) : undefined,
    entrySpot: play.entrySpot ?? undefined,
    settlePrice: play.settlePrice ?? undefined,
    lockPrice: await lockPriceOf(play),
    openedAt: play.openedAt?.toISOString(),
    settledAt: play.settledAt?.toISOString(),
    txMint: play.txMint ?? undefined,
    txRedeem: play.txRedeem ?? undefined,
    txSettle: play.txSettle ?? undefined,
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
  // Past the buzzer the mark is moot (about to become the payout), so skip the ~1.5s devInspect; the client watchdog just needs the status to flip. Mirrors the SSE.
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
