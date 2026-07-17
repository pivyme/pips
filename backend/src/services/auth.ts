// Auth + onboarding. One JWT plumbing, two identity modes (dev / privy).
// ensureUser is the idempotent onboarding path: upsert, seed stats, mint starting chips/gas once, create the PredictManager. See LUCKY.md §6-7.

import jwt from 'jsonwebtoken';
import { customAlphabet } from 'nanoid';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import type { User } from '../../prisma/generated/client.js';
import { prismaQuery } from '../lib/prisma.ts';
import { JWT_SECRET, JWT_EXPIRES_IN, STARTING_BALANCE } from '../config/main-config.ts';
import { transferDusdc, getDusdcBalanceRaw } from '../lib/sui/dusdc.ts';
import { generateCustodialWallet } from '../lib/sui/custodial.ts';
import { readUserChipsRaw } from '../lib/sui/predict-real.ts';
import { fromDusdcRaw } from '../lib/sui/config.ts';
import { effectiveAvatar } from '../utils/miscUtils.ts';
import type { UserDTO } from '../types/api.ts';

// Friendly two-word handle, e.g. "Lucky Otter". displayName is not unique, collisions are fine.
const ADJECTIVES = ['Lucky', 'Bold', 'Swift', 'Calm', 'Brave', 'Sly', 'Quiet', 'Wild', 'Sharp', 'Bright', 'Cool', 'Eager', 'Keen', 'Mellow', 'Nimble'];
const ANIMALS = ['Otter', 'Falcon', 'Tiger', 'Lynx', 'Heron', 'Wolf', 'Fox', 'Orca', 'Raven', 'Bison', 'Crane', 'Marten', 'Gecko', 'Mako', 'Ibis'];
const generateHandle = (): string =>
  `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]} ${ANIMALS[Math.floor(Math.random() * ANIMALS.length)]}`;

// Referral code alphabet: no 0/O or 1/l/I, so a code read off a screen is never ambiguous.
// getAlphanumericId (miscUtils.ts) uses the full alphanumeric set including those, so this stays its own.
const generateReferralCode = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz', 8);

// Resolves `@username` or a bare referralCode to the referring user. Never throws, an
// unknown or malformed token just means no attribution.
export async function resolveReferrer(
  token: string | null | undefined,
): Promise<{ id: string; username: string | null; referralAnon: boolean } | null> {
  if (!token) return null;
  try {
    return token.startsWith('@')
      ? await prismaQuery.user.findFirst({
          where: { username: { equals: token.slice(1), mode: 'insensitive' } },
          select: { id: true, username: true, referralAnon: true },
        })
      : await prismaQuery.user.findUnique({
          where: { referralCode: token },
          select: { id: true, username: true, referralAnon: true },
        });
  } catch {
    return null;
  }
}

export type EnsureUserParams = {
  address: string;
  provider: 'dev' | 'privy';
  email?: string | null;
  privyUserId?: string | null;
  suiPublicKey?: string | null;
  privyWalletId?: string | null;
  twitter?: { username: string; subject: string; name: string | null } | null;
  referralCode?: string | null;
};

// Idempotent onboarding for the address-keyed modes (dev / privy). Safe to call on every login.
export async function ensureUser(params: EnsureUserParams): Promise<User> {
  const { address, provider, email, privyUserId, suiPublicKey, privyWalletId, twitter, referralCode } = params;

  // Only write the privy identity fields when present, so a dev login never nulls them. Unlinking X
  // goes through POST /auth/link/refresh (which writes an explicit null), not here.
  const privyFields = {
    ...(privyUserId ? { privyUserId } : {}),
    ...(suiPublicKey ? { suiPublicKey } : {}),
    ...(privyWalletId ? { privyWalletId } : {}),
    ...(twitter ? { twitterUsername: twitter.username.toLowerCase(), twitterSubject: twitter.subject, twitterName: twitter.name } : {}),
  };

  // Attribution only happens on account creation (the `create` branch below); an existing user
  // clicking a friend's link is never retroactively marked as referred. Resolved up front since upsert can't branch its `where`.
  const referrer = await resolveReferrer(referralCode);

  const user = await prismaQuery.user.upsert({
    where: { address },
    update: { provider, lastSignIn: new Date(), ...(email ? { email } : {}), ...privyFields },
    create: {
      address,
      provider,
      displayName: generateHandle(),
      email: email ?? null,
      lastSignIn: new Date(),
      ...privyFields,
      ...(referrer ? { referredById: referrer.id, referredAt: new Date() } : {}),
    },
  });

  return provisionUser(user);
}

