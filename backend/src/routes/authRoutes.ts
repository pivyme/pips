import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { validateRequiredFields } from '../utils/validationUtils.ts';
import { handleError, handleNotFoundError } from '../utils/errorHandler.ts';
import { AUTH_MODE } from '../config/main-config.ts';
import { operatorAddress } from '../lib/sui/signer.ts';
import { verifyWalletSignature } from '../lib/sui/verify.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { buildAuthMessage, ensureUser, mintToken, setNonce, toUserDTO } from '../services/auth.ts';

export const authRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // dev mode: auto-login the operator wallet. The backend is the user and signs its plays.
  app.post('/dev', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (AUTH_MODE !== 'dev') return handleNotFoundError(reply, 'Route');
    try {
      const user = await ensureUser({ address: operatorAddress, provider: 'dev' });
      return reply.code(200).send({ success: true, error: null, data: { token: mintToken(user), user: await toUserDTO(user) } });
    } catch (error) {
      return handleError(reply, 500, 'Could not sign in', 'AUTH_DEV_FAILED', error as Error);
    }
  });

  // enoki mode: hand the client a challenge nonce to sign with its zkLogin key.
  app.post('/nonce', async (request: FastifyRequest, reply: FastifyReply) => {
    if (AUTH_MODE !== 'enoki') return handleNotFoundError(reply, 'Route');
    const body = (request.body ?? {}) as { address?: string };
    const valid = await validateRequiredFields(body as Record<string, unknown>, ['address'], reply);
    if (valid !== true) return;
    try {
      const nonce = await setNonce(body.address as string);
      return reply.code(200).send({ success: true, error: null, data: { nonce } });
    } catch (error) {
      return handleError(reply, 500, 'Could not start sign-in', 'AUTH_NONCE_FAILED', error as Error);
    }
  });

  // enoki mode: verify the signed nonce, onboard, mint the JWT.
  app.post('/verify', async (request: FastifyRequest, reply: FastifyReply) => {
    if (AUTH_MODE !== 'enoki') return handleNotFoundError(reply, 'Route');
    const body = (request.body ?? {}) as { address?: string; signature?: string };
    const valid = await validateRequiredFields(body as Record<string, unknown>, ['address', 'signature'], reply);
    if (valid !== true) return;

    const address = body.address as string;
    const user = await prismaQuery.user.findUnique({ where: { address } });
    if (!user || !user.nonce) {
      return handleError(reply, 400, 'Sign-in expired, please try again', 'NONCE_INVALID');
    }

    try {
      await verifyWalletSignature(buildAuthMessage(user.nonce), body.signature as string, address);
    } catch (error) {
      return handleError(reply, 401, 'Signature did not match', 'SIGNATURE_INVALID', error as Error);
    }

    try {
      await prismaQuery.user.update({ where: { id: user.id }, data: { nonce: null } });
      const onboarded = await ensureUser({ address, provider: 'enoki' });
      return reply.code(200).send({ success: true, error: null, data: { token: mintToken(onboarded), user: await toUserDTO(onboarded) } });
    } catch (error) {
      return handleError(reply, 500, 'Could not finish sign-in', 'AUTH_VERIFY_FAILED', error as Error);
    }
  });

  // current user, fresh (live balance + manager state).
  app.get('/me', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.code(200).send({ success: true, error: null, data: { user: await toUserDTO(request.user!) } });
    } catch (error) {
      return handleError(reply, 500, 'Could not load profile', 'AUTH_ME_FAILED', error as Error);
    }
  });

  done();
};
