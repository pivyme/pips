import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { validateRequiredFields } from '../utils/validationUtils.ts';
import { handleError, handleNotFoundError } from '../utils/errorHandler.ts';
import { AUTH_MODE } from '../config/main-config.ts';
import { operatorAddress } from '../lib/sui/signer.ts';
import { verifyPrivyToken, provisionServerSuiWallet } from '../lib/sui/privy.ts';
import { ensureUser, mintToken, toUserDTO } from '../services/auth.ts';

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

  // privy mode: the client signs in with Privy (Google/email) and sends only the access token. We
  // verify it, then provision (or reuse) a server-owned embedded Sui wallet keyed to the Privy user
  // (owned by the app authorization key so the server signs every play with no popup or client round
  // trip), onboard the user keyed by that Sui address, and mint our JWT.
  app.post('/privy/verify', async (request: FastifyRequest, reply: FastifyReply) => {
    if (AUTH_MODE !== 'privy') return handleNotFoundError(reply, 'Route');
    const body = (request.body ?? {}) as { token?: string; email?: string };
    const valid = await validateRequiredFields(body as Record<string, unknown>, ['token'], reply);
    if (valid !== true) return;

    let privyUserId: string;
    try {
      ({ privyUserId } = await verifyPrivyToken(body.token as string));
    } catch (error) {
      return handleError(reply, 401, 'Sign-in could not be verified', 'PRIVY_TOKEN_INVALID', error as Error);
    }

    try {
      const wallet = await provisionServerSuiWallet(privyUserId);
      const user = await ensureUser({
        address: wallet.address,
        provider: 'privy',
        email: body.email ?? null,
        privyUserId,
        suiPublicKey: wallet.publicKey,
        privyWalletId: wallet.walletId,
      });
      return reply.code(200).send({ success: true, error: null, data: { token: mintToken(user), user: await toUserDTO(user) } });
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
