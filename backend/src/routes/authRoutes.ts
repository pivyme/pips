import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { validateRequiredFields } from '../utils/validationUtils.ts';
import { handleError, handleNotFoundError } from '../utils/errorHandler.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { AUTH_MODE, WALLET_AUTH_ENABLED } from '../config/main-config.ts';
import { operatorAddress } from '../lib/sui/signer.ts';
import { isChainUnavailableError } from '../lib/sui/client.ts';
import { verifyPrivyToken, provisionServerSuiWallet, fetchPrivyEmail } from '../lib/sui/privy.ts';
import { issueWalletNonce, verifyWalletSignature } from '../lib/sui/walletAuth.ts';
import { ensureUser, ensureWalletUser, mintToken, toUserDTO } from '../services/auth.ts';

// A Sui address that is shaped right (0x + hex) and valid once normalized.
const isAddress = (a: string): boolean => /^0x[0-9a-fA-F]+$/.test(a) && isValidSuiAddress(normalizeSuiAddress(a));

// One exit for a failed sign-in. When the failure is our Predict deployment being gone (the test
// chain was wiped, see isChainUnavailableError), return a stable CHAIN_UNAVAILABLE code so the door
// shows the "we're refreshing, try demo" sheet. The code is the only channel in prod (error details
// are stripped there), so the meaning has to ride the code, not the message. Anything else keeps the
// caller's own generic failure code.
const failSignIn = (reply: FastifyReply, error: unknown, code: string, message: string): Promise<FastifyReply> =>
  isChainUnavailableError(error)
    ? handleError(reply, 503, "Sui Devnet was reset, so PIPS is redeploying. It's usually back within a couple of hours. You can play demo mode in the meantime.", 'CHAIN_UNAVAILABLE', error as Error)
    : handleError(reply, 500, message, code, error as Error);

export const authRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // dev mode: auto-login the operator wallet. The backend is the user and signs its plays.
  app.post('/dev', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (AUTH_MODE !== 'dev') return handleNotFoundError(reply, 'Route');
    try {
      const user = await ensureUser({ address: operatorAddress, provider: 'dev' });
      return reply.code(200).send({ success: true, error: null, data: { token: mintToken(user), user: await toUserDTO(user) } });
    } catch (error) {
      return failSignIn(reply, error, 'AUTH_DEV_FAILED', 'Could not sign in');
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
      // Read the email from Privy by user id (covers Google sign-in, which the client can't report).
      // Fall back to whatever the client sent so we never regress an email we'd otherwise have.
      const email = (await fetchPrivyEmail(privyUserId)) ?? body.email ?? null;
      const user = await ensureUser({
        address: wallet.address,
        provider: 'privy',
        email,
        privyUserId,
        suiPublicKey: wallet.publicKey,
        privyWalletId: wallet.walletId,
      });
      return reply.code(200).send({ success: true, error: null, data: { token: mintToken(user), user: await toUserDTO(user) } });
    } catch (error) {
      return failSignIn(reply, error, 'AUTH_VERIFY_FAILED', 'Could not finish sign-in');
    }
  });

  // wallet-connect mode: issue the login challenge the external Sui wallet must sign. Off unless
  // WALLET_AUTH_ENABLED, independent of AUTH_MODE (it coexists with privy social login).
  app.post('/wallet/nonce', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!WALLET_AUTH_ENABLED) return handleNotFoundError(reply, 'Route');
    const body = (request.body ?? {}) as { address?: string };
    const address = typeof body.address === 'string' ? body.address.trim() : '';
    if (!isAddress(address)) return handleError(reply, 400, 'Enter a valid Sui address', 'WALLET_ADDRESS_INVALID');
    return reply.code(200).send({ success: true, error: null, data: issueWalletNonce(address) });
  });

  // wallet-connect mode: verify the signed challenge, provision (or reuse) the user's custodial play
  // wallet keyed by the connected wallet, onboard, and mint our JWT. The connected wallet is the
  // login identity; all on-chain play work runs through the server-held custodial wallet.
  app.post('/wallet/verify', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!WALLET_AUTH_ENABLED) return handleNotFoundError(reply, 'Route');
    const body = (request.body ?? {}) as { address?: string; signature?: string };
    const valid = await validateRequiredFields(body as Record<string, unknown>, ['address', 'signature'], reply);
    if (valid !== true) return;
    const address = String(body.address).trim();
    if (!isAddress(address)) return handleError(reply, 400, 'Enter a valid Sui address', 'WALLET_ADDRESS_INVALID');

    const ok = await verifyWalletSignature(address, String(body.signature));
    if (!ok) return handleError(reply, 401, 'Could not verify your wallet signature', 'WALLET_SIG_INVALID');

    try {
      const user = await ensureWalletUser(address);
      return reply.code(200).send({ success: true, error: null, data: { token: mintToken(user), user: await toUserDTO(user) } });
    } catch (error) {
      return failSignIn(reply, error, 'AUTH_VERIFY_FAILED', 'Could not finish sign-in');
    }
  });

  // current user, fresh (live balance + manager state).
  app.get('/me', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.code(200).send({ success: true, error: null, data: { user: await toUserDTO(request.user!) } });
    } catch (error) {
      // A returning session resolves through here on boot; classify the test-chain wipe the same way
      // so the door shows the refreshing sheet instead of a dead generic error.
      return failSignIn(reply, error, 'AUTH_ME_FAILED', 'Could not load profile');
    }
  });

  // Set the user's unique handle (the onboarding username step). Case-insensitive uniqueness with
  // the @unique column as the hard backstop. Stored display-cased.
  app.patch('/me', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { username?: string };
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return handleError(reply, 400, 'Use 3 to 20 letters, numbers, or underscores', 'USERNAME_INVALID');
    }
    const me = request.user!;
    try {
      const taken = await prismaQuery.user.findFirst({
        where: { username: { equals: username, mode: 'insensitive' }, NOT: { id: me.id } },
        select: { id: true },
      });
      if (taken) return handleError(reply, 409, 'That handle is taken', 'USERNAME_TAKEN');
      const updated = await prismaQuery.user.update({ where: { id: me.id }, data: { username } });
      return reply.code(200).send({ success: true, error: null, data: { user: await toUserDTO(updated) } });
    } catch (error) {
      // Unique-violation backstop for the case-race the pre-check can't cover.
      if ((error as { code?: string })?.code === 'P2002') {
        return handleError(reply, 409, 'That handle is taken', 'USERNAME_TAKEN');
      }
      return handleError(reply, 500, 'Could not save your handle', 'USERNAME_SAVE_FAILED', error as Error);
    }
  });

  done();
};
