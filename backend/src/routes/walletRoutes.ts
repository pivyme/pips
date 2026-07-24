// Wallet management routes. Send any held coin (DUSDC chips via the wallet+wrapper path, every other coin via
// a generic transfer for token recovery), the faucet/grant top-ups, the held-coin list + activity feed, and
// the on-demand deposit sync. Deposits themselves need no route: the user's address just receives.

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { handleError } from '../utils/errorHandler.ts';
import {
  withdrawCoin,
  requestDusdc,
  grantChips,
  getWalletCoins,
  getWalletTransactions,
  walletSync,
  WalletError,
  httpStatusForWalletError,
} from '../services/wallet.ts';
import { RATE_LIMIT_FAUCET_MAX, RATE_LIMIT_WITHDRAW_MAX, RATE_LIMIT_WINDOW } from '../config/main-config.ts';

export const walletRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // Per-IP rate limits on top of each route's per-user gate: withdraw is fund-moving and request-dusdc
  // already has a per-user FAUCET_COOLDOWN_MS, so this is a second IP-scoped gate against multi-account draining of the finite treasury.
  const withdrawLimit = { rateLimit: { max: RATE_LIMIT_WITHDRAW_MAX, timeWindow: RATE_LIMIT_WINDOW } };
  const faucetLimit = { rateLimit: { max: RATE_LIMIT_FAUCET_MAX, timeWindow: RATE_LIMIT_WINDOW } };

  app.post('/withdraw', { preHandler: [authMiddleware], config: withdrawLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { recipient?: string; amount?: string | number; coinType?: string };
    try {
      const result = await withdrawCoin(request.user!, body.recipient ?? '', body.amount ?? '', body.coinType ?? null);
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

  // Starter-chip grant: tops a player who can't afford the minimum stake back up to the starting grant.
  // Guarded server-side (cooldown + treasury floor); `granted` is null when skipped, never an error. Shares
  // the faucet's per-IP limit as a second gate against multi-account draining of the finite treasury.
  app.post('/grant', { preHandler: [authMiddleware], config: faucetLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await grantChips(request.user!);
      return reply.code(200).send({ success: true, error: null, data: result });
    } catch (error) {
      return handleError(reply, 500, 'Could not top up your chips', 'GRANT_FAILED', error as Error);
    }
  });

  // Every coin the wallet holds, resolved + priced, for the send picker + balance list.
  app.get('/coins', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await getWalletCoins(request.user!);
      return reply.code(200).send({ success: true, error: null, data: result });
    } catch (error) {
      return handleError(reply, 500, 'Could not read your coins', 'WALLET_COINS_FAILED', error as Error);
    }
  });

  // The activity feed: deposits/sends/faucet/grants, DB-backed (keyset paginated), newest first.
  app.get('/transactions', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as { limit?: string; cursor?: string };
    try {
      const limit = q.limit ? Number(q.limit) : undefined;
      const result = await getWalletTransactions(request.user!, { limit: Number.isFinite(limit) ? limit : undefined, cursor: q.cursor ?? null });
      return reply.code(200).send({ success: true, error: null, data: { transactions: result.items, nextCursor: result.nextCursor } });
    } catch (error) {
      return handleError(reply, 500, 'Could not read your activity', 'WALLET_TX_FAILED', error as Error);
    }
  });

  // On-demand deposit sync (the deposit-watch poll): scan the caller's address now, return any new incoming
  // rows. Throttled per-user in the service; a within-window call returns the last scan's rows without re-scanning.
  app.post('/sync', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { sinceMs?: number };
    try {
      const sinceMs = typeof body.sinceMs === 'number' && Number.isFinite(body.sinceMs) ? body.sinceMs : undefined;
      const result = await walletSync(request.user!, sinceMs);
      return reply.code(200).send({ success: true, error: null, data: result });
    } catch (error) {
      return handleError(reply, 500, 'Could not sync your wallet', 'WALLET_SYNC_FAILED', error as Error);
    }
  });

  done();
};
