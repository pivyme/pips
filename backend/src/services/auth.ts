// Auth + onboarding. One JWT plumbing, two identity modes (dev / privy). ensureUser is the
// idempotent onboarding called from both login paths: it upserts the row, seeds an empty stats
// row, mints the free starting chips + SUI gas exactly once, and creates the user's
// PredictManager. Never re-mints chips, never makes a second manager. See LUCKY.md §6-7.

import jwt from 'jsonwebtoken';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import type { User } from '../../prisma/generated/client.js';
import { prismaQuery } from '../lib/prisma.ts';
import { AUTH_MODE, JWT_SECRET, JWT_EXPIRES_IN, STARTING_BALANCE, IS_REAL_PREDICT } from '../config/main-config.ts';
import { transferDusdc, getDusdcBalanceRaw } from '../lib/sui/dusdc.ts';
import { ensureSuiGas } from '../lib/sui/gas.ts';
import { SPONSOR_ENABLED } from '../lib/sui/sponsor.ts';
import { generateCustodialWallet } from '../lib/sui/custodial.ts';
import { executeAsOperator, executeForUser, userContext } from '../lib/sui/execute.ts';
import { isChainUnavailableError } from '../lib/sui/client.ts';
import { buildCreateManager, getManagerBalanceRaw, managerExists } from '../lib/sui/predict.ts';
import { readUserChipsRaw } from '../lib/sui/predict-real.ts';
import { fromDusdcRaw } from '../lib/sui/config.ts';
import type { UserDTO } from '../types/api.ts';

// Friendly two-word handle, e.g. "Lucky Otter". displayName is not unique, collisions are fine.
const ADJECTIVES = ['Lucky', 'Bold', 'Swift', 'Calm', 'Brave', 'Sly', 'Quiet', 'Wild', 'Sharp', 'Bright', 'Cool', 'Eager', 'Keen', 'Mellow', 'Nimble'];
const ANIMALS = ['Otter', 'Falcon', 'Tiger', 'Lynx', 'Heron', 'Wolf', 'Fox', 'Orca', 'Raven', 'Bison', 'Crane', 'Marten', 'Gecko', 'Mako', 'Ibis'];
const generateHandle = (): string =>
  `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]} ${ANIMALS[Math.floor(Math.random() * ANIMALS.length)]}`;

// Create + share the user's PredictManager. deposit/withdraw on it assert sender == owner, so it
// must be created by whoever signs the plays: dev = the operator, privy = the user's embedded wallet,
// wallet-connect = the server-held custodial wallet. Returns the shared manager id from object changes.
async function createManagerForUser(user: User): Promise<string> {
  const tx = new Transaction();
  buildCreateManager(tx);
  const exec =
    user.provider !== 'wallet' && AUTH_MODE === 'dev'
      ? await executeAsOperator(tx, 'create_manager')
      : await executeForUser(tx, userContext(user));
  const created = exec.objectChanges.find(
    (c) => c.type === 'created' && c.objectType?.includes('::predict_manager::PredictManager'),
  );
  if (!created?.objectId) throw new Error('create_manager: PredictManager id not found in object changes');
  return created.objectId;
}

export type EnsureUserParams = {
  address: string;
  provider: 'dev' | 'privy';
  email?: string | null;
  privyUserId?: string | null;
  suiPublicKey?: string | null;
  privyWalletId?: string | null;
  twitter?: { username: string; subject: string; name: string | null } | null;
};

// Idempotent onboarding for the address-keyed modes (dev / privy). Safe to call on every login.
export async function ensureUser(params: EnsureUserParams): Promise<User> {
  const { address, provider, email, privyUserId, suiPublicKey, privyWalletId, twitter } = params;

  // Only write the privy identity fields when present, so a dev login never nulls them. Unlinking X
  // goes through POST /auth/link/refresh (which writes an explicit null), not here.
  const privyFields = {
    ...(privyUserId ? { privyUserId } : {}),
    ...(suiPublicKey ? { suiPublicKey } : {}),
    ...(privyWalletId ? { privyWalletId } : {}),
    ...(twitter ? { twitterUsername: twitter.username.toLowerCase(), twitterSubject: twitter.subject, twitterName: twitter.name } : {}),
  };

  const user = await prismaQuery.user.upsert({
    where: { address },
    update: { provider, lastSignIn: new Date(), ...(email ? { email } : {}), ...privyFields },
    create: { address, provider, displayName: generateHandle(), email: email ?? null, lastSignIn: new Date(), ...privyFields },
  });

  return provisionUser(user);
}

