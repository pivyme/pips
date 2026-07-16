// The default avatar: a DiceBear bottts-neutral robot, generated ONCE per user and stored, never
// re-fetched. The SVG renders locally via the npm lib (no HTTP to DiceBear, ever); the seed is the
// user's Sui address, so the robot is deterministic and tied to the wallet (survives a DB reseed, the
// same wallet always maps to the same robot). Best-effort throughout: any gen or S3 failure returns
// null and the client falls back to a letter chip, and the next provision retries.

import { createAvatar } from '@dicebear/core';
import { botttsNeutral } from '@dicebear/collection';

import type { User } from '../../prisma/generated/client.js';
import { prismaQuery } from './prisma.ts';
import { putObject } from './s3.ts';
import { AVATAR_UPLOADS_ENABLED, S3_FOLDER_PREFIX } from '../config/main-config.ts';

// Ensure the user has a stored default-avatar URL. Idempotent: returns the existing one untouched,
// otherwise generates + uploads + persists it. Returns null when storage is off or a step fails.
export async function ensureDefaultAvatar(user: User): Promise<string | null> {
  if (user.avatarDefaultUrl) return user.avatarDefaultUrl;
  if (!AVATAR_UPLOADS_ENABLED) return null;

  try {
    const svg = createAvatar(botttsNeutral, { seed: user.address }).toString();
    const url = await putObject(`${S3_FOLDER_PREFIX}/avatars/${user.id}/default.svg`, svg, 'image/svg+xml');
    await prismaQuery.user.update({ where: { id: user.id }, data: { avatarDefaultUrl: url } });
    return url;
  } catch (e) {
    console.warn(`[avatar] default generate/store failed for ${user.id}:`, e instanceof Error ? e.message : e);
    return null;
  }
}
