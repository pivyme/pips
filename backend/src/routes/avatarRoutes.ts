// Avatar routes: upload / replace and remove the custom profile picture. The client pre-shrinks to a
// 500x500 webp and sends it base64 in a JSON body (~30-90KB, well under the 1MB bodyLimit, so no
// multipart). Bytes are validated server-side (declared mime + a RIFF/WEBP magic sniff + a hard cap),
// never trusted by their label. Storage is gated by AVATAR_UPLOADS_ENABLED: with no S3 creds these
// routes 503 cleanly and the app falls back to the PIPS identicon.

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { handleError } from '../utils/errorHandler.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { toUserDTO } from '../services/auth.ts';
import { putObject, deleteByUrl } from '../lib/s3.ts';
import {
  AVATAR_UPLOADS_ENABLED,
  S3_FOLDER_PREFIX,
  RATE_LIMIT_AVATAR_MAX,
  RATE_LIMIT_WINDOW,
} from '../config/main-config.ts';

const MAX_AVATAR_BYTES = 400_000; // server backstop; the client already shrinks to ~30-90KB

// Parse a `data:image/webp;base64,...` URL into raw bytes, or null if it isn't a well-formed webp.
// Checks the declared mime AND sniffs the RIFF/WEBP magic bytes, so a mislabeled payload is rejected.
function parseWebpDataUrl(image: unknown): Uint8Array | null {
  if (typeof image !== 'string') return null;
  const m = /^data:image\/webp;base64,([A-Za-z0-9+/=]+)$/.exec(image.trim());
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  // RIFF....WEBP container: 'RIFF' at bytes 0-3, 'WEBP' at bytes 8-11.
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  return new Uint8Array(buf);
}

export const avatarRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // Tight per-IP cap on the writes on top of auth. Cheap object, but no reason to allow a hammer.
  const avatarLimit = { rateLimit: { max: RATE_LIMIT_AVATAR_MAX, timeWindow: RATE_LIMIT_WINDOW } };

  // Upload / replace the custom avatar.
  app.post('/avatar', { preHandler: [authMiddleware], config: avatarLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!AVATAR_UPLOADS_ENABLED) return handleError(reply, 503, 'Avatar uploads are not available right now', 'UPLOADS_DISABLED');

    const { image } = (request.body ?? {}) as { image?: unknown };
    const bytes = parseWebpDataUrl(image);
    if (!bytes) return handleError(reply, 400, 'That image could not be read. Try another.', 'INVALID_IMAGE');
    if (bytes.byteLength > MAX_AVATAR_BYTES) return handleError(reply, 413, 'That image is too large.', 'IMAGE_TOO_LARGE');

    const user = request.user!;
    try {
      // Random per-user key: unique so a replace never overwrites, cache-busts, and can't be enumerated.
      const url = await putObject(`${S3_FOLDER_PREFIX}/avatars/${user.id}/${nanoid()}.webp`, bytes, 'image/webp');
      // Best-effort drop the previous custom object so replaces don't orphan (the default.svg is untouched).
      void deleteByUrl(user.avatarUrl);
      const updated = await prismaQuery.user.update({ where: { id: user.id }, data: { avatarUrl: url } });
      return reply.code(200).send({ success: true, error: null, data: { user: await toUserDTO(updated) } });
    } catch (error) {
      return handleError(reply, 500, 'Could not save that avatar. Try again.', 'AVATAR_UPLOAD_FAILED', error as Error);
    }
  });

  // Remove the custom avatar, reverting to the PIPS identicon.
  app.delete('/avatar', { preHandler: [authMiddleware], config: avatarLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    try {
      if (user.avatarUrl) void deleteByUrl(user.avatarUrl);
      const updated = await prismaQuery.user.update({ where: { id: user.id }, data: { avatarUrl: null } });
      return reply.code(200).send({ success: true, error: null, data: { user: await toUserDTO(updated) } });
    } catch (error) {
      return handleError(reply, 500, 'Could not remove the avatar. Try again.', 'AVATAR_REMOVE_FAILED', error as Error);
    }
  });

  done();
};
