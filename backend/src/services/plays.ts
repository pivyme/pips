// Play lifecycle: create (mint), cash out (redeem), expiry settle. Chips live in the user's
// PredictManager BalanceManager (mint debits, redeem credits); dev signs as operator, privy signs via the embedded wallet, no client round trip.

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

// Bright-yellow console line for the two round moments the player feels (open + settle); SETTLE
// prints how long after expiry it landed, so a stuck settle is obvious at a glance.
const px1e9 = (v: bigint): string => (Number(v) / 1e9).toFixed(2);
const hhmmss = (): string => new Date().toTimeString().slice(0, 8);
const roundLog = (msg: string): void => console.log(`\x1b[33m${msg}\x1b[0m`);

// Commit a play-row update, then notify the play bus, the single choke point for every status write
// so the SSE push is never missed. Emit strictly after commit: emitting before would push the SSE a stale row.
async function commitPlay(playId: string, data: Prisma.PlayUpdateInput): Promise<Play> {
  const updated = await prismaQuery.play.update({ where: { id: playId }, data });
  publishPlay(playId, updated); // hand the fresh row through so the SSE pushes it with no DB re-read
  return updated;
}

// === Redeem key descriptor (stored on Play.marketKey) ===
// Holds the exact 1e9 strikes + quantity so redeem reconstructs the on-chain key precisely, not from lossy display strings.

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

// Wallet DUSDC + manager balance, read in parallel; returns both so the mint can reuse the manager
// figure without a second read. Seeds the spendable-total cache for the next play's gate.
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

// Tops the manager from the wallet only when short, funding to `refillToRaw` (a bulk target so later spins skip the deposit) not just `needRaw`.
// Funds slightly above the bet so the mint, priced against the post-trade vault, can never overdraw; surplus stays as the user's chips.
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

// What executeForUser needs to sign for this user (dev = operator, privy = embedded wallet, wallet = custodial); one shared builder keeps every signing path consistent.
const userCtx = userContext;

// netRaw = stake minus house rake: position sizes off net, full stake still funds the manager so the rake can be peeled out post-mint (netRaw === stakeRaw at rake 0).
async function resolveByGame(input: CreatePlayInput, netRaw: bigint): Promise<Resolved> {
  if (input.game === 'lucky') return resolveLucky(netRaw);
  if (input.game === 'moonshot') return resolveMoonshot(netRaw, input.asset, input.side, input.reach);
  return resolveRange(netRaw, input.asset, input.widthPct);
}

// How far above the bet we fund the manager so the post-trade mint price (its own market impact) never overdraws it; surplus carries to the next play.
const FUND_BUFFER_PCT = 12n;

// Bulk-refill horizon: a deposit is the slow part of a spin (forces a coin read + bigger tx), so a short manager tops to this many bets' worth (capped at the player's chips) instead of just one.
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

// The routed oracle expired/settled during the mint; retrying the same oracle just aborts again, so this re-routes to a fresh one instead.
// Was the dominant cause of plays erroring after the reels snapped (mint outran a near-buzzer oracle).
const isOracleGone = (e: unknown): boolean => {
  const m = e instanceof Error ? e.message : String(e);
  return /assert_live_oracle|EOracleExpired|EOracleSettled|EOracleNotActive|interpolate_price|trade_prices/i.test(m);
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
  // Split stake into net + house rake (house.ts): position sizes off net, full stake stays the funding target so the rake peels out in the mint PTB.
  // rake = 0 unless a revenue wallet is configured (byte-identical to the pre-rake path then).
  const { rake, net } = rakeOf(stakeRaw);
  // Resolve + price the deal off the live oracle (honest multiplier). The player waits only on this.
  const resolved = await resolveByGame(input, net);
  const play = await prismaQuery.play.create({ data: mapResolvedToPlay(user.id, resolved, stakeRaw, rake) });
  // Mint behind the spin animation; mintPending never throws (it marks the play 'error' on failure).
  void withUserLock(user.id, () => mintPending(user, resolved, stakeRaw, rake, play.id, input));
  return { play: await toPlayDTO(play) };
}

