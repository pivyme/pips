// The play lifecycle: create (mint), cash out (redeem), and expiry settle. The user's chips live
// in their PredictManager's BalanceManager: mint debits it, redeem credits it, so a play funds
// the manager up to the stake, then mints. Both modes finalize server-side: dev signs as the
// operator; privy signs with the user's embedded wallet via a session signer. No client round
// trip, no sponsor envelope.

import { Transaction } from '@mysten/sui/transactions';
import { coinWithBalance } from '@mysten/sui/transactions';

import type { Play, Prisma, User } from '../../prisma/generated/client.js';
import { prismaQuery } from '../lib/prisma.ts';
import { publishPlay } from '../lib/play-bus.ts';
import { SETTLE_MAX_REDEEMS_PER_TICK, LIVE_MARK_TTL_MS, IS_REAL_PREDICT } from '../config/main-config.ts';
import { DUSDC_TYPE, fromDusdcRaw, multiplier as multiplierOf, usd1e9 } from '../lib/sui/config.ts';
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
  findRedeemOnChain,
  getManagerBalanceRaw,
  mintEventAmounts,
  previewExecutableRedeem,
  readOracle,
  redeemEventAmounts,
  type BinaryParams,
  type OracleState,
  type RangeParams,
} from '../lib/sui/predict.ts';
import { getMarket, removeMarket } from '../lib/sui/markets.ts';
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
import { operatorCaps } from '../lib/sui/signer.ts';
import { rakeOf, appendForkRake, revenueAddress } from '../lib/sui/house.ts';
import { isOperatorLeader } from '../lib/leader-lock.ts';
import { alert } from '../lib/alert.ts';
import { checkPlayAllowed, recordPlay, clearPlay } from '../lib/sui/play-safety.ts';
import { gameSpot } from '../lib/game-price.ts';
import { executeForUser, executeAsOperator, executeAsSettlement, executeRealSettle, userContext } from '../lib/sui/execute.ts';
import {
  resolveLucky,
  resolveMoonshot,
  resolveRange,
  resolveReal,
  restrikeBinary,
  parseStake,
  PlayError,
  type PlayErrorCode,
  type Resolved,
  type ResolvedReal,
} from './games.ts';
import { recordSettlement } from './stats.ts';
import { evaluateAndUnlock } from './achievements.ts';
import type { Game, PlayDTO, PlayStatus, Side } from '../types/api.ts';

// Bright-yellow round-lifecycle console line (open + settle): time, price, game, asset, side/band.
// These are the two moments the player feels, so surfacing them makes a stuck settle obvious at a
// glance, the SETTLE line prints how long after expiry it actually landed.
const px1e9 = (v: bigint): string => (Number(v) / 1e9).toFixed(2);
const hhmmss = (): string => new Date().toTimeString().slice(0, 8);
const roundLog = (msg: string): void => console.log(`\x1b[33m${msg}\x1b[0m`);

// Commit a play-row update, THEN notify the play bus. The single choke point for every status-changing
// write, so the event-driven SSE push (TRADE_REALTIME.md) is never missed. Emit strictly AFTER commit,
// never before: a pre-commit emit makes the SSE re-read a stale row and push the old status. Returns the
// updated row for callers that need it (e.g. finalizeCashout). Non-status market-field re-route updates
// stay on the raw client, they never flip status so there is nothing to push.
async function commitPlay(playId: string, data: Prisma.PlayUpdateInput): Promise<Play> {
  const updated = await prismaQuery.play.update({ where: { id: playId }, data });
  publishPlay(playId);
  return updated;
}

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
  | { game: 'range'; stake: string | number; asset: string; widthPct: number }
  | { game: 'moonshot'; stake: string | number; asset: string; side: Side; reach: number };

export type CreateResult = { play: PlayDTO };

// What executeForUser needs to sign for this user (dev = operator, privy = embedded wallet, wallet =
// the server-held custodial wallet). One shared builder so every signing path stays consistent.
const userCtx = userContext;

// netRaw is the stake minus the house rake: the position is sized off net, while the full stake still
// funds the manager (so the rake can be peeled out after the mint). At rake = 0, netRaw === stakeRaw.
async function resolveByGame(input: CreatePlayInput, netRaw: bigint): Promise<Resolved> {
  if (input.game === 'lucky') return resolveLucky(netRaw);
  if (input.game === 'moonshot') return resolveMoonshot(netRaw, input.asset, input.side, input.reach);
  return resolveRange(netRaw, input.asset, input.widthPct);
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
      () => { },
      () => { },
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
  // Real-mode safety gate (no-op in fork mode): refuse when the gas sponsor is paused (reserve below
  // floor) with a clear code, and rate-limit per user so finite testnet gas isn't burned by a spammer.
  const block = checkPlayAllowed(user.id);
  if (block) throw new PlayError(block.code, block.message);
  recordPlay(user.id); // reserve the cooldown slot so a double-tap can't slip two plays past the gate

  try {
    const stakeRaw = parseStake(input.stake);
    // Fast affordability gate: reject only when a FRESH cached total is confidently short, so the hot
    // path takes no ~1.5s balance devInspect. Anything else proceeds; the background mint reads the
    // real balance and is the source of truth (a wrong guess there just re-racks, gracefully).
    const cached = balCache.get(user.id);
    if (cached && Date.now() - cached.at < BAL_TTL_MS && cached.total < stakeRaw) {
      throw new PlayError('INSUFFICIENT_DUSDC', 'Not enough chips for that bet');
    }
    return IS_REAL_PREDICT ? await createPlayReal(user, input, stakeRaw) : await createPlayFork(user, input, stakeRaw);
  } catch (e) {
    clearPlay(user.id); // the play never landed (bad params / no market); don't hold the cooldown
    throw e;
  }
}

