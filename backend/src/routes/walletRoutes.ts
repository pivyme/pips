// Wallet management routes. Withdraw DUSDC from the user's balance (wallet + manager chips) to any
// Sui address, server-signed for the user. Deposits need no route: the user's address just receives.

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { handleError } from '../utils/errorHandler.ts';
import { withdrawDusdc, WalletError, httpStatusForWalletError } from '../services/wallet.ts';

export const walletRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.post('/withdraw', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { recipient?: string; amount?: string | number };
    try {
      const result = await withdrawDusdc(request.user!, body.recipient ?? '', body.amount ?? '');
      return reply.code(200).send({ success: true, error: null, data: result });
    } catch (error) {
      if (error instanceof WalletError) return handleError(reply, httpStatusForWalletError(error.code), error.message, error.code);
      return handleError(reply, 500, 'Could not complete the withdrawal', 'WITHDRAW_FAILED', error as Error);
    }
  });

  done();
};