// Real path (testnet): per-owner AccountWrapper, deposit->mint dance in one sponsored PTB. Same optimistic shape as the fork.
// Resolves the deal, persists 'pending' with the market id in oracleId, returns for the reel snap; mintPendingReal fills in the order id + real multiplier in the background.
async function createPlayReal(user: User, input: CreatePlayInput, stakeRaw: bigint): Promise<CreateResult> {
  // Same net/stake split as the fork: mint budget sized off net, wrapper funded to the full stake so the rake withdraws cleanly post-mint (rake = 0 unless a wallet is set).
  const { rake, net } = rakeOf(stakeRaw);
  const resolved = await resolveReal(input, net, stakeRaw);
  const play = await prismaQuery.play.create({ data: mapRealResolvedToPlay(user.id, resolved, stakeRaw, rake) });
  void withUserLock(user.id, () => mintPendingReal(user, resolved, stakeRaw, rake, play.id, input));
  return { play: await toPlayDTO(play) };
}

// Funding plan for one mint: tops a bit above the bet (FUND_BUFFER_PCT) so the post-trade mint price never overdraws.
// Tops in bulk (BULK_FUND_PLAYS) so later spins skip the deposit, capped at the player's chips.
function fundingPlan(stakeRaw: bigint, total: bigint): { cappedNeed: bigint; refillTo: bigint } {
  const need = stakeRaw + (stakeRaw * FUND_BUFFER_PCT) / 100n;
  const cappedNeed = need > total ? total : need;
  const bulk = stakeRaw * BULK_FUND_PLAYS;
  const refill = bulk > total ? total : bulk;
  return { cappedNeed, refillTo: refill < cappedNeed ? cappedNeed : refill };
}

// Deposit sizing for a real-mode mint (fundManager's internal-balance analog): a wrapper already holding a full stake needs no deposit, since the mint draw is always <= stake.
// Otherwise tops to BULK_FUND_PLAYS worth (capped at the player's chips) so later spins mint deposit-free.
function realDeposit(stakeRaw: bigint, wrapperBal: bigint, wallet: bigint): bigint {
  if (wrapperBal >= stakeRaw) return 0n; // a full stake already sits in the wrapper: deposit-free
  const total = wrapperBal + wallet;
  const bulk = stakeRaw * BULK_FUND_PLAYS;
  const target = bulk < total ? bulk : total; // never target more than the player's chips
  const deposit = target - wrapperBal; // <= wallet since target <= total
  return deposit > 0n ? deposit : 0n;
}

// Background mint for an already-persisted pending play, under the per-user lock. Retries the SAME dealt params on a transient race, never re-deals a shown result.
// A dead oracle or real failure marks the play 'error'; chips stay safe either way since fund+mint is one atomic PTB.
async function mintPending(user: User, resolved: Resolved, stakeRaw: bigint, rakeRaw: bigint, playId: string, input: CreatePlayInput): Promise<void> {
  const managerId = user.predictManagerId!;
  const net = stakeRaw - rakeRaw; // the sizing stake a re-route must re-price against (== stake at rake 0)
  try {
    const balances = await loadBalances(user);
    if (balances.total < stakeRaw) {
      await commitPlay(playId, { status: 'error' });
      return;
    }
    // Funding is sized off the full stake (net position + rake), unchanged by a re-route; a failed mint reverts atomically so nothing moves.
    // Funding to stake (not net) leaves the manager holding >= rake after the mint consumes ~net, so appendForkRake can always peel it out.
    const { cappedNeed, refillTo } = fundingPlan(stakeRaw, balances.total);

    const MAX_ATTEMPTS = 3;
    let cur = resolved;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const tx = new Transaction();
      fundManager(tx, managerId, cappedNeed, refillTo, balances.manager);
      if (cur.kind === 'binary') buildMint(tx, managerId, cur.params);
      else buildMintRange(tx, managerId, cur.params);
      // House rake: peels out of the manager to the revenue wallet in the same atomic PTB as the mint (no-op at rake 0); a reverted mint moves nothing (house.ts).
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
          // All-in cost = on-chain mint cost + rake sent to revenue (byte-identical to receipt.cost at rake 0); keeps the PnL ledger honest (stats.ts).
          entryCost: receipt.cost + rakeRaw,
          rake: rakeRaw, // exact fee collected: the auditable ground truth for referral revshare (referral.ts). Only minted plays carry rake > 0.
          multiplier: actualMultiplier,
          openedAt: new Date(),
        });
        invalidateBal(user.id); // the manager just changed; the next gate re-reads
        return;
      } catch (e) {
        lastErr = e;
        if (attempt >= MAX_ATTEMPTS - 1) throw e;
        if (isOracleGone(e)) {
          // Routed oracle expired/settled mid-mint: re-route to a fresh one (same deal via the seed), persisting new market params so result+countdown match.
          // Give up with the original error if no market is available to re-route to.
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

// The market+pricing fields a resolve produces, split out so a re-route (mintPending) can overwrite exactly these without touching userId/game/stake/seed.
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
    // Dealt nominal tier stored in the legacy `leverage` column (rounded); the honest mintable multiple lives in `multiplier`.
    return { ...base, side: r.side, leverage: Math.round(r.tier), strike: r.strikeDisplay };
  }
  return { ...base, lower: r.lowerDisplay, upper: r.upperDisplay, widthPct: r.widthPct ?? null };
}

