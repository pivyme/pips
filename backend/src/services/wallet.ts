// Wallet management: withdraw DUSDC to any Sui address. The displayed balance is wallet coins +
// PredictManager chips (chips migrate into the manager as plays run), so a withdraw sources from
// both: it pulls the shortfall out of the manager (owner-gated on-chain) and pays the rest from the
// wallet coins, all in ONE PTB signed for the user (dev = operator, privy = the embedded wallet via
// a session signer). Runs under the same per-user lock as plays so owned coins never equivocate.
//
// Deposits need no endpoint: the user's address simply receives DUSDC, which shows up in the balance.

import { Transaction, coinWithBalance, type TransactionObjectArgument } from '@mysten/sui/transactions';
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';

import type { User } from '../../prisma/generated/client.js';
import { DUSDC_TYPE, toDusdcRaw } from '../lib/sui/config.ts';
import { getDusdcBalanceRaw, transferDusdc } from '../lib/sui/dusdc.ts';
import { buildManagerWithdraw, getManagerBalanceRaw } from '../lib/sui/predict.ts';
import {
  buildAuth,
  buildWithdrawFunds,
  readWrapperBalanceRaw,
  resolveWrapper,
} from '../lib/sui/predict-real.ts';
import { executeForUser, userContext } from '../lib/sui/execute.ts';
import { FAUCET_AMOUNT, FAUCET_COOLDOWN_MS, IS_REAL_PREDICT } from '../config/main-config.ts';
import { withUserLock, invalidateBal } from './plays.ts';
import { toUserDTO } from './auth.ts';
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

// Request DUSDC faucet: hand the user a fixed amount of test chips, rate-limited per user. The
// cooldown is in-memory (anti-spam only, not security-critical on a free localnet), so it resets on a
// restart and is per-process, which is fine: a user hits one backend. Chips are paid from the treasury
// reserve (transferDusdc), so this never signs an operator tx on a follower.
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

// `user.balance` is a 2dp display string, so a "Max" withdraw can land a sub-cent above the true
// on-chain total. Treat any overshoot within one cent as "withdraw everything" and clamp to the real
// total; a larger request is a genuine shortfall. (One cent = 10_000 raw at 6dp.)
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

  return withUserLock(user.id, () =>
    IS_REAL_PREDICT ? withdrawRealLocked(user, recipient, amountRaw) : withdrawForkLocked(user, recipient, amountRaw),
  );
}

// Fork path (localnet/devnet): chips live in the per-user PredictManager. Pull the shortfall out of the
// manager (owner-gated) and pay the rest from wallet coins, all in one PTB.
async function withdrawForkLocked(user: User, recipient: string, wantRaw: bigint): Promise<WithdrawResult> {
  const managerId = user.predictManagerId;
  if (!managerId) throw new WalletError('MANAGER_NOT_READY', 'Your account is still getting ready');

  // Read both sides fresh; this is off the hot path so the manager devInspect cost is fine.
  const [walletRaw, managerRaw] = await Promise.all([getDusdcBalanceRaw(user.address), getManagerBalanceRaw(managerId)]);
  const amountRaw = clampWithdraw(wantRaw, walletRaw + managerRaw);

  const tx = new Transaction();
  if (amountRaw <= walletRaw) {
    // Wallet coins alone cover it: split exactly `amountRaw` and send. Manager untouched.
    const coin = coinWithBalance({ type: DUSDC_TYPE, balance: amountRaw })(tx);
    tx.transferObjects([coin], tx.pure.address(recipient));
  } else {
    // Need manager chips too: pull the shortfall out of the manager, merge in all wallet DUSDC,
    // and send the exact total as one coin.
    const mgrCoin = buildManagerWithdraw(tx, managerId, amountRaw - walletRaw);
    payShortfall(tx, mgrCoin, walletRaw, recipient);
  }
  return execWithdraw(user, tx);
}

// Real path (testnet, Mysten Predict): chips live in the wallet + the per-owner AccountWrapper's
// internal balance (a cash-out credits it there, same as the fork keeps chips in the manager). Pull the
// shortfall out of the wrapper via withdraw_funds (owner-authed, fresh Auth) and pay the rest from
// wallet coins, one PTB. Off the hot path, so resolve the wrapper straight from chain (no cache).
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

// Clamp a requested withdrawal to the true on-chain total. `user.balance` is a 2dp display string, so a
// "Max" withdraw can land a sub-cent above it: treat an overshoot within one cent as "withdraw
// everything"; a larger request is a genuine shortfall.
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