// Idempotent onboarding for wallet-connect (custodial play-wallet model). Keyed by the connected
// external wallet (walletAuthAddress); on first sign-in we mint a server-held custodial play wallet,
// whose Sui address becomes user.address (so chips/funding/manager all flow through the existing
// pipeline unchanged). The connected wallet itself never signs a transaction here.
export async function ensureWalletUser(walletAuthAddress: string): Promise<User> {
  const authAddr = normalizeSuiAddress(walletAuthAddress);
  let user = await prismaQuery.user.findUnique({ where: { walletAuthAddress: authAddr } });
  if (!user) {
    const wallet = generateCustodialWallet();
    user = await prismaQuery.user.create({
      data: {
        address: wallet.address,
        provider: 'wallet',
        displayName: generateHandle(),
        walletAuthAddress: authAddr,
        playWalletSecret: wallet.encryptedSecret,
        lastSignIn: new Date(),
      },
    });
  } else {
    user = await prismaQuery.user.update({ where: { id: user.id }, data: { lastSignIn: new Date() } });
  }
  return provisionUser(user);
}

// Whether the user has what createManagerForUser needs to sign: dev = the operator; privy = the
// embedded wallet + session signer; wallet = the custodial key. If not ready, the manager is left
// null and retried on the next login.
function managerReadyToCreate(user: User): boolean {
  if (user.provider === 'wallet') return Boolean(user.playWalletSecret);
  if (user.provider === 'privy') return Boolean(user.privyWalletId && user.suiPublicKey);
  return AUTH_MODE === 'dev'; // dev provider
}

// Shared provisioning, idempotent: empty stats row, free chips once, free gas (when unsponsored), and
// the PredictManager. Runs for every login regardless of identity mode, and is also the in-place
// self-heal for a re-armed session (POST /auth/heal), so it must stay safe to call repeatedly.
export async function provisionUser(user: User): Promise<User> {
  // Empty stats row so the menu reads cleanly from the first login.
  await prismaQuery.userStats.upsert({ where: { userId: user.id }, update: {}, create: { userId: user.id } });

  // Free starting chips, exactly once. Paid from the treasury reserve (transferDusdc) so chips never
  // come off the operator key; falls back to an operator mint when no treasury is configured.
  if (!user.dusdcFunded) {
    await transferDusdc(user.address, STARTING_BALANCE);
    user = await prismaQuery.user.update({ where: { id: user.id }, data: { dusdcFunded: true } });
  }

  // Free SUI for gas, ONLY when gas sponsorship is off. With a sponsor, every play is paid from the
  // sponsor's address balance, so users never hold SUI. Without one, fund each user once then top up
  // below the floor so they can pay their own play gas. Always a no-op in dev mode (operator signs).
  if (!SPONSOR_ENABLED && (await ensureSuiGas(user.address, user.suiGasFunded))) {
    user = await prismaQuery.user.update({ where: { id: user.id }, data: { suiGasFunded: true } });
  }

  // Real mode (testnet): there is no PredictManager. The per-owner AccountWrapper is derived + created
  // lazily inside the first mint (buildMintPlay folds new+share), self-heals a stale cache, and its id
  // is cached on User.predictWrapperId after that first create, so onboarding does no wrapper work here.
  if (IS_REAL_PREDICT) return user;

  // Self-heal a dead manager. A devnet reset/redeploy deletes the user's PredictManager while the
  // republished package survives, leaving a stale id in the DB. Left alone, every login crashes in
  // toUserDTO's balance read against an object that no longer exists (the AUTH_VERIFY_FAILED "Object
  // 0x.. not found" loop). Detect the gone manager and clear it so the create block below re-mints a
  // fresh one. managerExists rethrows a real node/chain outage, so we only null on a true not-found.
  if (user.predictManagerId && !(await managerExists(user.predictManagerId))) {
    // A manager is only ever deleted by a devnet reset/redeploy, never by gameplay (deposit/withdraw
    // keep it), so a gone manager is a reliable, un-farmable "this whole deploy is stale" signal. Null
    // it so the block below re-mints one on the live deploy. If the user's starting DUSDC died with
    // that deploy too (wallet now reads 0 on the live coin type), clear dusdcFunded/suiGasFunded so
    // the chips + gas re-mint as well. Gate that on an actually-empty wallet: a user whose chips
    // survived the redeploy (they were minted on the current DUSDC package, so still read > 0) keeps
    // them and is not double-funded. Safe against farming because a live manager, held by a player who
    // merely lost every chip, is never deleted, so this branch can't fire from gameplay.
    const chipsGone = (await getDusdcBalanceRaw(user.address)) === 0n;
    console.warn(
      `[auth] stale manager ${user.predictManagerId} gone for ${user.provider} ${user.address}, re-provisioning${chipsGone ? ' + re-funding chips' : ''}`,
    );
    user = await prismaQuery.user.update({
      where: { id: user.id },
      data: { predictManagerId: null, ...(chipsGone ? { dusdcFunded: false, suiGasFunded: false } : {}) },
    });
  }

  // PredictManager. dev creates it eagerly (operator-owned + signed). privy/wallet need a user-signed
  // tx, so they require their signer ready (see managerReadyToCreate); if not yet, leave it null and
  // retry on the next login.
  if (!user.predictManagerId && managerReadyToCreate(user)) {
    try {
      const managerId = await createManagerForUser(user);
      user = await prismaQuery.user.update({ where: { id: user.id }, data: { predictManagerId: managerId } });
    } catch (e) {
      if (user.provider === 'dev') throw e; // dev must have a manager to play
      // Loud, not swallowed: this is the exact reason /auth/heal can't restore a re-armed session.
      // Most often the backend isn't on the fresh deploy (the tx aborts against a dead package), or
      // the user's wallet is out of gas. Findable in the box logs to tell apart from a client issue.
      console.error(
        `[auth] manager creation FAILED for ${user.provider} ${user.address}:`,
        e instanceof Error ? e.message : e,
      );
    }
  } else if (!user.predictManagerId) {
    // Can't even attempt it: the user's signer isn't ready (privy walletId/pubkey or custodial key
    // missing). They'll re-provision once those land on a fresh sign-in.
    console.warn(`[auth] manager creation skipped for ${user.provider} ${user.address}: signer not ready`);
  }

  return user;
}

