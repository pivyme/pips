// Deposit drawer backend: the catalog + gate, and a live LI.FI quote proxy.
//
// We proxy rather than let the browser call li.quest directly for three reasons: the API key stays
// server-side (it exists to buy a per-key rate limit, which is worthless once anyone can lift it), the
// server stays the single source of truth for what is enabled, and toAddress gets stamped from the authed
// user instead of trusted from client state.
//
// Nothing here executes. Receiving the chip asset needs no route at all (the user's address just receives
// it); cross-chain execution is mainnet-gated and lives behind BRIDGE_EXECUTE_ENABLED.

import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { handleError } from '../utils/errorHandler.ts';
import {
  getDepositCatalog,
  getDepositQuote,
  getExecutableStep,
  getBridgeStatus,
  chainIdFor,
  SUI_CHAIN_ID,
  SUI_CHAIN_ID_STR,
  LifiError,
  httpStatusForLifiError,
  BRIDGE_ASSET,
} from '../lib/lifi.ts';
import { prismaQuery } from '../lib/prisma.ts';
import {
  BRIDGE_EXECUTE_ENABLED,
  DEPOSIT_MIN_USD,
  DEPOSIT_HARD_MIN_USD,
  FAUCET_AMOUNT,
  RATE_LIMIT_QUOTE_MAX,
  RATE_LIMIT_WINDOW,
  SUI_NETWORK,
} from '../config/main-config.ts';

// The chip that tops up the balance today. Testnet/fork play on DUSDC; mainnet's chip is real USDC, which
// is exactly what LI.FI delivers to Sui, so the two converge and the bridge lands the chip asset directly.
const CHIP_SYMBOL = SUI_NETWORK === 'mainnet' ? 'USDC' : 'DUSDC';

export const depositRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // Each quote hits an external API, so it carries a tighter per-IP cap than the global one.
  const quoteLimit = { rateLimit: { max: RATE_LIMIT_QUOTE_MAX, timeWindow: RATE_LIMIT_WINDOW } };

  // The drawer renders itself from this: catalog, chip asset, gate, and the faucet amount (network-scoped,
  // so the copy is driven from here instead of a hardcoded number that is already wrong on the live box).
  app.get('/options', { preHandler: [authMiddleware] }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const catalog = await getDepositCatalog(CHIP_SYMBOL);
      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          chipSymbol: CHIP_SYMBOL,
          chipNetwork: 'sui',
          bridgeAsset: BRIDGE_ASSET,
          executeEnabled: BRIDGE_EXECUTE_ENABLED,
          executeLockedReason: BRIDGE_EXECUTE_ENABLED ? null : 'mainnet_only',
          minUsd: DEPOSIT_MIN_USD,
          hardMinUsd: DEPOSIT_HARD_MIN_USD,
          faucetAmount: String(FAUCET_AMOUNT),
          ...catalog,
        },
      });
    } catch (error) {
      return handleError(reply, 500, 'Could not load deposit options', 'DEPOSIT_OPTIONS_FAILED', error as Error);
    }
  });

  // A live mainnet route preview. Works on testnet on purpose: the lookup is read-only and does not care
  // which chain we run on, so every number the player sees is real even while execution is parked.
  app.post('/quote', { preHandler: [authMiddleware], config: quoteLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { currency?: string; network?: string; amount?: string | number; toAddress?: string };

    // toAddress is the whole integration: get it wrong and the funds land with a stranger, irreversibly.
    // It is stamped from the authed user below, so a client-supplied one is refused outright rather than
    // merged or silently ignored, which keeps the failure loud if a caller ever starts sending one.
    if (body.toAddress != null) {
      return handleError(reply, 400, 'toAddress is set by the server', 'TO_ADDRESS_NOT_ACCEPTED');
    }

    const address = request.user?.address;
    if (!address) return handleError(reply, 409, 'Your wallet is not ready yet', 'ADDRESS_NOT_READY');

    const amount = String(body.amount ?? '').trim();
    if (!amount) return handleError(reply, 400, 'Enter an amount', 'BAD_AMOUNT');

    // Under the hard floor a deposit is mostly fees ($0.50 in loses ~10%), so it is refused rather than
    // quoted. Between hard-min and min the client warns; that is a nudge, not a block.
    if (Number(amount) > 0 && Number(amount) < DEPOSIT_HARD_MIN_USD) {
      return handleError(reply, 400, `Deposit at least $${DEPOSIT_HARD_MIN_USD}. Below that, fees eat most of it.`, 'AMOUNT_TOO_LOW');
    }

    try {
      const quote = await getDepositQuote({
        currency: String(body.currency ?? ''),
        network: String(body.network ?? ''),
        amount,
        toAddress: address,
      });
      return reply.code(200).send({ success: true, error: null, data: { quote } });
    } catch (error) {
      if (error instanceof LifiError) return handleError(reply, httpStatusForLifiError(error.code), error.message, error.code);
      return handleError(reply, 500, 'Could not price that deposit', 'DEPOSIT_QUOTE_FAILED', error as Error);
    }
  });

  done();
};