// Idempotent onboarding for wallet-connect (custodial play-wallet model), keyed by the connected external wallet (walletAuthAddress).
// First sign-in mints a server-held custodial play wallet whose Sui address becomes user.address; the connected wallet itself never signs a transaction here.
export async function ensureWalletUser(walletAuthAddress: string, referralCode?: string | null): Promise<User> {
  const authAddr = normalizeSuiAddress(walletAuthAddress);
  let user = await prismaQuery.user.findUnique({ where: { walletAuthAddress: authAddr } });
  if (!user) {
    const wallet = generateCustodialWallet();
    const referrer = await resolveReferrer(referralCode);
    user = await prismaQuery.user.create({
      data: {
        address: wallet.address,
        provider: 'wallet',
        displayName: generateHandle(),
        walletAuthAddress: authAddr,
        playWalletSecret: wallet.encryptedSecret,
        lastSignIn: new Date(),
        ...(referrer ? { referredById: referrer.id, referredAt: new Date() } : {}),
      },
    });
  } else {
    user = await prismaQuery.user.update({ where: { id: user.id }, data: { lastSignIn: new Date() } });
  }
  return provisionUser(user);
}

// Shared provisioning, idempotent: empty stats row, referral code, free starting chips once.
// Runs on every login and is also the self-heal for a re-armed session (POST /auth/heal), so it must stay safe to call repeatedly.
// The per-owner AccountWrapper is derived + created lazily inside the first mint (predict-real), so onboarding does no wrapper work.
export async function provisionUser(user: User): Promise<User> {
  // Empty stats row so the menu reads cleanly from the first login.
  await prismaQuery.userStats.upsert({ where: { userId: user.id }, update: {}, create: { userId: user.id } });

  // Referral code, exactly once. Runs on every login so existing users backfill a code on their next sign-in with no migration.
  // Retries on a P2002 unique collision (rare given the 8-char alphabet, but cheap to guard).
  if (!user.referralCode) {
    for (let attempt = 0; attempt < 5 && !user.referralCode; attempt++) {
      try {
        user = await prismaQuery.user.update({ where: { id: user.id }, data: { referralCode: generateReferralCode() } });
      } catch (e) {
        if ((e as { code?: string })?.code !== 'P2002') throw e;
      }
    }
  }

  // Free starting chips, exactly once, paid from the treasury reserve (transferDusdc). DUSDC is not
  // mintable on Mysten's Predict, so an unfunded treasury surfaces loudly here.
  if (!user.dusdcFunded) {
    await transferDusdc(user.address, STARTING_BALANCE);
    user = await prismaQuery.user.update({ where: { id: user.id }, data: { dusdcFunded: true } });
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

// Fresh public view of a user, including the live on-chain DUSDC balance. Chips live in the wallet
// (onboarding mint) and migrate into the PredictManager as plays run, so spendable balance is the sum of both.
export async function toUserDTO(user: User): Promise<UserDTO> {
  const [wallet, manager] = await Promise.all([
    getDusdcBalanceRaw(user.address),
    // Chips live in the wrapper's internal balance (0 until the first play creates it). Tolerate a
    // vanished object as 0 here instead of 500ing /me mid-session.
    readUserChipsRaw(user.address, user.predictWrapperId).catch(() => 0n),
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
    avatarUrl: effectiveAvatar(user),
    customAvatar: user.avatarUrl != null,
    balance: fromDusdcRaw(wallet + manager).toFixed(2),
    // The wrapper is created lazily + self-heals on the first play, so the account is always ready to play.
    managerReady: true,
    settings: {
      sound: user.soundEnabled,
      haptics: user.hapticsEnabled,
      reducedMotion: user.reducedMotion,
      confirmTrades: user.confirmTrades,
      theme: user.theme,
    },
  };
}
