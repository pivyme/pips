// Wallet management routes. Withdraw DUSDC from the user's balance (wallet + manager chips) to any
// Sui address, server-signed for the user. Deposits need no route: the user's address just receives.

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { handleError } from '../utils/errorHandler.ts';
import { withdrawDusdc, requestDusdc, WalletError, httpStatusForWalletError } from '../services/wallet.ts';
import { RATE_LIMIT_FAUCET_MAX, RATE_LIMIT_WITHDRAW_MAX, RATE_LIMIT_WINDOW } from '../config/main-config.ts';

export const walletRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // Per-IP rate limits on top of each route's per-user gate: withdraw is fund-moving and request-dusdc
  // already has a per-user FAUCET_COOLDOWN_MS, so this is a second IP-scoped gate against multi-account draining of the finite treasury.
  const withdrawLimit = { rateLimit: { max: RATE_LIMIT_WITHDRAW_MAX, timeWindow: RATE_LIMIT_WINDOW } };
  const faucetLimit = { rateLimit: { max: RATE_LIMIT_FAUCET_MAX, timeWindow: RATE_LIMIT_WINDOW } };

  app.post('/withdraw', { preHandler: [authMiddleware], config: withdrawLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { recipient?: string; amount?: string | number };
    try {
      const result = await withdrawDusdc(request.user!, body.recipient ?? '', body.amount ?? '');
      return reply.code(200).send({ success: true, error: null, data: result });
    } catch (error) {
      if (error instanceof WalletError) return handleError(reply, httpStatusForWalletError(error.code), error.message, error.code);
      return handleError(reply, 500, 'Could not complete the withdrawal', 'WITHDRAW_FAILED', error as Error);
    }
  });

  // Request DUSDC faucet: hand the user a fixed batch of test chips, rate-limited per user.
  app.post('/request-dusdc', { preHandler: [authMiddleware], config: faucetLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await requestDusdc(request.user!);
      return reply.code(200).send({ success: true, error: null, data: result });
    } catch (error) {
      if (error instanceof WalletError) return handleError(reply, httpStatusForWalletError(error.code), error.message, error.code);
      return handleError(reply, 500, 'Could not send test DUSDC', 'FAUCET_FAILED', error as Error);
    }
  });

  done();
};