function mapResolvedToPlay(userId: string, r: Resolved, stakeRaw: bigint, rakeRaw: bigint) {
  const seed = r.kind === 'binary' ? { rngSeed: r.seed } : {};
  // Provisional all-in cost = previewed mint cost + rake, snapped to the real receipt cost once the mint lands (mintPending); equals marketFieldsOf's cost at rake 0.
  return { userId, game: r.game, status: 'pending', stake: stakeRaw, ...seed, ...marketFieldsOf(r), entryCost: r.entryCost + rakeRaw };
}

// === Real-mode create / mint (IS_REAL_PREDICT) ===
// Same optimistic shape as the fork mint but against the real protocol: resolve to ticks + a premium budget, then ensure the wrapper, deposit the shortfall, and mint in one sponsored PTB in the background.
// The order id and REAL minted multiplier are only known post-mint, so the pending play carries a placeholder that mintPendingReal fills in.

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

// Fresh resolve on a new oracle for the same bet, to re-route a mint whose oracle expired mid-flight. Lucky reuses the original seed so the dealt reel stays identical; range re-derives from the same asset+width.
// Strike/quantity/multiplier re-price against the new oracle (the closest honest match to the deal).
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

// Real-mode live cash-out: redeem_live (owner-authed, mark-to-market) closes the full position, payout credited into the wrapper's internal balance (same role as the fork's manager).
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
    // Buzzer beat the cash-out: past expiry the oracle is no longer quoteable (EOracleExpired), so it settles to win/loss instead of a retryable error.
    // Any other failure stays a generic retryable redeem error.
    if (isOracleExpiredAbort(e)) throw new PlayError('PLAY_NOT_OPEN', 'Round is settling, your result is locking in');
    throw asPlayError(e, 'REDEEM_FAILED', 'Could not cash out right now. Try again.');
  }
}

// Redeem lost the race to the buzzer: the oracle crossed expiry into the unsettled gap (assert_quoteable_oracle/EOracleExpired) or already settled.
// Either way the round is over and resolves via settlement, not a retry.
const isOracleExpiredAbort = (e: unknown): boolean => {
  const m = e instanceof Error ? e.message : String(e);
  return /assert_quoteable_oracle|EOracleExpired|EOracleSettled/i.test(m);
};

// Redeem against a manager that no longer holds the position: decrease_position/decrease_range abort only when the quantity isn't there, i.e. already redeemed.
// Almost always a cash-out whose DB write was lost; this is terminal, never a transient retry.
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

// Mirrors on-chain settlement exactly (oracle::compute_price): UP pays iff settlement > strike, DOWN iff settlement <= strike.
// The `<=` matters only at the exact tie; `<` there would record a loss while the chain pays, stranding the redeem.
const isItm = (key: PlayKey, settlement1e9: bigint): boolean =>
  key.kind === 'binary'
    ? key.params.side === 'up'
      ? settlement1e9 > key.params.strike1e9
      : settlement1e9 <= key.params.strike1e9
    : settlement1e9 > key.params.lower1e9 && settlement1e9 <= key.params.higher1e9;

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

// Give-up thresholds for the evidence-based sweep in settleDuePlays (Phase 3): never error on elapsed time alone, only when the oracle is provably unsettleable.
const UNSETTLEABLE_MS = 5 * 60_000; // oracle reads fine but unsettled with no cap the operator holds (dead deployment)
const ORPHAN_GIVEUP_MS = 30 * 60_000; // oracle object unreadable this long (chain gone, e.g. wiped localnet)

