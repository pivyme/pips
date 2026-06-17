// Auth + onboarding. One JWT plumbing, two identity modes (dev / enoki). ensureUser is the
// idempotent onboarding called from both login paths: it upserts the row, seeds an empty
// stats row, mints the free starting chips exactly once, and (dev only) creates the user's
// PredictManager. Never re-mints chips, never makes a second manager. See 04-AUTH.md.

import jwt from 'jsonwebtoken';
import { Transaction } from '@mysten/sui/transactions';

import type { User } from '../../prisma/generated/client.js';
import { prismaQuery } from '../lib/prisma.ts';
import { AUTH_MODE, JWT_SECRET, JWT_EXPIRES_IN, STARTING_BALANCE } from '../config/main-config.ts';
import { getAlphanumericId } from '../utils/miscUtils.ts';
import { mintDusdc, getDusdcBalanceRaw } from '../lib/sui/dusdc.ts';
import { executeAsOperator } from '../lib/sui/execute.ts';
import { buildCreateManager, getManagerBalanceRaw } from '../lib/sui/predict.ts';
import { fromDusdcRaw } from '../lib/sui/config.ts';
import type { UserDTO } from '../types/api.ts';

// Friendly two-word handle, e.g. "Lucky Otter". displayName is not unique, collisions are fine.
const ADJECTIVES = ['Lucky', 'Bold', 'Swift', 'Calm', 'Brave', 'Sly', 'Quiet', 'Wild', 'Sharp', 'Bright', 'Cool', 'Eager', 'Keen', 'Mellow', 'Nimble'];
const ANIMALS = ['Otter', 'Falcon', 'Tiger', 'Lynx', 'Heron', 'Wolf', 'Fox', 'Orca', 'Raven', 'Bison', 'Crane', 'Marten', 'Gecko', 'Mako', 'Ibis'];
const generateHandle = (): string =>
  `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]} ${ANIMALS[Math.floor(Math.random() * ANIMALS.length)]}`;

// The exact bytes the client signs in the enoki handshake. Keep this in lockstep with the
// web auth flow, the verifier reconstructs the same string from the stored nonce.
export const buildAuthMessage = (nonce: string): string => `Sign in to Pips\n\nNonce: ${nonce}`;

// dev only: create + share the user's PredictManager now (the backend signs every play, so
// the operator owns it). Returns the shared manager id read from the tx object changes.
async function createDevManager(): Promise<string> {
  const tx = new Transaction();
  buildCreateManager(tx);
  const res = await executeAsOperator(tx, 'create_manager');
  const created = res.objectChanges.find(
    (c) => c.type === 'created' && c.objectType?.includes('::predict_manager::PredictManager'),
  );
  if (!created?.objectId) throw new Error('create_manager: PredictManager id not found in object changes');
  return created.objectId;
}

// Idempotent onboarding. Safe to call on every login.
export async function ensureUser(params: { address: string; provider: 'dev' | 'enoki'; email?: string | null }): Promise<User> {
  const { address, provider, email } = params;

  let user = await prismaQuery.user.upsert({
    where: { address },
    update: { provider, lastSignIn: new Date(), ...(email ? { email } : {}) },
    create: { address, provider, displayName: generateHandle(), email: email ?? null, lastSignIn: new Date() },
  });

  // Empty stats row so the menu reads cleanly from the first login.
  await prismaQuery.userStats.upsert({ where: { userId: user.id }, update: {}, create: { userId: user.id } });

  // Free starting chips, exactly once.
  if (!user.dusdcFunded) {
    await mintDusdc(address, STARTING_BALANCE);
    user = await prismaQuery.user.update({ where: { id: user.id }, data: { dusdcFunded: true } });
  }

  // PredictManager: dev creates it eagerly (operator-signed). enoki defers to the first
  // sponsored play, where it lands in one tx signed by the user's own zkLogin key.
  if (!user.predictManagerId && AUTH_MODE === 'dev') {
    const managerId = await createDevManager();
    user = await prismaQuery.user.update({ where: { id: user.id }, data: { predictManagerId: managerId } });
  }

  return user;
}

// enoki: store a fresh challenge nonce on the user row (create the row if this is their
// first touch). No onboarding here, that runs on verify once the signature checks out.
export async function setNonce(address: string): Promise<string> {
  const nonce = getAlphanumericId(32);
  await prismaQuery.user.upsert({
    where: { address },
    update: { nonce },
    create: { address, provider: 'enoki', displayName: generateHandle(), nonce },
  });
  return nonce;
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
// wallet (onboarding mint) and migrate into the PredictManager as plays run, so the
// spendable balance is the sum of both.
export async function toUserDTO(user: User): Promise<UserDTO> {
  const [wallet, manager] = await Promise.all([
    getDusdcBalanceRaw(user.address),
    user.predictManagerId ? getManagerBalanceRaw(user.predictManagerId) : Promise.resolve(0n),
  ]);
  return {
    id: user.id,
    address: user.address,
    displayName: user.displayName,
    provider: user.provider === 'enoki' ? 'enoki' : 'dev',
    balance: fromDusdcRaw(wallet + manager).toFixed(2),
    managerReady: Boolean(user.predictManagerId),
    settings: {
      sound: user.soundEnabled,
      haptics: user.hapticsEnabled,
      reducedMotion: user.reducedMotion,
    },
  };
}
