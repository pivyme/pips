// Wallet money surface. Balance stays a live chain read (wallet DUSDC + AccountWrapper chips), so a withdraw
// pulls the shortfall from the wrapper and pays the rest from wallet coins in ONE PTB, under the per-user lock.
// Send generalizes to ANY held coin (token recovery): DUSDC keeps the wallet+wrapper path, every other coin
// uses a plain transfer PTB. Every signed movement (send/faucet/grant) writes an inline WalletTx feed row.

import { Transaction, coinWithBalance, type TransactionObjectArgument } from '@mysten/sui/transactions';
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';

import type { User } from '../../prisma/generated/client.js';
import { prismaQuery } from '../lib/prisma.ts';
import { DUSDC_TYPE, toDusdcRaw } from '../lib/sui/config.ts';
import { getDusdcBalanceRaw, transferDusdc } from '../lib/sui/dusdc.ts';
import { suiClient } from '../lib/sui/client.ts';
import {
  buildAuth,
  buildWithdrawFunds,
  readUserChipsRaw,
  readWrapperBalanceRaw,
  resolveWrapper,
} from '../lib/sui/predict-real.ts';
import { executeForUser, userContext } from '../lib/sui/execute.ts';
import { SPONSOR_ENABLED } from '../lib/sui/sponsor.ts';
import { treasuryAddress } from '../lib/sui/signer.ts';
import { listHeldCoins, resolveTokenInfo, parseUnits, formatUnits, normType, isSuiType, CHIP_CANON, type HeldCoin } from '../lib/sui/tokens.ts';
import {
  recordWalletTx,
  syncUserWallet,
  toWalletTxDTO,
  depositToWalletTxDTO,
  WALLET_REAL_NETWORK,
} from '../lib/sui/wallet-ledger.ts';
import {
  FAUCET_AMOUNT,
  FAUCET_COOLDOWN_MS,
  GRANT_COOLDOWN_MS,
  MIN_STAKE,
  WALLET_SYNC_MIN_INTERVAL_MS,
  WALLET_SYNC_STALE_MS,
} from '../config/main-config.ts';
import { withUserLock, invalidateBal } from './plays.ts';
import { toUserDTO, grantStarterChips } from './auth.ts';
import type { UserDTO, WalletCoinDTO, WalletTxDTO } from '../types/api.ts';

export type WalletErrorCode =
  | 'MANAGER_NOT_READY'
  | 'INVALID_ADDRESS'
  | 'INVALID_AMOUNT'
  | 'INVALID_COIN'
  | 'INSUFFICIENT_DUSDC'
  | 'INSUFFICIENT_BALANCE'
  | 'WITHDRAW_FAILED'
  | 'FAUCET_COOLDOWN'
  | 'FAUCET_FAILED';