// Authorized cap to push/settle with: the live ladder cache first, else a cap the oracle authorizes on-chain that the operator still holds (survives a restart).
// Undefined for a dead-deployment oracle the operator no longer owns, left for the give-up sweep instead of guessing.
function resolveOracleCap(st: OracleState): string | undefined {
  const cached = getMarket(st.oracleId)?.capId;
  if (cached) return cached;
  return st.authorizedCapIds.find((id) => operatorCaps.oracleCapIds.includes(id));
}

// The price our settlement tx will freeze: the oracle's last recorded on-chain spot, pushed before expiry (not yet a settlement result until update_prices runs).
// Using it makes settlement independent of worker delay; falls back to the live feed only if the oracle never recorded a spot.
async function settleSpotUsd(asset: string, lastSpot1e9: bigint): Promise<number | null> {
  const last = Number(lastSpot1e9) / 1e9;
  if (last > 0) return last;
  const fresh = await gameSpot(asset).catch(() => null);
  return fresh && fresh.price > 0 ? fresh.price : null;
}

// Batches N expired-unsettled oracles into one operator tx (the dominant settle cost when several rounds expire together), applying the frozen price in place with no re-read.
// Settle txs are latency-tolerant so retries ride out patiently: extra attempts straddle another signer sharing the operator key so the settle lands this tick instead of losing to gas-coin churn.
const SETTLE_STALE_RETRIES = 12;

// OracleState plus the settle-nudge tx digest that froze its price (when this process pushed it), so each settled play can link the tx that set its result.
// Undefined when a co-operator/leader settled it instead.
type SettleState = OracleState & { settleTx?: string };

// After a failed nudge, reconcile against the chain: EOracleSettled (abort 6) means the oracle is already settled, the state the nudge wanted (a co-operator beat us, or our own timed-out nudge actually landed).
// Re-read each oracle; any now-settled one is a success, marked with the chain's real frozen price so Phase 2 resolves it this tick.
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
    // A nudge most often fails because the oracle is already settled (co-operator beat us, or our own timed-out nudge landed), the state we wanted, not an error.
    // Reconcile against the chain; only a still-genuinely-unsettled oracle is a real failure worth logging and retrying.
    if (await reconcileSettled(items, states)) return true;
    console.error(`[Settle] settle-nudge x${items.length} failed, will retry:`, e instanceof Error ? e.message : e);
    return false;
  }
}

// Settle every open play whose round expired. Self-healing and play-driven: reads each backing oracle straight from chain (so a market that left the live cache still settles), driving nudges here in one batched operator tx.
// Losing plays resolve with no tx; winning plays redeem through the operator, capped per tick so a backlog can't monopolize the serial executor.
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

  // Phase 1: freeze settlement on every expired-unsettled oracle in one batched nudge. Settlement isn't automatic, an authorized cap must push a post-expiry price via update_prices before a redeem can quote (EOracleExpired otherwise).
  // Operator-only, gated on isOperatorLeader not OPERATOR_ENABLED: a follower shares the operator key but must not nudge, a second writer racing the leader just aborts EOracleSettled and churns the shared gas coin, so it leaves settling to the leader and only finalizes its own DB in Phase 2.
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
      // Batch reverted (e.g. one oracle settled out from under it): isolate by retrying individually, skipping any the reconcile already marked settled.
      for (const it of toNudge) {
        if (states.get(it.st.oracleId)?.settled) continue;
        await settleOracles([it], states);
      }
    }
  }

  // Phase 2: resolve plays whose oracle is now settled. Losing plays cost no tx; winning plays redeem through the operator, capped per tick.
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

  // Phase 3: give up ONLY on plays whose oracle is provably unsettleable, never on elapsed time alone; runs after the settle attempt so a merely-behind/mid-redeem play stays 'open' to retry later.
  // The status:'open' guard also skips anything Phase 2 just resolved; errors here mean genuinely unsettleable, not slow.
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
      // Real positions we genuinely cannot settle (dead deployment/wiped chain); recovery is unchanged, this only surfaces it since funds are stuck.
      alert('critical', `settle gave up on ${res.count} unsettleable play(s) (dead oracle / wiped chain)`);
    }
  }
}

