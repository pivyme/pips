// Withdraw DUSDC to any Sui address. Displayed balance is wallet coins + PredictManager chips, so a withdraw pulls the
// shortfall from the manager and pays the rest from wallet coins in ONE PTB, under the same per-user lock as plays. Deposits need no endpoint, DUSDC sent to the address just shows up in the balance.

import { Transaction, coinWithBalance, type TransactionObjectArgument } from '@mysten/sui/transactions';
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';

import type { User } from '../../prisma/generated/client.js';
import { DUSDC_TYPE, toDusdcRaw } from '../lib/sui/config.ts';
import { getDusdcBalanceRaw, transferDusdc } from '../lib/sui/dusdc.ts';
import {
  buildAuth,
  buildWithdrawFunds,
  readWrapperBalanceRaw,
  resolveWrapper,
} from '../lib/sui/predict-real.ts';
import { executeForUser, userContext } from '../lib/sui/execute.ts';
import { FAUCET_AMOUNT, FAUCET_COOLDOWN_MS, GRANT_COOLDOWN_MS, MIN_STAKE } from '../config/main-config.ts';
import { withUserLock, invalidateBal } from './plays.ts';
import { toUserDTO, grantStarterChips } from './auth.ts';
import type { UserDTO } from '../types/api.ts';

export type WalletErrorCode =
  | 'MANAGER_NOT_READY'
  | 'INVALID_ADDRESS'
  | 'INVALID_AMOUNT'
  | 'INSUFFICIENT_DUSDC'
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

export async function withdrawDusdc(
  user: User,
  recipientInput: string,
  amountInput: string | number,
): Promise<WithdrawResult> {
  // Recipient must be a valid Sui address. Normalize so a short 0x form is accepted and stored padded.
  const trimmed = typeof recipientInput === 'string' ? recipientInput.trim() : '';
  if (!trimmed || !/^0x[0-9a-fA-F]+$/.test(trimmed) || !isValidSuiAddress(normalizeSuiAddress(trimmed))) {
    throw new WalletError('INVALID_ADDRESS', 'Enter a valid Sui address');
  }
  const recipient = normalizeSuiAddress(trimmed);

  // Amount must be positive. Parse leniently (the client may send a comma-grouped string).
  const amount = typeof amountInput === 'number' ? amountInput : parseFloat(String(amountInput).replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) throw new WalletError('INVALID_AMOUNT', 'Enter an amount to withdraw');
  const amountRaw = toDusdcRaw(amount);
  if (amountRaw <= 0n) throw new WalletError('INVALID_AMOUNT', 'Enter an amount to withdraw');

  return withUserLock(user.id, () => withdrawRealLocked(user, recipient, amountRaw));
}

// Chips live in the wallet + the per-owner AccountWrapper's internal balance (a cash-out credits it there).
// Pulls the shortfall via withdraw_funds (owner-authed) and pays the rest from wallet coins in one PTB; off the hot path, so resolves the wrapper straight from chain (no cache).
async function withdrawRealLocked(user: User, recipient: string, wantRaw: bigint): Promise<WithdrawResult> {
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
  return execWithdraw(user, tx);
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