export class WalletError extends Error {
  code: WalletErrorCode;
  constructor(code: WalletErrorCode, message: string) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

export const httpStatusForWalletError = (code: WalletErrorCode): number =>
  code === 'WITHDRAW_FAILED' || code === 'FAUCET_FAILED' ? 500 : code === 'FAUCET_COOLDOWN' ? 429 : 400;

export type WithdrawResult = { user: UserDTO; digest: string };
export type FaucetResult = { user: UserDTO; amount: string; digest: string };

// Canonical chip type for send routing (may be null if the deploy record is missing DUSDC).
const DUSDC_CANON = CHIP_CANON;
// SUI a send reserves for gas when sponsorship is OFF (the norm is ON, so this is a fallback safety margin).
const SUI_GAS_RESERVE_RAW = 50_000_000n; // 0.05 SUI (9dp)

// Request DUSDC faucet: fixed amount of test chips, rate-limited per user via an in-memory cooldown
// (anti-spam only, not security-critical; resets on restart, fine since a user hits one backend). Paid from the treasury reserve, so it never signs an operator tx on a follower.
const lastFaucetAt = new Map<string, number>();

export async function requestDusdc(user: User): Promise<FaucetResult> {
  const now = Date.now();
  const remaining = FAUCET_COOLDOWN_MS - (now - (lastFaucetAt.get(user.id) ?? 0));
  if (remaining > 0) {
    throw new WalletError('FAUCET_COOLDOWN', `Faucet on cooldown. Try again in ${Math.ceil(remaining / 1000)}s.`);
  }
  // Reserve the slot before the on-chain call so two rapid taps can't both pass the gate.
  lastFaucetAt.set(user.id, now);

  let digest: string;
  try {
    digest = await transferDusdc(user.address, FAUCET_AMOUNT);
  } catch (e) {
    lastFaucetAt.delete(user.id); // the payout failed, let them retry immediately
    console.error('[wallet] faucet failed:', e instanceof Error ? e.message : e);
    throw new WalletError('FAUCET_FAILED', 'Could not send test DUSDC. Try again in a moment.');
  }

  // Inline feed row: an instant "Faucet" receive; the indexer later upserts the same digest (no dup).
  await recordWalletTx({ userId: user.id, address: user.address, direction: 'in', kind: 'faucet', coinType: DUSDC_TYPE, amountRaw: toDusdcRaw(FAUCET_AMOUNT), digest, counterparty: treasuryAddress || null });

  invalidateBal(user.id); // wallet just received chips; the next play gate must re-read
  return { user: await toUserDTO(user), amount: FAUCET_AMOUNT.toFixed(2), digest };
}

export type GrantResult = { user: UserDTO; granted: number | null };

// In-flight guard: the cooldown lives in the DB (lastFundedAt), written only after the on-chain transfer, so
// two concurrent grants (the on-load auto top-up racing a manual TOP UP) could both pass the gate before
// either write lands. This serializes per user so at most one grant fires; the loser reports granted:null.
const grantingNow = new Set<string>();

// Starter-chip grant: the "TOP UP" / auto top-up path when a player can't afford the minimum stake. Runs the
// same guarded top-up as the login refill on a short cooldown, so a player at zero is never stuck on testnet.
// `granted` is the DUSDC amount sent (drives the client celebration), or null if it was skipped (they already
// have chips, on cooldown, a concurrent grant won, or the treasury is dry). Never throws: a dry treasury reports null, not a 500.
export async function grantChips(user: User): Promise<GrantResult> {
  if (grantingNow.has(user.id)) return { user: await toUserDTO(user), granted: null };
  grantingNow.add(user.id);
  try {
    const { user: updated, granted } = await grantStarterChips(user, GRANT_COOLDOWN_MS, MIN_STAKE);
    if (granted != null) invalidateBal(updated.id); // chips just landed; the next play gate must re-read
    return { user: await toUserDTO(updated), granted };
  } finally {
    grantingNow.delete(user.id);
  }
}

// `user.balance` is a 2dp display string, so a "Max" withdraw can land a sub-cent above the true on-chain
// total; treat any overshoot within one cent as "withdraw everything" and clamp to it (one cent = 10_000 raw at 6dp), a larger request is a genuine shortfall.
const DUST_TOLERANCE_RAW = 10_000n;

// Validate + normalize a recipient Sui address (padded 0x form accepted).
function normalizeRecipient(recipientInput: string): string {
  const trimmed = typeof recipientInput === 'string' ? recipientInput.trim() : '';
  if (!trimmed || !/^0x[0-9a-fA-F]+$/.test(trimmed) || !isValidSuiAddress(normalizeSuiAddress(trimmed))) {
    throw new WalletError('INVALID_ADDRESS', 'Enter a valid Sui address');
  }
  return normalizeSuiAddress(trimmed);
}

// Send `amount` of `coinType` (default DUSDC chips) to a Sui address, server-signed for the user. DUSDC keeps
// the wallet+wrapper path; any other coin uses a generic transfer so an accidental deposit is recoverable.
// Writes an inline 'send' feed row on success.
export async function withdrawCoin(
  user: User,
  recipientInput: string,
  amountInput: string | number,
  coinTypeInput?: string | null,
): Promise<WithdrawResult> {
  const recipient = normalizeRecipient(recipientInput);
  const rawCoin = typeof coinTypeInput === 'string' ? coinTypeInput.trim() : '';
  const coinCanon = rawCoin ? normType(rawCoin) : DUSDC_CANON;
  if (!coinCanon) throw new WalletError('INVALID_COIN', 'Unsupported coin');

  // DUSDC (the chips): the wallet + wrapper path, exactly as before.
  if (DUSDC_CANON && coinCanon === DUSDC_CANON) {
    const amount = typeof amountInput === 'number' ? amountInput : parseFloat(String(amountInput).replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) throw new WalletError('INVALID_AMOUNT', 'Enter an amount to withdraw');
    const amountRaw = toDusdcRaw(amount);
    if (amountRaw <= 0n) throw new WalletError('INVALID_AMOUNT', 'Enter an amount to withdraw');
    const res = await withUserLock(user.id, () => withdrawDusdcLocked(user, recipient, amountRaw));
    await recordWalletTx({ userId: user.id, address: user.address, direction: 'out', kind: 'send', coinType: DUSDC_TYPE, amountRaw: res.sentRaw, digest: res.digest, counterparty: recipient });
    return { user: res.user, digest: res.digest };
  }

  // Any other coin: a plain transfer PTB (token recovery). Amount is in the token's own decimals.
  const info = await resolveTokenInfo(coinCanon);
  let wantRaw: bigint;
  try {
    wantRaw = parseUnits(String(amountInput ?? ''), info.decimals);
  } catch {
    throw new WalletError('INVALID_AMOUNT', 'Enter an amount to send');
  }
  if (wantRaw <= 0n) throw new WalletError('INVALID_AMOUNT', 'Enter an amount to send');
  const res = await withUserLock(user.id, () => transferCoinLocked(user, recipient, coinCanon, wantRaw));
  await recordWalletTx({ userId: user.id, address: user.address, direction: 'out', kind: 'send', coinType: coinCanon, amountRaw: res.sentRaw, digest: res.digest, counterparty: recipient });
  return { user: res.user, digest: res.digest };
}

type LockedResult = { user: UserDTO; digest: string; sentRaw: bigint };

// Chips live in the wallet + the per-owner AccountWrapper's internal balance (a cash-out credits it there).
// Pulls the shortfall via withdraw_funds (owner-authed) and pays the rest from wallet coins in one PTB; off the hot path, so resolves the wrapper straight from chain (no cache).
async function withdrawDusdcLocked(user: User, recipient: string, wantRaw: bigint): Promise<LockedResult> {
  const w = await resolveWrapper(user.address);
  const [walletRaw, wrapperRaw] = await Promise.all([
    getDusdcBalanceRaw(user.address),
    w.exists ? readWrapperBalanceRaw(w.wrapperId, user.address) : Promise.resolve(0n),
  ]);
  const amountRaw = clampWithdraw(wantRaw, walletRaw + wrapperRaw);

  const tx = new Transaction();
  if (amountRaw <= walletRaw) {
    const coin = coinWithBalance({ type: DUSDC_TYPE, balance: amountRaw })(tx);
    tx.transferObjects([coin], tx.pure.address(recipient));
  } else {
    const wrapperCoin = buildWithdrawFunds(tx, tx.object(w.wrapperId), buildAuth(tx), amountRaw - walletRaw);
    payShortfall(tx, wrapperCoin, walletRaw, recipient);
  }
  const { user: dto, digest } = await execWithdraw(user, tx);
  return { user: dto, digest, sentRaw: amountRaw };
}

// Generic coin transfer (token recovery): validate against the real held balance, reserving a little SUI for
// gas when sponsorship is off, then peel + send the exact amount as one coin.
async function transferCoinLocked(user: User, recipient: string, coinType: string, wantRaw: bigint): Promise<LockedResult> {
  const held = await getCoinBalanceRaw(user.address, coinType);
  // Sponsored gas is drawn from the sponsor's SUI (not the user's), so a SUI send can go to the full held
  // total; only reserve a gas buffer if sponsorship is off (then the user pays their own SUI gas).
  const gasReserve = isSuiType(coinType) && !SPONSOR_ENABLED ? SUI_GAS_RESERVE_RAW : 0n;
  const spendable = held - gasReserve;
  if (wantRaw > held) throw new WalletError('INSUFFICIENT_BALANCE', 'Not enough balance to send that much');
  const amountRaw = wantRaw > spendable ? spendable : wantRaw; // clamp a "Max" SUI send down to leave gas
  if (amountRaw <= 0n) throw new WalletError('INSUFFICIENT_BALANCE', 'Not enough balance to send');

  const tx = new Transaction();
  const coin = coinWithBalance({ type: coinType, balance: amountRaw })(tx);
  tx.transferObjects([coin], tx.pure.address(recipient));
  const { user: dto, digest } = await execWithdraw(user, tx);
  return { user: dto, digest, sentRaw: amountRaw };
}

// Read an address's total balance for one coin type (base units).
async function getCoinBalanceRaw(owner: string, coinType: string): Promise<bigint> {
  const bal = await suiClient.getBalance({ owner, coinType });
  return BigInt(bal.balance.balance);
}

// Clamp a requested withdrawal to the true on-chain total, treating overshoot within DUST_TOLERANCE_RAW
// as a "Max" rounding artifact (2dp display balance) rather than a genuine shortfall.
function clampWithdraw(wantRaw: bigint, totalRaw: bigint): bigint {
  let amountRaw = wantRaw;
  if (amountRaw > totalRaw) {
    if (amountRaw - totalRaw > DUST_TOLERANCE_RAW) {
      throw new WalletError('INSUFFICIENT_DUSDC', 'Not enough balance to withdraw that much');
    }
    amountRaw = totalRaw; // a Max withdraw rounded a hair high: send exactly what's on chain
  }
  if (amountRaw <= 0n) throw new WalletError('INSUFFICIENT_DUSDC', 'Not enough balance to withdraw that much');
  return amountRaw;
}

// Merge any wallet coins into the coin peeled from the chips store, then send the exact total as one coin.
function payShortfall(tx: Transaction, chipCoin: TransactionObjectArgument, walletRaw: bigint, recipient: string): void {
  if (walletRaw > 0n) {
    const walletCoin = coinWithBalance({ type: DUSDC_TYPE, balance: walletRaw })(tx);
    tx.mergeCoins(walletCoin, [chipCoin]);
    tx.transferObjects([walletCoin], tx.pure.address(recipient));
  } else {
    tx.transferObjects([chipCoin], tx.pure.address(recipient));
  }
}

async function execWithdraw(user: User, tx: Transaction): Promise<WithdrawResult> {
  let digest: string;
  try {
    const exec = await executeForUser(tx, userContext(user));
    digest = exec.digest;
  } catch (e) {
    console.error('[wallet] withdraw failed:', e instanceof Error ? e.message : e);
    throw new WalletError('WITHDRAW_FAILED', 'Could not complete the withdrawal. Your funds are safe. Try again.');
  }
  invalidateBal(user.id); // wallet + chips just changed; the next play gate must re-read
  return { user: await toUserDTO(user), digest };
}

// === Reads: held coins + activity feed ===

// Every non-zero coin the wallet holds, resolved + priced, for the send picker + balance list. Works on any
// network (listBalances is gRPC), so it isn't gated on WALLET_REAL_NETWORK. DUSDC's spendable includes the
// AccountWrapper's internal chips (a cash-out credits them there), which listBalances misses, so the chip
// coin is overridden/added to match the balance headline + the DUSDC withdraw path (wallet + wrapper).
export async function getWalletCoins(user: User): Promise<{ coins: WalletCoinDTO[] }> {
  const [held, chipRaw, chipInfo] = await Promise.all([
    listHeldCoins(user.address),
    fullDusdcSpendableRaw(user),
    DUSDC_CANON ? resolveTokenInfo(DUSDC_CANON).catch(() => null) : Promise.resolve(null),
  ]);
  const coins = held.map(toWalletCoinDTO);

  const decimals = chipInfo?.decimals ?? 6;
  const chipAmount = formatUnits(chipRaw, decimals);
  const chipUsd = (Number(chipRaw) / 10 ** decimals).toFixed(2);
  const idx = coins.findIndex((c) => c.isChip);
  if (idx >= 0) {
    coins[idx] = { ...coins[idx], amount: chipAmount, amountRaw: chipRaw.toString(), priceUsd: '1', usdValue: chipUsd };
  } else if (chipRaw > 0n && chipInfo && DUSDC_CANON) {
    // Wallet DUSDC is 0 but the wrapper holds chips: listBalances returned none, so add the chip coin.
    coins.unshift({
      coinType: DUSDC_CANON,
      symbol: chipInfo.symbol,
      name: chipInfo.name,
      decimals,
      logo: chipInfo.iconUrl,
      amount: chipAmount,
      amountRaw: chipRaw.toString(),
      priceUsd: '1',
      usdValue: chipUsd,
      isChip: true,
    });
  }
  return { coins };
}

// DUSDC spendable = wallet coins + the AccountWrapper's internal chips, same sum the balance headline uses.
async function fullDusdcSpendableRaw(user: User): Promise<bigint> {
  const [wallet, wrapper] = await Promise.all([
    getDusdcBalanceRaw(user.address).catch(() => 0n),
    readUserChipsRaw(user.address, user.predictWrapperId).catch(() => 0n),
  ]);
  return wallet + wrapper;
}

function toWalletCoinDTO(c: HeldCoin): WalletCoinDTO {
  return {
    coinType: c.coinType,
    symbol: c.symbol,
    name: c.name,
    decimals: c.decimals,
    logo: c.iconUrl,
    amount: c.amount,
    amountRaw: c.amountRaw.toString(),
    priceUsd: c.priceUsd != null ? String(c.priceUsd) : null,
    usdValue: c.usdValue != null ? c.usdValue.toFixed(2) : null,
    isChip: c.isChip,
  };
}

// Keyset cursor `${timestampMs}_${id}` over the ledger, ordered timestampMs desc then id desc.
function parseCursor(cursor: string | null | undefined): { ts: bigint; id: string } | null {
  if (!cursor) return null;
  const i = cursor.indexOf('_');
  if (i < 0) return null;
  try {
    return { ts: BigInt(cursor.slice(0, i)), id: cursor.slice(i + 1) };
  } catch {
    return null;
  }
}

// The activity feed: WalletTx rows newest-first (keyset paginated), with any in-flight bridge Deposit merged
// on the first page. Logo/symbol resolve live from TokenInfo (a late-learned logo self-heals old rows, §12b).
// Repair-on-read: a stale feed kicks a light background sync so opening it reflects current chain state.
export async function getWalletTransactions(user: User, opts: { limit?: number; cursor?: string | null } = {}): Promise<{ items: WalletTxDTO[]; nextCursor: string | null }> {
  if (WALLET_REAL_NETWORK) {
    const stale = !user.walletSyncedAt || Date.now() - user.walletSyncedAt.getTime() > WALLET_SYNC_STALE_MS;
    if (stale) void syncUserWallet(user).catch(() => {}); // fire-and-forget; the DB still serves whatever it has
  }

  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const cursor = parseCursor(opts.cursor);
  const rows = await prismaQuery.walletTx.findMany({
    where: {
      userId: user.id,
      ...(cursor ? { OR: [{ timestampMs: { lt: cursor.ts } }, { AND: [{ timestampMs: cursor.ts }, { id: { lt: cursor.id } }] }] } : {}),
    },
    orderBy: [{ timestampMs: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  const types = [...new Set(page.map((r) => r.coinType).filter(Boolean))];
  const infoByType = new Map(await Promise.all(types.map(async (t) => [t, await resolveTokenInfo(t)] as const)));
  let items: WalletTxDTO[] = page.map((r) => toWalletTxDTO(r, infoByType.get(r.coinType)));

  // Merge in-flight bridges (non-DONE) onto the first page only; a landed bridge is indexed as a WalletTx
  // receive and the Deposit flips DONE, so it never double-shows (§5).
  if (!cursor) {
    const pending = await prismaQuery.deposit.findMany({ where: { userId: user.id, status: { not: 'DONE' } }, orderBy: { createdAt: 'desc' } }).catch(() => []);
    if (pending.length > 0) items = [...pending.map(depositToWalletTxDTO), ...items];
  }

  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? `${last.timestampMs}_${last.id}` : null;
  return { items, nextCursor };
}

// === On-demand sync (deposit watch): POST /wallet/sync ===

// Anti-spam: a per-user min interval + a cache of the last scan's new rows, so a burst of taps collapses to
// one scan and a within-window call returns the last known receives without re-scanning (§11a). Ephemeral.
const lastSyncAt = new Map<string, number>();
const lastReceived = new Map<string, WalletTxDTO[]>();

const filterSince = (rows: WalletTxDTO[], sinceMs?: number): WalletTxDTO[] =>
  sinceMs == null ? rows : rows.filter((r) => Number(r.timestampMs) >= sinceMs);

export async function walletSync(user: User, sinceMs?: number): Promise<{ received: WalletTxDTO[] }> {
  if (!WALLET_REAL_NETWORK) return { received: [] };
  const now = Date.now();
  const last = lastSyncAt.get(user.id) ?? 0;
  if (now - last < WALLET_SYNC_MIN_INTERVAL_MS) {
    return { received: filterSince(lastReceived.get(user.id) ?? [], sinceMs) };
  }
  lastSyncAt.set(user.id, now);
  const { received } = await syncUserWallet(user); // coalesced per user (the cron may be running one too)
  lastReceived.set(user.id, received);
  if (lastReceived.size > 2000) lastReceived.clear(); // ephemeral anti-spam cache; a rare clear is harmless
  return { received: filterSince(received, sinceMs) };
}