async function settleOnePlay(play: Play, settlement1e9: bigint, settleTx?: string): Promise<void> {
  const key = deserializeKey(play);
  const itm = isItm(key, settlement1e9);

  // lagS = how long after expiry the round actually settled; a big number here is the stuck-settle symptom.
  const lagS = Math.round((Date.now() - Number(play.expiry)) / 1000);
  roundLog(
    `[Round SETTLE] ${play.game.padEnd(5)} ${play.asset.padEnd(4)} ` +
    (key.kind === 'binary'
      ? `${(key.params.side as string).toUpperCase().padEnd(4)} strike=${px1e9(key.params.strike1e9)}`
      : `band=(${px1e9(key.params.lower1e9)}, ${px1e9(key.params.higher1e9)}]`) +
    `  settle=$${px1e9(settlement1e9)}  ${itm ? 'WIN ' : 'LOSS'}  (expired ${lagS}s ago)  @${hhmmss()}`,
  );

  // ITM settle sweeps the $1/contract payout via a permissionless redeem (no owner check once settled), so the operator finalizes wins in either auth mode.
  // Mark won only after the redeem confirms on-chain; a failed redeem leaves the play open to retry next tick. A loss has nothing to redeem, settles immediately.
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
      // Signs with the dedicated settlement wallet (its own gas coin) so a slow redeem can't head-of-line block the operator's price-push/nudge lane.
      // Falls back to the operator wallet when no settlement wallet is configured.
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
      // Position already gone from the manager (decrease_position/decrease_range aborts on empty quantity): cashed out before expiry but the DB write was lost, chips already moved on-chain.
      // Retrying can never succeed, so reconcile from the chain's own redeem record instead of looping forever.
      if (isAlreadyRedeemedAbort(e)) {
        await reconcileAlreadyRedeemed(play, key, settlement1e9);
        return;
      }
      console.error(`[Settle] on-chain redeem failed for ${play.id}, will retry:`, e instanceof Error ? e.message : e);
      return; // leave status 'open' so the next settle tick retries the redeem
    }
  }

  // The redeem event is the exact amount credited on-chain; a loss has no redeem tx and therefore a zero payout.
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

// Reconcile a play whose position is already gone (settle redeem aborted EInsufficientPosition): pull the exact earlier redeem off chain and record its true payout, never invent money.
// is_settled tells cashed_out vs won; if no redeem is found at all (stale manager), mark 'error' so it stops looping, excluded from the PnL ledger.
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
// Mysten's testnet Predict settles from Pyth-at-expiry, not a price we push, so there's no operator nudge: redeem_settled (permissionless, full-close) drives ensure_settled then pays $1*qty or 0 into the wrapper.
// Self-healing like the fork: reconciles an already-closed position against its on-chain redeem event, gives up only on a provably-stuck/gone market. Stores the ExpiryMarket id in oracleId, the u256 order id in marketKey (quantity decoded from it).

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

// Write the resolved outcome for a real play: a settled win pays into the wrapper (invalidate the balance gate), a loss/liquidation pays 0. Mirrors settleOnePlay's terminal write.
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

// Live cash-out value for an open play (the redeem bid); settled/closed plays use the stored payout. Raw read is a ~1.5s devInspect on the remote node.
export async function getLiveMarkRaw(play: Play): Promise<bigint> {
  if (play.status !== 'open') return play.payout ?? play.markValue ?? 0n;
  // Real mode: live P/L is chart-synced on the client, and a backend redeem_live devInspect needs a funded wrapper + same-PTB pricer, so we don't poll a server mark.
  // Return the entry as a neutral mark; the client draws the live swing off the chart.
  if (IS_REAL_PREDICT) return play.markValue ?? play.entryCost;
  const key = deserializeKey(play);
  const user = await prismaQuery.user.findUnique({
    where: { id: play.userId },
    select: { address: true, predictManagerId: true },
  });
  if (!user?.predictManagerId) throw new Error(`Play ${play.id} has no PredictManager`);
  return previewExecutableRedeem(user.predictManagerId, user.address, key);
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

// Exact settlement price for the short window after the oracle settlement tx lands but before this play's redeem/DB finalization completes.
// Before the chain sets settlement_price there's no result, so we return nothing instead of presenting the last live spot as a locked outcome.
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

// Real mode's marketKey is a decimal order id, but plays from before the fork->real-Predict switch stored a JSON fork key there; parse defensively so listing old plays doesn't 500.
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
  // Max payout = position quantity ($1 each at settle): real mode decodes it from the order id (empty until mint lands), fork mode reads it off the serialized redeem key.
  // Legacy plays stored a JSON fork key in this column instead of a decimal order id, so guard the parse and fall back to stake for those.
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