// Mint the session JWT. Payload matches the existing authMiddleware (reads userId).
export const mintToken = (user: User): string =>
  jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions);

// Resolve a user from a raw JWT. Used by the SSE routes, where EventSource cannot set an
// Authorization header so the token arrives in the query string. Returns null if invalid.
export async function userFromToken(token: string): Promise<User | null> {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId?: string };
    if (!payload.userId) return null;
    return await prismaQuery.user.findUnique({ where: { id: payload.userId } });
  } catch {
    return null;
  }
}

// Fresh public view of a user, including the live on-chain DUSDC balance. Chips live in the
// wallet (onboarding mint) and migrate into the PredictManager as plays run, so the spendable
// balance is the sum of both.
export async function toUserDTO(user: User): Promise<UserDTO> {
  const [wallet, manager] = await Promise.all([
    getDusdcBalanceRaw(user.address),
    // Real mode: chips live in the wrapper's internal balance (0 until the first play creates it); fork
    // mode: in the PredictManager. Tolerate a vanished object (devnet reset): count it as 0 here instead
    // of 500ing /me mid-session; the stale id is cleared + re-provisioned on the next login/heal.
    IS_REAL_PREDICT
      ? readUserChipsRaw(user.address, user.predictWrapperId).catch(() => 0n)
      : user.predictManagerId
        ? getManagerBalanceRaw(user.predictManagerId).catch((e) => {
            if (isChainUnavailableError(e)) return 0n;
            throw e;
          })
        : Promise.resolve(0n),
  ]);
  return {
    id: user.id,
    address: user.address,
    displayName: user.displayName,
    username: user.username,
    email: user.email ?? null,
    twitter: user.twitterUsername ? { username: user.twitterUsername, name: user.twitterName ?? null } : null,
    provider: user.provider === 'privy' || user.provider === 'wallet' ? user.provider : 'dev',
    walletAuthAddress: user.walletAuthAddress ?? undefined,
    balance: fromDusdcRaw(wallet + manager).toFixed(2),
    // Real mode: the wrapper is created lazily + self-heals on the first play, so the account is always
    // ready to play (no manager to provision first). Fork mode: ready once the PredictManager exists.
    managerReady: IS_REAL_PREDICT ? true : Boolean(user.predictManagerId),
    settings: {
      sound: user.soundEnabled,
      haptics: user.hapticsEnabled,
      reducedMotion: user.reducedMotion,
      theme: user.theme,
    },
  };
}
