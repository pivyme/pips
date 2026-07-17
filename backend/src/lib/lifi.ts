// The one LI.FI wrapper. Routes and services never call li.quest directly, same rule as predict.ts:
// when the catalog moves or mainnet lands, we touch one file.
//
// Everything here is read-only. A quote is a MAINNET route lookup that needs no wallet and does not care
// which network PIPS itself runs on, which is why the deposit drawer shows real routes, fees and ETAs on
// testnet. Execution (signing + broadcasting the source tx) is a separate, mainnet-gated concern.
//
// Verified live against li.quest on 2026-07-17. Re-probe before changing the catalog, LI.FI moves.

import { normalizeStructTag } from '@mysten/sui/utils';
import {
  LIFI_API_URL,
  LIFI_API_KEY,
  LIFI_INTEGRATOR,
  LIFI_TIMEOUT_MS,
  DEPOSIT_SLIPPAGE,
} from '../config/main-config.ts';
import { DUSDC_TYPE } from './sui/config.ts';
import type { DepositQuoteDTO } from '../types/api.ts';

// Sui is a real LI.FI chain (chainType MVM), but GET /v1/chains hides it unless you pass chainTypes=MVM.
export const SUI_CHAIN_ID = 9270000000000000;

// The asset a bridge lands on Sui. LI.FI delivers Circle's native Sui USDC, which is the mainnet chip
// asset, so there is no swap leg and no treasury shim. The address is resolved live, never hardcoded.
export const BRIDGE_ASSET = 'USDC';

// Curated source chains, a shortlist rather than the full 58-chain catalog. Numeric ids on purpose: the
// token API's `chain` param takes a key enum that rejects some names ('base' 400s while 'arb' passes), so
// ids are the only unambiguous spelling.
const CHAINS: Record<string, { id: number; label: string; vm: 'EVM' | 'SVM' }> = {
  ethereum: { id: 1, label: 'Ethereum', vm: 'EVM' },
  base: { id: 8453, label: 'Base', vm: 'EVM' },
  arbitrum: { id: 42161, label: 'Arbitrum', vm: 'EVM' },
  solana: { id: 1151111081099710, label: 'Solana', vm: 'SVM' },
};

// Every pair here returned a live quote into Sui USDC on 2026-07-17. Availability is per-PAIR, not
// per-chain, so a route is still re-validated on every quote and a dead pair degrades to a labelled
// no-route state rather than a lie.
export const CATALOG: Array<{ symbol: string; networks: string[] }> = [
  { symbol: 'USDC', networks: ['ethereum', 'base', 'arbitrum', 'solana'] },
  { symbol: 'ETH', networks: ['ethereum', 'base', 'arbitrum'] },
  { symbol: 'SOL', networks: ['solana'] },
];

// fromAddress is route-finding only, it never signs anything (P4 swaps in the player's connected wallet).
// A well-known funded address per VM keeps quotes representative of what a real wallet would be offered.
const PLACEHOLDER_FROM: Record<'EVM' | 'SVM', string> = {
  EVM: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  SVM: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
};

export type LifiErrorCode = 'NO_ROUTE' | 'BAD_PAIR' | 'BAD_AMOUNT' | 'LIFI_UNAVAILABLE' | 'CHIP_TYPE_MISMATCH';

export class LifiError extends Error {
  constructor(
    public code: LifiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LifiError';
  }
}

export const httpStatusForLifiError = (code: LifiErrorCode): number =>
  code === 'LIFI_UNAVAILABLE' ? 502 : code === 'CHIP_TYPE_MISMATCH' ? 503 : code === 'NO_ROUTE' ? 404 : 400;

// Fail-safe for the whole integration: the bridge lands whatever Sui coin LI.FI calls USDC, but chips are
// spendable only as DUSDC_TYPE (the mint PTB + balance filter on exactly that type). If mainnet's chip type
// is not byte-for-byte LI.FI's Sui USDC, a real deposit would arrive as an invisible, unusable coin. So
// before handing back a SIGNABLE route we assert the two types match and refuse loudly if they don't,
// rather than let money bridge into a black hole. Only runs on the execute path, which is mainnet-only, so
// it never touches the testnet preview where the chip is DUSDC and a mismatch is expected by design.
function assertBridgeLandsChipType(deliveredType: string): void {
  let delivered: string | null = null;
  let chip: string | null = null;
  try {
    delivered = normalizeStructTag(deliveredType);
    chip = DUSDC_TYPE ? normalizeStructTag(DUSDC_TYPE) : null;
  } catch {
    // A non-parseable type on either side is itself a mismatch, treat it as one.
  }
  if (!chip || delivered !== chip) {
    throw new LifiError(
      'CHIP_TYPE_MISMATCH',
      'Cross-chain deposits are temporarily unavailable. Please try the faucet or a native transfer.',
    );
  }
}