// Fork path (localnet/devnet): per-user PredictManager, direct-coin mint via predict.ts, unchanged.
async function createPlayFork(user: User, input: CreatePlayInput, stakeRaw: bigint): Promise<CreateResult> {
  if (!user.predictManagerId) throw new PlayError('MANAGER_NOT_READY', 'Your account is still getting ready');
  // Split the stake into net + house rake (house.ts). Size the position off net; keep the full stake on
  // the Play row and as the funding target so the rake can be peeled out in the mint PTB. rake = 0 unless
  // a revenue wallet is configured, in which case this is byte-identical to the pre-rake path.
  const { rake, net } = rakeOf(stakeRaw);
  // Resolve + price the deal off the live oracle (honest multiplier). The player waits only on this.
  const resolved = await resolveByGame(input, net);
  const play = await prismaQuery.play.create({ data: mapResolvedToPlay(user.id, resolved, stakeRaw, rake) });
  // Mint behind the spin animation; mintPending never throws (it marks the play 'error' on failure).
  void withUserLock(user.id, () => mintPending(user, resolved, stakeRaw, rake, play.id, input));
  return { play: await toPlayDTO(play) };
}

// Real path (testnet, Mysten Predict): per-owner AccountWrapper, the internal-balance deposit->mint
// dance in one sponsored PTB. Same optimistic shape as the fork: resolve the deal (the only thing the
// player waits on), persist it 'pending' with the market id in oracleId, return so the reel snaps, then
// mint in the background (mintPendingReal fills in the order id + the REAL minted multiplier).
async function createPlayReal(user: User, input: CreatePlayInput, stakeRaw: bigint): Promise<CreateResult> {
  // Same net/stake split as the fork: mint budget sized off net, wrapper funded to the full stake so the
  // rake withdraws cleanly after the mint (predict-real buildMintPlay). rake = 0 unless a wallet is set.
  const { rake, net } = rakeOf(stakeRaw);
  const resolved = await resolveReal(input, net, stakeRaw);
  const play = await prismaQuery.play.create({ data: mapRealResolvedToPlay(user.id, resolved, stakeRaw, rake) });
  void withUserLock(user.id, () => mintPendingReal(user, resolved, stakeRaw, rake, play.id, input));
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

// Deposit sizing for a real-mode mint (the wrapper's internal-balance analog of the fork's fundManager).
// A single play draws the mint amount + the rake, always < stake (the fee headroom lives inside amountRaw,
// which bounds the mint cost), so a wrapper already holding a full stake covers this play with margin:
// deposit nothing. When it's short, top to BULK_FUND_PLAYS worth of stake (capped at the player's chips)
// so the next several spins mint deposit-free, a deposit forces a DUSDC coin read in tx.build and a bigger
// PTB. Never deposits more than the wallet holds: the affordability gate already ensured wallet + wrapper
// >= stake, and the draw <= stake, so a topped wrapper always covers it.
function realDeposit(stakeRaw: bigint, wrapperBal: bigint, wallet: bigint): bigint {
  if (wrapperBal >= stakeRaw) return 0n; // a full stake already sits in the wrapper: deposit-free
  const total = wrapperBal + wallet;
  const bulk = stakeRaw * BULK_FUND_PLAYS;
  const target = bulk < total ? bulk : total; // never target more than the player's chips
  const deposit = target - wrapperBal; // <= wallet since target <= total
  return deposit > 0n ? deposit : 0n;
}

// Background mint for an already-resolved, already-persisted pending play. Runs under the per-user
// lock so a user's owned deposit coins never equivocate. Retries the SAME dealt params on a transient
// race (a coin version still settling, a momentary tight price) and NEVER re-deals a result already
// shown; a dead oracle or a real failure marks the play 'error' so the player re-racks. Chips are
// safe either way: the fund+mint is one atomic PTB, so a failed mint debits nothing. Resolves quietly.
async function mintPending(user: User, resolved: Resolved, stakeRaw: bigint, rakeRaw: bigint, playId: string, input: CreatePlayInput): Promise<void> {
  const managerId = user.predictManagerId!;
  const net = stakeRaw - rakeRaw; // the sizing stake a re-route must re-price against (== stake at rake 0)
  try {
    const balances = await loadBalances(user);
    if (balances.total < stakeRaw) {
      await commitPlay(playId, { status: 'error' });
      return;
    }
    // Funding is sized off the FULL stake (net position + rake), unchanged by a re-route, and a failed
    // mint reverts atomically so nothing moves. Funding to stake (not net) leaves the manager holding
    // >= rake after the mint consumes ~net, so appendForkRake can always peel the rake out.
    const { cappedNeed, refillTo } = fundingPlan(stakeRaw, balances.total);

    const MAX_ATTEMPTS = 3;
    let cur = resolved;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const tx = new Transaction();
      fundManager(tx, managerId, cappedNeed, refillTo, balances.manager);
      if (cur.kind === 'binary') buildMint(tx, managerId, cur.params);
      else buildMintRange(tx, managerId, cur.params);
      // House rake: peel it out of the manager and send it to the revenue wallet, in the same atomic PTB
      // as the mint (no-op at rake 0). A reverted mint moves nothing, so chips stay safe (house.ts).
      appendForkRake(tx, managerId, rakeRaw);
      try {
        const exec = await executeForUser(tx, userCtx(user));
        const receipt = mintEventAmounts(exec.events, cur.kind);
        if (
          receipt.managerId !== managerId ||
          receipt.oracleId !== cur.params.oracleId ||
          receipt.quantity !== cur.params.quantity
        ) {
          console.error(`[plays] mint receipt identity mismatch for ${playId}`);
        }
        const actualMultiplier = multiplierOf(receipt.cost, receipt.quantity);
        roundLog(
          `[Round OPEN]   ${cur.game.padEnd(5)} ${cur.asset.padEnd(4)} ` +
          (cur.kind === 'binary'
            ? `${cur.side.toUpperCase().padEnd(4)} strike=${px1e9(cur.params.strike1e9)}`
            : `band=(${px1e9(cur.params.lower1e9)}, ${px1e9(cur.params.higher1e9)}]`) +
          `  x${actualMultiplier.toFixed(2)}  entry=$${Number(cur.entrySpot).toFixed(2)}` +
          `  expires in ${Math.max(0, Math.round((cur.market.expiryMs - Date.now()) / 1000))}s` +
          `  @${hhmmss()}  tx=${exec.digest.slice(0, 8)}`,
        );
        await commitPlay(playId, {
          status: 'open',
          txMint: exec.digest,
          // All-in cost the player actually paid = on-chain mint cost + the rake that left to revenue.
          // Byte-identical to receipt.cost at rake 0. Keeps the PnL ledger honest (stats.ts).
          entryCost: receipt.cost + rakeRaw,
          multiplier: actualMultiplier,
          openedAt: new Date(),
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
          const next = await reResolve(input, net, cur).catch(() => null);
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
    await commitPlay(playId, { status: 'error' }).catch(() => { });
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

function mapResolvedToPlay(userId: string, r: Resolved, stakeRaw: bigint, rakeRaw: bigint) {
  const seed = r.kind === 'binary' ? { rngSeed: r.seed } : {};
  // Provisional all-in cost = the previewed mint cost + the rake the player pays; snapped to the real
  // receipt cost + rake once the mint lands (mintPending). At rake = 0 this equals marketFieldsOf's cost.
  return { userId, game: r.game, status: 'pending', stake: stakeRaw, ...seed, ...marketFieldsOf(r), entryCost: r.entryCost + rakeRaw };
}

// === Real-mode create / mint (IS_REAL_PREDICT) ===
//
// Same optimistic shape as the fork mint but against the real protocol: resolve to ticks + a premium
// budget, then in the background ensure the wrapper, deposit the shortfall, and mint in ONE sponsored
// PTB. The order id (settle's key) and the REAL minted multiplier are only known post-mint, so the
// pending play carries a placeholder (order id '', reel-tier multiplier) that mintPendingReal fills in.

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

// A fresh real resolve on a live market for the same bet, to re-route a mint whose market expired
// mid-flight. Lucky keeps its seed (the reels already snapped to the dealt draw); null if none is live.
async function reResolveReal(input: CreatePlayInput, netRaw: bigint, stakeRaw: bigint, prev: ResolvedReal): Promise<ResolvedReal | null> {
  try {
    return await resolveReal(input, netRaw, stakeRaw, prev.game === 'lucky' ? prev.seed : undefined);
  } catch {
    return null;
  }
}

// The market expired/settled or paused mid mint/redeem: the live pricer can't load or the mint isn't
// allowed. Re-route (mint) / lock-in (cash-out) rather than retry the dead market.
const isRealMarketGone = (e: unknown): boolean =>
  /assert_live_mint|assert_quoteable|EMarket|EOracle|expired|settled|mint_paused|not live|load_live_pricer/i.test(
    e instanceof Error ? e.message : String(e),
  );

// The cached wrapper id is stale (a devnet wipe deleted the shared object): the mint aborts on a
// missing input object. Only meaningful when a cache exists; a first play derives + creates fresh.
const isWrapperGone = (e: unknown): boolean =>
  /not found|does not exist|no such object|deleted|notexist/i.test(e instanceof Error ? e.message : String(e));

// A leverage/probability/premium admission abort from strike_exposure_config (LUCKY.md §5b): the
// requested leverage exceeds the tier's probability-gated cap, the strike's probability is out of
// bounds, the net premium is below $1, or the position would open below the liquidation threshold. The
// fallback drops leverage to 1x (the closest achievable tier) and retries the same strike.
const isAdmissionAbort = (e: unknown): boolean =>
  /strike_exposure_config|ELeverageAboveAdmission|EInvalidLeverage|EEntryProbabilityOutOfBounds|ENetPremiumBelowMinimum|EOrderBelowLiquidationThreshold/i.test(
    e instanceof Error ? e.message : String(e),
  );

async function mintPendingReal(user: User, resolved: ResolvedReal, stakeRaw: bigint, rakeRaw: bigint, playId: string, input: CreatePlayInput): Promise<void> {
  let cur = resolved;
  const net = stakeRaw - rakeRaw; // sizing stake a re-route re-prices against (== stake at rake 0)
  let acct = user; // may lose a stale wrapper-id cache mid-flight (self-heal)
  try {
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const w = await resolveWrapper(acct.address, acct.predictWrapperId);
      // mint draws from the wrapper's internal balance, so total spendable = wallet + internal chips.
      // Read the two independent balances in parallel (the wrapper read is a devInspect), like the fork's
      // loadBalances, instead of one after the other.
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
      // Bulk-fund the wrapper so most spins mint with no deposit (smaller PTB, tx.build skips the coin
      // read): top it in bulk when short, draw from the internal balance when it already holds a stake.
      const depositRaw = realDeposit(stakeRaw, wrapperBal, wallet);

      const tx = new Transaction();
      buildMintPlay(tx, {
        marketId: cur.marketId,
        wrapperId: w.wrapperId,
        wrapperExists: w.exists,
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
        // Requested leverage exceeds the tier's (unreadable pre-mint) probability-gated admission cap,
        // or the strike/premium lands outside the admission band (LUCKY.md §5b). Drop to leverage 1;
        // for a binary (LUCKY/MOONSHOT) also RE-PRICE the strike for that leverage (strikeTier=tier/1),
        // since the original strike was only ever priced assuming the rejected, higher leverage, so
        // leaving it in place would land far short of the nominal tier instead of the closest
        // achievable one. RANGE keeps its band as-is (its width never depended on leverage). If already
        // at 1x it's a genuinely unmintable strike/band, so let it fall through to error (chips safe),
        // never loop a doomed mint.
        if (isAdmissionAbort(e) && cur.leverage1e9 > LEVERAGE_ONE) {
          cur = cur.kind === 'binary' ? restrikeBinary(cur, LEVERAGE_ONE) : { ...cur, leverage1e9: LEVERAGE_ONE };
          await prismaQuery.play
            .update({ where: { id: playId }, data: cur.kind === 'binary' ? { leverage: 1, strike: cur.strikeDisplay } : { leverage: 1 } })
            .catch(() => {});
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

// A fresh resolve on a NEW oracle for the same bet, used to re-route a mint whose routed oracle
// expired mid-flight. Lucky reuses the original seed so the dealt asset/side/tier (already on the
// reels) stay identical; range re-derives from the same asset + band width. The strike/quantity/
// multiplier re-price against the new oracle, which is honest (the closest mintable to the deal).
function reResolve(input: CreatePlayInput, netRaw: bigint, prev: Resolved): Promise<Resolved> {
  if (input.game === 'lucky') return resolveLucky(netRaw, prev.kind === 'binary' ? prev.seed : undefined);
  if (input.game === 'moonshot') return resolveMoonshot(netRaw, input.asset, input.side, input.reach);
  return resolveRange(netRaw, input.asset, input.widthPct);
}

// === Cash out (redeem at the live mark) ===

export type CashoutResult = { play: PlayDTO; unlocked: string[] };

export function cashoutPlay(user: User, playId: string): Promise<CashoutResult> {
  return withUserLock(user.id, () => (IS_REAL_PREDICT ? cashoutRealLocked(user, playId) : cashoutPlayLocked(user, playId)));
}

// Real-mode live cash-out: redeem_live (owner-authed, mark-to-market) closes the full position; the
// payout is credited into the wrapper's internal balance (the user's chips), same as the fork keeps it
// in the manager. The close quantity is decoded from the packed order id, so no extra column.
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
    // Buzzer beat the cash-out: past expiry the market is no longer quoteable for a live sell, so the
    // position settles to its win/loss. Surface that plainly; the settle worker finalizes it shortly.
    if (isOracleExpiredAbort(e) || isRealMarketGone(e)) throw new PlayError('PLAY_NOT_OPEN', 'Round is settling, your result is locking in');
    throw asPlayError(e, 'REDEEM_FAILED', 'Could not cash out right now. Try again.');
  }
}

async function cashoutPlayLocked(user: User, playId: string): Promise<CashoutResult> {
  const play = await prismaQuery.play.findFirst({ where: { id: playId, userId: user.id } });
  if (!play) throw new PlayError('PLAY_NOT_OPEN', 'Play not found');
  if (play.status !== 'open') throw new PlayError('PLAY_NOT_OPEN', 'This play is not open');
  const managerId = user.predictManagerId;
  if (!managerId) throw new PlayError('MANAGER_NOT_READY', 'Your account is still getting ready');

  const key = deserializeKey(play);
  const tx = new Transaction();
  if (key.kind === 'binary') buildRedeem(tx, managerId, key.params);
  else buildRedeemRange(tx, managerId, key.params);

  try {
    const exec = await executeForUser(tx, userCtx(user));
    const receipt = redeemEventAmounts(exec.events, key.kind);
    if (
      receipt.managerId !== managerId ||
      receipt.oracleId !== play.oracleId ||
      receipt.quantity !== key.params.quantity
    ) {
      console.error(`[plays] redeem receipt identity mismatch for ${play.id}`);
    }
    return finalizeCashout(play, receipt.payout, exec.digest);
  } catch (e) {
    // The buzzer beat the cash-out: once the round crosses expiry the oracle is no longer quoteable
    // (assert_quoteable_oracle aborts EOracleExpired), so the live sell is gone and the position will
    // settle to its win/loss. Surface that plainly instead of a retryable error, the settle worker
    // finalizes it shortly. Any other failure stays a generic retryable redeem error.
    if (isOracleExpiredAbort(e)) throw new PlayError('PLAY_NOT_OPEN', 'Round is settling, your result is locking in');
    throw asPlayError(e, 'REDEEM_FAILED', 'Could not cash out right now. Try again.');
  }
}

// A redeem that lost the race to the buzzer: the oracle crossed expiry into the unsettled gap, so it
// is no longer quoteable for a live cash-out (oracle_config::assert_quoteable_oracle / EOracleExpired)
// or it already settled. Either way the round is over and will resolve via settlement, not a re-try.
const isOracleExpiredAbort = (e: unknown): boolean => {
  const m = e instanceof Error ? e.message : String(e);
  return /assert_quoteable_oracle|EOracleExpired|EOracleSettled/i.test(m);
};

// A redeem against a manager that no longer holds the position. decrease_position (binary) and
// decrease_range (range) are the only callers of EInsufficientPosition/EInsufficientRangePosition,
// and both abort only when the position quantity isn't there, i.e. it was already redeemed (almost
// always a cash-out whose DB write was lost). This is terminal, never a transient retry.
const isAlreadyRedeemedAbort = (e: unknown): boolean => {
  const m = e instanceof Error ? e.message : String(e);
  return /decrease_position|decrease_range/.test(m);
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
  const stuck = await prismaQuery.play.findMany({
    where: { status: 'pending', createdAt: { lt: new Date(Date.now() - STUCK_PENDING_MS) } },
    select: { id: true },
  });
  if (stuck.length === 0) return;
  const ids = stuck.map((p) => p.id);
  const res = await prismaQuery.play.updateMany({ where: { id: { in: ids }, status: 'pending' }, data: { status: 'error' } });
  // Push the error to any SSE still holding one of these pending plays (a client mid-connect on a mint
  // whose process died) so it resolves at once instead of waiting out the watchdog.
  for (const id of ids) publishPlay(id);
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

// The price our settlement transaction will freeze: the oracle's last on-chain spot, pushed before
// expiry. It is recorded on-chain but is not a settlement result until update_prices runs after
// expiry. Using that recorded spot makes settlement independent of worker delay. Falls back to the
// live feed only if the oracle somehow never recorded a spot.
async function settleSpotUsd(asset: string, lastSpot1e9: bigint): Promise<number | null> {
  const last = Number(lastSpot1e9) / 1e9;
  if (last > 0) return last;
  const fresh = await gameSpot(asset).catch(() => null);
  return fresh && fresh.price > 0 ? fresh.price : null;
}

// Drive a batch of expired-unsettled oracles to settlement in ONE operator tx: a post-expiry price
// push freezes each one's settlement price on-chain (oracle.move update_prices). Batching collapses
// what would be N serial operator round trips (the dominant settle cost when several rounds expire
// together) into a single tx. The frozen price IS the value pushed, so the settled state is updated
// in place with no re-read. Returns true on success (marks the states settled, retires them from the
// cache); false if the tx reverts, so the caller can isolate a bad oracle and retry the rest.
// Settle operator txs (the oracle nudge + the redeem) are background and latency-tolerant, so they
// ride a more patient stale-object retry than a user mint: when another signer shares the operator
// key (the deployed backend operating the same node), the gas coin's version churns and a few quick
// retries lose. Extra patient attempts straddle the other signer's bursts so the settle lands this
// tick instead of spilling noise and deferring to the next one.
const SETTLE_STALE_RETRIES = 12;

// An oracle's read state plus the settle-nudge tx digest that froze its settlement price (when this
// process is the one that pushed it). Carried so each settled play can record which tx set the price
// it resolved against, for the history explorer link. Undefined when a co-operator/leader settled it.
type SettleState = OracleState & { settleTx?: string };

// After a failed nudge, reconcile against the chain. A push aborts EOracleSettled (oracle.move abort
// code 6) precisely when the oracle is ALREADY settled, which is the state the nudge wanted: a
// co-operator beat us to it, or our own earlier nudge timed out on the wait yet actually landed. So
// re-read each oracle; any that now reads settled is a SUCCESS, marked here with the chain's frozen
// settlement price (the real value, which may differ from what we were about to push) so Phase 2
// resolves its play THIS tick. Returns true iff every oracle in the batch is now settled.
async function reconcileSettled(items: Array<{ st: OracleState; cap: string; spotUsd: number }>, states: Map<string, SettleState | null>): Promise<boolean> {
  const fresh = await Promise.all(items.map((it) => readOracle(it.st.oracleId).catch(() => null)));
  let allSettled = true;
  for (let i = 0; i < items.length; i++) {
    const o = fresh[i];
    if (o?.settled && o.settlementPrice1e9 != null) {
      removeMarket(items[i].st.oracleId);
      states.set(items[i].st.oracleId, o);
    } else {
      allSettled = false;
    }
  }
  return allSettled;
}

async function settleOracles(items: Array<{ st: OracleState; cap: string; spotUsd: number }>, states: Map<string, SettleState | null>): Promise<boolean> {
  if (items.length === 0) return true;
  try {
    const tx = new Transaction();
    for (const it of items) appendPriceUpdate(tx, it.st.oracleId, it.cap, it.spotUsd);
    const { digest } = await executeAsOperator(tx, `settle-nudge x${items.length}`, { retries: SETTLE_STALE_RETRIES, freshFirst: true });
    for (const it of items) {
      removeMarket(it.st.oracleId);
      states.set(it.st.oracleId, { ...it.st, settled: true, active: false, settlementPrice1e9: usd1e9(it.spotUsd), settleTx: digest });
    }
    return true;
  } catch (e) {
    // A nudge most often fails because the oracle is ALREADY settled (a co-operator beat us, or our
    // own timed-out nudge actually landed): that is the end state we wanted, not an error. Reconcile
    // against the chain and treat any now-settled oracle as done. Only an oracle that is still
    // genuinely unsettled is a real failure worth logging and retrying.
    if (await reconcileSettled(items, states)) return true;
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

  const states = new Map<string, SettleState | null>();
  await Promise.all(
    [...byOracle.keys()].map(async (id) => {
      try {
        states.set(id, await readOracle(id));
      } catch {
        states.set(id, null);
      }
    }),
  );

  // Phase 1: freeze settlement on every expired-unsettled oracle in one batched nudge. Per the Predict
  // oracle model, settlement is NOT automatic: an authorized cap must push a post-expiry price via
  // update_prices, which freezes the settlement price (PENDING_SETTLEMENT -> SETTLED). Until then the
  // oracle is not quoteable, so a redeem aborts (EOracleExpired).
  //
  // This phase is OPERATOR-ONLY. The nudge needs an oracle cap and only the leader should drive it. A
  // follower shares the operator key (so it technically owns the caps and WOULD pass resolveOracleCap),
  // but it is not the leader: a second writer racing the leader on the same oracle just makes the
  // loser's push abort EOracleSettled (abort code 6) and churns the one shared gas coin, which is the
  // storm in the logs. A follower instead lets the leader settle the oracle on the shared chain and
  // finalizes its own DB's plays in Phase 2. (The price-pusher and oracle-roll workers gate on the same
  // operator leader lock; settle runs in both modes because a follower still needs Phase 2/3. Gating on
  // isOperatorLeader() not OPERATOR_ENABLED means a lock-losing operator also stops nudging, so two
  // misconfigured operators can never both race the same oracle.)
  const now = Date.now();
  if (isOperatorLeader()) {
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
      // The batch reverted (e.g. one oracle settled out from under it): isolate so one bad oracle can't
      // block the rest. Skip any the batch reconcile already marked settled, so we don't re-nudge it.
      for (const it of toNudge) {
        if (states.get(it.st.oracleId)?.settled) continue;
        await settleOracles([it], states);
      }
    }
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
        await settleOnePlay(play, st.settlementPrice1e9, st.settleTx);
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
    for (const id of giveUp) publishPlay(id); // push the terminal error to any SSE still watching
    if (res.count > 0) {
      console.log(`[Settle] gave up on ${res.count} unsettleable play(s)`);
      // Real positions we genuinely cannot settle (dead deployment / wiped chain), flipped to error.
      // Recovery is unchanged; this only surfaces it, since a batch here means user funds are stuck.
      alert('critical', `settle gave up on ${res.count} unsettleable play(s) (dead oracle / wiped chain)`);
    }
  }
}

async function settleOnePlay(play: Play, settlement1e9: bigint, settleTx?: string): Promise<void> {
  const key = deserializeKey(play);
  const itm = isItm(key, settlement1e9);

  // The settlement decision. DOWN wins iff settlement <= strike; UP iff settlement > strike. The lag
  // is how long after expiry the round actually settled, a big number here is the stuck-settle symptom.
  const lagS = Math.round((Date.now() - Number(play.expiry)) / 1000);
  roundLog(
    `[Round SETTLE] ${play.game.padEnd(5)} ${play.asset.padEnd(4)} ` +
    (key.kind === 'binary'
      ? `${(key.params.side as string).toUpperCase().padEnd(4)} strike=${px1e9(key.params.strike1e9)}`
      : `band=(${px1e9(key.params.lower1e9)}, ${px1e9(key.params.higher1e9)}]`) +
    `  settle=$${px1e9(settlement1e9)}  ${itm ? 'WIN ' : 'LOSS'}  (expired ${lagS}s ago)  @${hhmmss()}`,
  );

  // An in-the-money settle sweeps the $1/contract payout into the user's manager. Both legs use a
  // permissionless redeem (no owner check once settled), so the operator finalizes the win in
  // either auth mode. Mark the play won ONLY after that redeem confirms on-chain, so the record
  // never claims a payout the chain did not move; a failed redeem leaves the play open to retry on
  // the next settle tick. A losing play has nothing to redeem, so it settles immediately.
  let digest: string | undefined;
  let payoutRaw = 0n;
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
      // Permissionless redeem signs with the dedicated settlement wallet (its own gas coin), so a slow
      // redeem can't head-of-line block the operator's price-push/nudge lane. Falls back to the operator
      // wallet when no settlement wallet is configured.
      const exec = await executeAsSettlement(tx, `settle-redeem ${play.id}`, {
        retries: SETTLE_STALE_RETRIES,
        freshFirst: true,
      });
      const receipt = redeemEventAmounts(exec.events, key.kind);
      if (
        !receipt.settled ||
        receipt.managerId !== user.predictManagerId ||
        receipt.oracleId !== play.oracleId ||
        receipt.quantity !== key.params.quantity
      ) {
        console.error(`[Settle] receipt identity mismatch for ${play.id}`);
      }
      digest = exec.digest;
      payoutRaw = receipt.payout;
    } catch (e) {
      // The position is already gone from the manager (decrease_position/decrease_range aborts on an
      // empty quantity): this play was cashed out before expiry but its DB write was lost, so it sat
      // 'open' while the chips already moved on-chain. Retrying the redeem can NEVER succeed, so we
      // reconcile from the chain's own redeem record instead of looping forever.
      if (isAlreadyRedeemedAbort(e)) {
        await reconcileAlreadyRedeemed(play, key, settlement1e9);
        return;
      }
      console.error(`[Settle] on-chain redeem failed for ${play.id}, will retry:`, e instanceof Error ? e.message : e);
      return; // leave status 'open' so the next settle tick retries the redeem
    }
  }

  // The redeem event is the exact amount credited on-chain. A loss has no redeem transaction and
  // therefore a zero payout.
  if (itm && digest == null) return;
  const pnl = payoutRaw - play.entryCost;
  await commitPlay(play.id, {
    status: itm ? 'won' : 'lost',
    payout: payoutRaw,
    markValue: payoutRaw,
    pnl,
    // The frozen settlement price (display): what the round actually settled at, for debug/audit.
    settlePrice: String(Number(settlement1e9) / 1e9),
    txRedeem: digest ?? play.txRedeem,
    // The post-expiry price push that froze the settlement price, for the history explorer link.
    txSettle: settleTx ?? play.txSettle,
    settledAt: new Date(),
  });
  if (itm) invalidateBal(play.userId); // the settle redeem credited the manager; the next gate re-reads
  await recordSettlement(play.userId);
  await evaluateAndUnlock(play.userId);
}

// Reconcile a play whose position is already gone (the settle redeem aborted EInsufficientPosition).
// The chips already moved on-chain in an earlier redeem whose DB write was lost, so we pull that exact
// redeem off the chain and record its true payout. is_settled tells us whether it was a live cash-out
// (pre-expiry, status 'cashed_out') or a settled win ('won'); either way the payout the chain actually
// paid is the truth, so we never invent money. If we can't find the redeem at all (the position never
// existed in this manager, e.g. a stale manager from a re-provision), we mark the play 'error' so it
// stops looping: 'error' is excluded from the PnL ledger, so it records neither a phantom win nor a
// fake loss.
async function reconcileAlreadyRedeemed(play: Play, key: PlayKey, settlement1e9: bigint): Promise<void> {
  const user = await prismaQuery.user.findUnique({ where: { id: play.userId }, select: { predictManagerId: true } });
  const onChain = user?.predictManagerId ? await findRedeemOnChain(user.predictManagerId, key).catch(() => null) : null;

  if (!onChain) {
    await commitPlay(play.id, { status: 'error', settledAt: new Date() });
    console.warn(`[Settle] ${play.id} position is gone but no on-chain redeem found; marked error (no double-pay)`);
    return;
  }

  const pnl = onChain.payout - play.entryCost;
  const status: PlayStatus = onChain.settled ? 'won' : 'cashed_out';
  await commitPlay(play.id, {
    status,
    payout: onChain.payout,
    markValue: onChain.payout,
    pnl,
    settlePrice: onChain.settled ? String(Number(settlement1e9) / 1e9) : null,
    txRedeem: onChain.digest,
    settledAt: new Date(),
  });
  invalidateBal(play.userId);
  await recordSettlement(play.userId);
  await evaluateAndUnlock(play.userId);
  console.log(`\x1b[33m[Settle] reconciled ${play.id}: already ${status} on-chain, payout=$${fromDusdcRaw(onChain.payout).toFixed(2)} (recovered lost write)\x1b[0m`);
}

// === Real-mode settlement (IS_REAL_PREDICT, worker: settleDuePlaysReal) ===
//
// Mysten's testnet Predict settles a market from Pyth-at-expiry, not from a price we push, so real mode
// has no operator nudge. We resolve each open real play by calling redeem_settled (permissionless,
// full-close): that call drives ensure_settled (settling the market if a Pyth exact-at-expiry price
// exists) then pays $1*qty or 0 into the user's wrapper. Self-healing like the fork's settleDuePlays:
// it reads the chain, reconciles an already-closed position against its on-chain redeem event (a live
// cash-out or a prior settle whose DB write was lost), and gives up ONLY on a provably-stuck/gone
// market, never on elapsed time alone (lessons pips-settle-abort1/abort6). In real mode a play stores
// the ExpiryMarket id in `oracleId` and the u256 order id in `marketKey`; quantity is decoded from the
// order id (order.move packs it), so no extra column is needed.

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

// Write the resolved outcome for a real play. A settled win pays into the wrapper internal balance, so
// invalidate the balance gate; a loss/liquidation pays 0. Mirrors settleOnePlay's terminal write.
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

// Reconcile a real play whose redeem_settled failed. Order of evidence: (1) the position is already
// redeemed on chain (recover the true payout, never invent money), (2) the market is not settleable
// yet (retry next tick), (3) provably gone/stuck for far longer than any settle (give up -> error, kept
// out of the PnL ledger). Returns nothing; leaves the play 'open' when a later tick can still resolve it.
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
    // Real-mode give-up: a real testnet position we can't settle after the orphan window. Recovery
    // unchanged; alert so a human can look, since real chips are involved (L-008/L-011).
    alert('critical', 'real play unsettleable after orphan window, marked error', { playId: play.id, reason: unreadable ? 'market gone' : 'not settled' });
    return;
  }
  // Market not settled yet, or a transient tx failure: leave 'open' to retry on a later tick.
  console.error(`[Settle] real ${play.id} redeem_settled failed, will retry:`, err instanceof Error ? err.message : err);
}

// Settle one open real play. Returns true iff it spent a redeem tx (for the per-tick budget); a
// not-yet-settleable play returns false so it doesn't burn the budget.
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
    // Direct build-sign-submit (not the coin-caching serial executor): redeem_settled is all-shared-
    // input, so on testnet the resolver routinely pays gas from the settle wallet's address balance,
    // which the serial executor's post-exec gas-coin cache chokes on ("Gas object not found in
    // effects"). The direct path reads effects.status only, so a settled redeem resolves on this tick.
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

// Live cash-out value for an open play (the redeem bid). Settled/closed plays use the
// stored payout. The raw read is a ~1.5s devInspect on the remote node.
export async function getLiveMarkRaw(play: Play): Promise<bigint> {
  if (play.status !== 'open') return play.payout ?? play.markValue ?? 0n;
  // Real mode: the live P/L is chart-synced on the client (lesson pips-lucky-directional), and a
  // backend redeem_live devInspect needs a funded wrapper + a same-PTB pricer, so we don't poll a
  // server mark. Return the entry as a neutral mark; the client draws the live swing off the chart.
  if (IS_REAL_PREDICT) return play.markValue ?? play.entryCost;
  const key = deserializeKey(play);
  const user = await prismaQuery.user.findUnique({
    where: { id: play.userId },
    select: { address: true, predictManagerId: true },
  });
  if (!user?.predictManagerId) throw new Error(`Play ${play.id} has no PredictManager`);
  return previewExecutableRedeem(user.predictManagerId, user.address, key);
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

const money = (raw: bigint): string => fromDusdcRaw(raw).toFixed(2);

function paramsDTO(play: Play): PlayDTO['params'] {
  // 'tap' is retired; any legacy tap rows were stored range-style (lower/upper), so render them as range.
  if (play.game === 'range' || play.game === 'tap') {
    return { asset: play.asset, lower: play.lower ?? '', upper: play.upper ?? '', widthPct: play.widthPct ?? 0, duration: play.durationSec };
  }
  return { asset: play.asset, side: (play.side as Side) ?? 'up', multiplier: play.multiplier ?? 0, duration: play.durationSec };
}

// Exact settlement price for the short window after the oracle settlement transaction has landed but
// before this play's redeem/DB finalization completes. Before the chain sets `settlement_price` there
// is no result, so we return nothing instead of presenting the last live spot as a locked outcome.
async function lockPriceOf(play: Play): Promise<string | undefined> {
  if (play.status !== 'open') return undefined;
  if (Date.now() < Number(play.expiry)) return undefined;
  if (IS_REAL_PREDICT) {
    // Real mode: read the ExpiryMarket's frozen settlement_price (Mysten/Pyth settle it), null until frozen.
    const ms = await readMarketSettlement(play.oracleId).catch(() => null);
    if (!ms?.settled || ms.settlementPrice1e9 == null) return undefined;
    const px = Number(ms.settlementPrice1e9) / 1e9;
    return px > 0 ? String(px) : undefined;
  }
  const oracle = await readOracle(play.oracleId).catch(() => null);
  if (!oracle?.settled || oracle.settlementPrice1e9 == null) return undefined;
  const px = Number(oracle.settlementPrice1e9) / 1e9;
  return px > 0 ? String(px) : undefined;
}

// Real mode's marketKey is a decimal order id, but plays created before the fork->real-Predict switch
// stored a JSON fork key there instead. Parse defensively so listing old plays doesn't 500.
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
  // Max payout = the position quantity ($1 each at settle). Real mode packs it into the order id (empty
  // until the mint lands), so decode it there; fork mode reads it off the serialized redeem key.
  // Legacy plays created before the fork->real-Predict switch stored a JSON fork key in this column
  // (not a decimal order id), so guard the parse and fall back to stake for those.
  const realOrderId = IS_REAL_PREDICT ? parseOrderId(play.marketKey) : null;
  const maxPayoutRaw = IS_REAL_PREDICT
    ? realOrderId != null
      ? decodeOrderId(realOrderId).quantityRaw
      : play.stake
    : deserializeKey(play).params.quantity;

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
