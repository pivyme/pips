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

  // ── Execution (mainnet only) ─────────────────────────────────────────────────────────────────────
  // Every endpoint below is a no-op until BRIDGE_EXECUTE_ENABLED, which is true only on SUI_NETWORK=mainnet
  // (main-config.ts). Even with the env var set on a testnet box, the gate stays shut, so a demo build is
  // never one variable away from moving real money.
  const requireExecute = (reply: FastifyReply): boolean => {
    if (!BRIDGE_EXECUTE_ENABLED) {
      handleError(reply, 403, 'Cross-chain deposits are not enabled yet', 'BRIDGE_EXECUTE_DISABLED');
      return false;
    }
    return true;
  };

  // Fetch a fresh, signable route with the player's connected source address and the server-stamped
  // toAddress, and open a tracking row. The client signs the returned step directly, no re-quote.
  app.post('/execute-quote', { preHandler: [authMiddleware], config: quoteLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireExecute(reply)) return;
    const body = (request.body ?? {}) as { currency?: string; network?: string; amount?: string | number; fromAddress?: string; toAddress?: string };

    if (body.toAddress != null) return handleError(reply, 400, 'toAddress is set by the server', 'TO_ADDRESS_NOT_ACCEPTED');

    const address = request.user?.address;
    if (!address) return handleError(reply, 409, 'Your wallet is not ready yet', 'ADDRESS_NOT_READY');

    const network = String(body.network ?? '');
    const currency = String(body.currency ?? '');
    const amount = String(body.amount ?? '').trim();
    const fromAddress = String(body.fromAddress ?? '').trim();
    if (!fromAddress) return handleError(reply, 400, 'Connect a wallet first', 'FROM_ADDRESS_REQUIRED');
    if (!amount) return handleError(reply, 400, 'Enter an amount', 'BAD_AMOUNT');
    if (Number(amount) > 0 && Number(amount) < DEPOSIT_HARD_MIN_USD) {
      return handleError(reply, 400, `Deposit at least $${DEPOSIT_HARD_MIN_USD}. Below that, fees eat most of it.`, 'AMOUNT_TOO_LOW');
    }

    const fromChainId = chainIdFor(network);
    if (fromChainId == null) return handleError(reply, 400, 'That network is not supported.', 'BAD_PAIR');

    try {
      const { step, tool, bridge } = await getExecutableStep({ currency, network, amount, toAddress: address, fromAddress });
      const row = await prismaQuery.deposit.create({
        data: {
          userId: request.user!.id,
          fromChain: network,
          fromToken: currency,
          fromAmount: amount,
          toAmount: String((step as { estimate?: { toAmount?: string } }).estimate?.toAmount ?? ''),
          toAddress: address,
          tool: tool ?? 'unknown',
          bridge,
        },
      });
      return reply.code(200).send({
        success: true,
        error: null,
        data: { step, depositId: row.id, tool, bridge, fromChainId, toChainId: SUI_CHAIN_ID },
      });
    } catch (error) {
      if (error instanceof LifiError) return handleError(reply, httpStatusForLifiError(error.code), error.message, error.code);
      return handleError(reply, 500, 'Could not prepare that deposit', 'DEPOSIT_EXECUTE_QUOTE_FAILED', error as Error);
    }
  });

  // The client reports the source txHash once it broadcasts, correlating the row so status can be polled.
  app.post('/track', { preHandler: [authMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireExecute(reply)) return;
    const body = (request.body ?? {}) as { depositId?: string; txHash?: string };
    const depositId = String(body.depositId ?? '');
    const txHash = String(body.txHash ?? '').trim();
    if (!depositId || !txHash) return handleError(reply, 400, 'depositId and txHash are required', 'BAD_TRACK');

    const row = await prismaQuery.deposit.findFirst({ where: { id: depositId, userId: request.user!.id } });
    if (!row) return handleError(reply, 404, 'Deposit not found', 'DEPOSIT_NOT_FOUND');

    await prismaQuery.deposit.update({ where: { id: row.id }, data: { txHash } });
    return reply.code(200).send({ success: true, error: null, data: { status: 'PENDING', substatus: null, substatusMessage: null } });
  });

  // Poll a tracked deposit. Before the txHash lands it is PENDING by definition; after, we proxy LI.FI and
  // fold the result back into the row so the drawer and support share one source of truth.
  app.get('/status', { preHandler: [authMiddleware], config: quoteLimit }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireExecute(reply)) return;
    const id = String((request.query as { id?: string })?.id ?? '');
    if (!id) return handleError(reply, 400, 'id is required', 'BAD_STATUS');

    const row = await prismaQuery.deposit.findFirst({ where: { id, userId: request.user!.id } });
    if (!row) return handleError(reply, 404, 'Deposit not found', 'DEPOSIT_NOT_FOUND');

    // No txHash yet, or already resolved: answer from the row without hitting LI.FI.
    if (!row.txHash || row.status === 'DONE' || row.status === 'REFUNDED') {
      return reply.code(200).send({ success: true, error: null, data: { status: row.status, substatus: row.substatus, substatusMessage: null } });
    }

    try {
      const live = await getBridgeStatus({
        txHash: row.txHash,
        bridge: row.bridge,
        fromChain: String(chainIdFor(row.fromChain) ?? row.fromChain),
        toChain: SUI_CHAIN_ID_STR,
      });
      // Map LI.FI's vocabulary onto the row: DONE keeps its REFUNDED/PARTIAL nuance via substatus.
      const status =
        live.status === 'DONE'
          ? live.substatus === 'REFUNDED'
            ? 'REFUNDED'
            : 'DONE'
          : live.status === 'FAILED'
            ? 'FAILED'
            : 'PENDING';
      if (status !== row.status || live.substatus !== row.substatus) {
        await prismaQuery.deposit.update({ where: { id: row.id }, data: { status, substatus: live.substatus } });
      }
      return reply.code(200).send({ success: true, error: null, data: { status, substatus: live.substatus, substatusMessage: live.substatusMessage } });
    } catch (error) {
      if (error instanceof LifiError) return handleError(reply, httpStatusForLifiError(error.code), error.message, error.code);
      return handleError(reply, 500, 'Could not check that deposit', 'DEPOSIT_STATUS_FAILED', error as Error);
    }
  });

  done();
};