export const networkLabel = (network: string): string => CHAINS[network]?.label ?? network;
export const isKnownNetwork = (network: string): boolean => network in CHAINS;

interface TokenMeta {
  address: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
}

interface ChainListEntry {
  id: number;
  key: string;
  name: string;
  logoURI?: string;
}

interface LifiQuote {
  tool?: string;
  toolDetails?: { name?: string };
  action?: { toToken?: { symbol?: string; decimals?: number } };
  estimate?: {
    toAmount?: string;
    toAmountMin?: string;
    fromAmountUSD?: string;
    toAmountUSD?: string;
    executionDuration?: number;
    feeCosts?: Array<{ amountUSD?: string; included?: boolean }>;
    gasCosts?: Array<{ amountUSD?: string }>;
  };
}

// One fetch path for every LI.FI call: key header, timeout, and their error envelope mapped to ours.
// LI.FI answers 4xx with { code, message }; 1001/1002 mean "no route", which is a normal, expected state.
async function lifiGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = `${LIFI_API_URL}${path}?${new URLSearchParams(params).toString()}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: LIFI_API_KEY ? { 'x-lifi-api-key': LIFI_API_KEY } : {},
      signal: AbortSignal.timeout(LIFI_TIMEOUT_MS),
    });
  } catch {
    // Network error or the timeout above firing. Either way the player just needs to retry.
    throw new LifiError('LIFI_UNAVAILABLE', 'Could not reach the route provider. Try again in a moment.');
  }

  const body = (await res.json().catch(() => null)) as (T & { code?: number; message?: string }) | null;
  if (!res.ok || body == null) {
    const code = body?.code;
    if (code === 1001 || code === 1002) {
      throw new LifiError('NO_ROUTE', 'No route for this pair right now. Try USDC.');
    }
    if (res.status >= 500) {
      throw new LifiError('LIFI_UNAVAILABLE', 'The route provider is having trouble. Try again in a moment.');
    }
    throw new LifiError('BAD_PAIR', body?.message ?? 'That deposit is not supported right now.');
  }
  return body;
}

// Token addresses and decimals come from LI.FI itself rather than a hardcoded table that could rot into a
// wrong-decimals quote. They never change, so one lookup per (chain, symbol) per process is plenty.
const tokenCache = new Map<string, Promise<TokenMeta>>();

function resolveToken(chainId: number, symbol: string): Promise<TokenMeta> {
  const key = `${chainId}:${symbol}`;
  const hit = tokenCache.get(key);
  if (hit) return hit;
  const p = lifiGet<TokenMeta>('/token', { chain: String(chainId), token: symbol }).catch((e: unknown) => {
    tokenCache.delete(key); // never cache a failure, the next quote should retry
    throw e;
  });
  tokenCache.set(key, p);
  return p;
}

// Decimal string -> raw base units, in string/BigInt math. A float multiply (0.1 * 1e18) is not an
// integer and would silently misquote the amount.
function toRawAmount(amount: string, decimals: number): bigint {
  const [whole = '0', frac = ''] = amount.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

// Raw base units -> a trimmed decimal string, for display only.
function fromRawAmount(raw: string, decimals: number): string {
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${v / base}.${frac}` : `${v / base}`;
}

const sumUsd = (rows: Array<{ amountUSD?: string }> | undefined): number =>
  (rows ?? []).reduce((acc, r) => acc + (Number(r.amountUSD) || 0), 0);

// LI.FI owns the chain art the same way it owns token addresses, so we render theirs rather than shipping
// our own asset set that would rot. GET /v1/chains hides Sui unless chainTypes names MVM (gotcha, §7).
let chainList: Promise<Map<number, ChainListEntry>> | null = null;

function loadChains(): Promise<Map<number, ChainListEntry>> {
  if (chainList) return chainList;
  chainList = lifiGet<{ chains: ChainListEntry[] }>('/chains', { chainTypes: 'EVM,SVM,MVM' })
    .then((r) => new Map((r.chains ?? []).map((c) => [c.id, c])))
    .catch((e: unknown) => {
      chainList = null; // never cache a failure, the next options call should retry
      throw e;
    });
  return chainList;
}

export interface DepositCatalog {
  currencies: Array<{ symbol: string; logo: string | null; networks: string[] }>;
  networks: Array<{ key: string; label: string; logo: string | null }>;
}

// The catalog the drawer renders itself from, with LI.FI's own token + chain art folded in.
//
// Logos are decoration, so every lookup here is best-effort: a slow or broken li.quest degrades to a null
// logo (the client draws a monogram) and never takes down the address screen, which is the one deposit
// path that actually works today.
export async function getDepositCatalog(chipSymbol: string): Promise<DepositCatalog> {
  const logoOf = async (chainId: number, symbol: string): Promise<string | null> => {
    try {
      return (await resolveToken(chainId, symbol)).logoURI ?? null;
    } catch {
      return null;
    }
  };

  const chains = await loadChains().catch(() => new Map<number, ChainListEntry>());
  const chainLogo = (id: number): string | null => chains.get(id)?.logoURI ?? null;

  // The chip is USDC on mainnet, so its logo is a plain lookup. On testnet/fork it is a DUSDC test token
  // LI.FI has never heard of, and it is a USDC-denominated one, so it borrows Sui USDC's art rather than
  // going blank. The symbol next to it always reads DUSDC, so nothing here claims it is real USDC.
  const [chipLogo, ...catalogLogos] = await Promise.all([
    logoOf(SUI_CHAIN_ID, chipSymbol === 'DUSDC' ? BRIDGE_ASSET : chipSymbol),
    ...CATALOG.map((c) => logoOf(CHAINS[c.networks[0]!]!.id, c.symbol)),
  ]);

  return {
    currencies: [
      { symbol: chipSymbol, logo: chipLogo, networks: ['sui'] },
      ...CATALOG.map((c, i) => ({ symbol: c.symbol, logo: catalogLogos[i] ?? null, networks: c.networks })),
    ],
    networks: [
      { key: 'sui', label: 'Sui', logo: chainLogo(SUI_CHAIN_ID) },
      ...Object.entries(CHAINS).map(([key, c]) => ({ key, label: c.label, logo: chainLogo(c.id) })),
    ],
  };
}

export interface QuoteInput {
  currency: string;
  network: string;
  amount: string;
  // Stamped from the authed user server-side. Never accepted from the client: a poisoned value sends real
  // funds to a stranger, irreversibly.
  toAddress: string;
  // Only set for an executable quote: the source wallet the player will actually sign with. It shapes the
  // returned transactionRequest, so it must be their real connected address, not the route-finding
  // placeholder. Omitted for the read-only preview.
  fromAddress?: string;
}

// Validate the pair + amount and build the LI.FI /quote params. Shared by the preview and the executable
// fetch so both hit the exact same route with the exact same server-stamped toAddress.
async function buildQuoteParams(
  input: QuoteInput,
): Promise<{ chain: (typeof CHAINS)[string]; fromToken: TokenMeta; toToken: TokenMeta; params: Record<string, string> }> {
  const chain = CHAINS[input.network];
  if (!chain) throw new LifiError('BAD_PAIR', 'That network is not supported.');
  if (!CATALOG.some((c) => c.symbol === input.currency && c.networks.includes(input.network))) {
    throw new LifiError('BAD_PAIR', `${input.currency} is not supported on ${chain.label}.`);
  }
  if (!/^\d+(\.\d+)?$/.test(input.amount) || Number(input.amount) <= 0) {
    throw new LifiError('BAD_AMOUNT', 'Enter an amount greater than zero.');
  }

  const [fromToken, toToken] = await Promise.all([
    resolveToken(chain.id, input.currency),
    resolveToken(SUI_CHAIN_ID, BRIDGE_ASSET),
  ]);

  const fromAmount = toRawAmount(input.amount, fromToken.decimals);
  if (fromAmount <= 0n) throw new LifiError('BAD_AMOUNT', 'Enter an amount greater than zero.');

  return {
    chain,
    fromToken,
    toToken,
    params: {
      fromChain: String(chain.id),
      toChain: String(SUI_CHAIN_ID),
      fromToken: fromToken.address,
      toToken: toToken.address,
      fromAmount: fromAmount.toString(),
      // fromAddress route-finds for the preview and shapes the signable tx for execution.
      fromAddress: input.fromAddress || PLACEHOLDER_FROM[chain.vm],
      toAddress: input.toAddress,
      slippage: String(DEPOSIT_SLIPPAGE),
      integrator: LIFI_INTEGRATOR,
    },
  };
}

// A live mainnet route into the user's own Sui address. Every rendered number comes straight from
// LI.FI's estimate; nothing here is computed, guessed, or defaulted, so the preview is what the player
// would actually get.
export async function getDepositQuote(input: QuoteInput): Promise<DepositQuoteDTO> {
  const { chain, fromToken, toToken, params } = await buildQuoteParams(input);
  const quote = await lifiGet<LifiQuote>('/quote', params);

  const est = quote.estimate;
  if (!est?.toAmount) throw new LifiError('NO_ROUTE', 'No route for this pair right now. Try USDC.');

  const toDecimals = quote.action?.toToken?.decimals ?? toToken.decimals;
  const toSymbol = quote.action?.toToken?.symbol ?? toToken.symbol;
  const toAmount = fromRawAmount(est.toAmount, toDecimals);

  // Do NOT trust estimate.feeCosts: it does not reconcile with the output, in either direction. The
  // bridge's own spread is missing from it (a $3 Arbitrum deposit declares $0.03 of fees but really costs
  // $0.21), and some tools declare a worst-case row that is never charged (a $75 SOL deposit declares an
  // $11.50 relayer fee against a real $0.84 cost). The only honest number is value in minus value out,
  // which is also the one the player can check against the output we render.
  //
  // Same asset in and out: diff in TOKEN units, because LI.FI prices Base USDC at ~$0.995 and Sui USDC at
  // ~$1.000, so a USD-based diff on a stablecoin comes out negative. Cross-asset: USD is all we have.
  // Gas is paid on top in the source chain's native coin, so it adds rather than nets out.
  const spread =
    fromToken.symbol === toSymbol
      ? Number(input.amount) - Number(toAmount)
      : (Number(est.fromAmountUSD) || 0) - (Number(est.toAmountUSD) || 0);
  const feeUsd = Math.max(0, spread) + sumUsd(est.gasCosts);

  return {
    fromAmount: input.amount,
    fromSymbol: fromToken.symbol,
    fromNetwork: input.network,
    fromNetworkLabel: chain.label,
    fromAmountUsd: est.fromAmountUSD ?? null,
    toAmount,
    toAmountMin: est.toAmountMin ? fromRawAmount(est.toAmountMin, toDecimals) : null,
    toAmountUsd: est.toAmountUSD ?? null,
    toSymbol,
    toAddress: input.toAddress,
    feeUsd: feeUsd.toFixed(2),
    // Never render a hardcoded ETA: the real spread across tools is 60s to 1200s on the same catalog.
    durationSec: est.executionDuration ?? null,
    tool: quote.tool ?? null,
    toolName: quote.toolDetails?.name ?? quote.tool ?? null,
  };
}

// A LI.FI step is a big nested object; the client casts it to the SDK's LiFiStep. We only pull a few
// fields here (for the tracking row) and pass the rest through opaque, so a schema drift on their side
// never breaks our types.
export interface ExecutableStep {
  step: Record<string, unknown>;
  tool: string | null;
  bridge: string | null;
}

// The signable route for execution. Fetched FRESH at confirm time (quotes go stale) with the player's
// real connected fromAddress and the server-stamped toAddress, and returned whole so the client SDK can
// sign transactionRequest directly without a re-fetch. Never call this off the read-only preview path.
export async function getExecutableStep(input: QuoteInput): Promise<ExecutableStep> {
  if (!input.fromAddress) throw new LifiError('BAD_PAIR', 'A connected source wallet is required.');
  const { toToken, params } = await buildQuoteParams(input);

  // Never sign a route that would deliver a coin the balance/mint cannot see. Mainnet-only path.
  assertBridgeLandsChipType(toToken.address);

  const step = await lifiGet<Record<string, unknown>>('/quote', params);

  // Guard the field the SDK needs to sign without re-fetching: if LI.FI ever omits transactionRequest,
  // executing would silently re-price the step, so fail loud instead.
  if (!step.transactionRequest) {
    throw new LifiError('NO_ROUTE', 'That route is not executable right now. Try again in a moment.');
  }

  const est = (step.estimate ?? {}) as { tool?: string };
  const tool = (step.tool as string | undefined) ?? est.tool ?? null;
  // The bridge/tool key is what /status keys on; it lives on the last included step for a multi-step route.
  const included = (step.includedSteps as Array<{ tool?: string; type?: string }> | undefined) ?? [];
  const bridge = included.find((s) => s.type === 'cross')?.tool ?? tool;

  return { step, tool, bridge };
}

interface LifiStatus {
  status?: string;
  substatus?: string;
  substatusMessage?: string;
  receiving?: { txHash?: string; amount?: string };
}

export interface BridgeStatus {
  status: string; // NOT_FOUND | PENDING | DONE | FAILED
  substatus: string | null;
  substatusMessage: string | null;
  receivedTxHash: string | null;
}

// Proxy LI.FI's status lookup for a source txHash. A tx it has not indexed yet answers NOT_FOUND, which is
// a normal early state (we keep polling), not an error.
export async function getBridgeStatus(args: {
  txHash: string;
  bridge?: string | null;
  fromChain: string;
  toChain: string;
}): Promise<BridgeStatus> {
  const params: Record<string, string> = { txHash: args.txHash, fromChain: args.fromChain, toChain: args.toChain };
  if (args.bridge) params.bridge = args.bridge;
  const res = await lifiGet<LifiStatus>('/status', params);
  return {
    status: res.status ?? 'NOT_FOUND',
    substatus: res.substatus ?? null,
    substatusMessage: res.substatusMessage ?? null,
    receivedTxHash: res.receiving?.txHash ?? null,
  };
}

export const SUI_CHAIN_ID_STR = String(SUI_CHAIN_ID);
export const chainIdFor = (network: string): number | null => CHAINS[network]?.id ?? null;
