// One gRPC client for the whole backend: fullnode reads/writes go through SuiGrpcClient, historical
// queries (events/tx-history, which gRPC v2 doesn't serve) go through SuiGraphQLClient. baseUrl is required; `new SuiGrpcClient({ network })` alone throws `base.endsWith`.

import { GrpcWebFetchTransport, SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

import { SUI_FULLNODE_URL, SUI_GRAPHQL_URL } from '../../config/main-config.ts';
import { NETWORK } from './config.ts';

// Per-network defaults when the env var is empty. Public Mysten endpoints, which is also what belongs
// FIRST in a configured list: paid fallbacks should only carry traffic while the public one is throttled.
const DEFAULT_FULLNODE: Record<string, string> = {
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  testnet: 'https://fullnode.testnet.sui.io:443',
};
const DEFAULT_GRAPHQL: Record<string, string> = {
  mainnet: 'https://graphql.mainnet.sui.io/graphql',
  testnet: 'https://graphql.testnet.sui.io/graphql',
};

/** Endpoint URLs carry provider api keys, so nothing logs one whole: origin plus a marker for the key path. */
export const redactEndpoint = (url: string): string => {
  try {
    const u = new URL(url);
    return u.pathname.length > 1 ? `${u.origin}/…` : u.origin;
  } catch {
    return '(malformed url)';
  }
};

// Both env vars are comma-separated (same convention as ALLOWED_ORIGIN), primary first, so a deploy can put
// the public node first and keyed fallbacks behind it without a code change.
//
// An endpoint whose url names another network is dropped, not used: a mainnet fallback under
// SUI_NETWORK=testnet answers every read against the wrong chain, which surfaces as missing objects rather
// than as an outage. If that empties the list we fall back to the network's own public endpoint.
export function parseEndpoints(raw: string, fallback: string, label: string): string[] {
  const all = raw
    .split(',')
    .map((u) => u.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const kept = all.filter((u) => {
    const named = u.toLowerCase().match(/\b(mainnet|testnet|devnet|localnet)\b/g);
    if (!named || named.includes(NETWORK)) return true;
    console.warn(`[sui] ${label}: dropping ${named[0]} endpoint ${redactEndpoint(u)}, SUI_NETWORK is ${NETWORK}`);
    return false;
  });
  return kept.length ? kept : [fallback];
}

const fullnodeFallback = DEFAULT_FULLNODE[NETWORK] || DEFAULT_FULLNODE.testnet;
const graphqlFallback = DEFAULT_GRAPHQL[NETWORK] || DEFAULT_GRAPHQL.testnet;
export const FULLNODE_ENDPOINTS: string[] = parseEndpoints(SUI_FULLNODE_URL || fullnodeFallback, fullnodeFallback, 'fullnode');
export const GRAPHQL_ENDPOINTS: string[] = parseEndpoints(SUI_GRAPHQL_URL || graphqlFallback, graphqlFallback, 'graphql');

// The public fullnode allows ~100 requests / 30s per IP, and past it every read answers 429. That surfaced
// as dead sign-ins, blank balances and failed plays, so retrying is not optional. grpc-web rides a plain
// fetch, which makes this one hook the whole retry + failover layer for every call site.
//
// A 429 means the node rejected the request before touching it, so re-issuing it can never double-execute a
// transaction. The connection-level failures are ambiguous for a write, so those only retry on reads.
const RETRY_STATUS = new Set([429, 502, 503, 504]);
const WRITE_SERVICE = 'TransactionExecutionService';
// A throttled endpoint stays throttled for a while, so park it rather than paying a doomed round trip on
// every call. Short enough that the public node is back as primary quickly once its window resets.
const COOLDOWN_MS = 20_000;

/** Endpoints, primary first, with the throttled ones parked. Shared shape for both transports. */
export function createEndpointRing(list: string[], label: string) {
  const cooling = new Array<number>(list.length).fill(0);
  let retries = 0;
  let lastLogAt = 0;
  return {
    attempts: Math.max(list.length, 2),
    /** Index to start at: the first endpoint not cooling, else the primary, since something has to be tried. */
    pick(): number {
      const now = Date.now();
      for (let i = 0; i < list.length; i++) if (cooling[i] <= now) return i;
      return 0;
    },
    cool(i: number, why: number | string): void {
      cooling[i] = Date.now() + COOLDOWN_MS;
      retries++;
      if (Date.now() - lastLogAt < 60_000) return; // one line a minute, not one per throttled read
      lastLogAt = Date.now();
      const next = list.length > 1 ? 'failing over' : 'retrying';
      console.warn(`[sui] ${label} backpressure (${why}) on ${redactEndpoint(list[i])}, ${next}. ${retries} retries so far.`);
    },
    count: (): number => retries,
  };
}

const fullnodeRing = createEndpointRing(FULLNODE_ENDPOINTS, 'fullnode');
const graphqlRing = createEndpointRing(GRAPHQL_ENDPOINTS, 'graphql');

/** Retries so far, for the ops snapshot: a climbing number means the primary endpoint is undersized. */
export const fullnodeRetryCount = (): number => fullnodeRing.count();

const grpcPath = (url: string): string => {
  const primary = FULLNODE_ENDPOINTS[0];
  if (url.startsWith(primary)) return url.slice(primary.length);
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

async function fetchWithFailover(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  // Only the grpc method path is kept, so an endpoint carrying its own key prefix still resolves.
  const path = grpcPath(url);
  const isWrite = path.includes(WRITE_SERVICE);
  const start = fullnodeRing.pick();
  let lastError: unknown;

  for (let attempt = 0; attempt < fullnodeRing.attempts; attempt++) {
    const idx = (start + attempt) % FULLNODE_ENDPOINTS.length;
    try {
      const res = await fetch(FULLNODE_ENDPOINTS[idx] + path, init);
      if (!RETRY_STATUS.has(res.status) || attempt === fullnodeRing.attempts - 1) return res;
      if (isWrite && res.status !== 429) return res; // ambiguous for a write: it may already be executing
      fullnodeRing.cool(idx, res.status);
    } catch (e) {
      lastError = e;
      if (isWrite || attempt === fullnodeRing.attempts - 1) throw e; // a write that may have landed is never re-sent
      fullnodeRing.cool(idx, 'connect');
    }
    // Short jittered backoff. The play path lives inside a 20-60s round and settle ticks every second, so
    // this stays well under a tick rather than being a polite-but-useless multi-second wait.
    await new Promise((r) => setTimeout(r, 120 * (attempt + 1) + Math.floor(Math.random() * 80)));
  }
  throw lastError ?? new Error('fullnode request failed');
}

// Every GraphQL call site here is a read, so a retry is always safe. The SDK calls fetch with its one
// configured url, which makes a failover a whole-url swap instead of a path rewrite.
async function graphqlFetchWithFailover(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!GRAPHQL_ENDPOINTS.includes(url.replace(/\/+$/, ''))) return fetch(input, init); // not one of ours, pass through
  const start = graphqlRing.pick();
  let lastError: unknown;

  for (let attempt = 0; attempt < graphqlRing.attempts; attempt++) {
    const idx = (start + attempt) % GRAPHQL_ENDPOINTS.length;
    try {
      const res = await fetch(GRAPHQL_ENDPOINTS[idx], init);
      if (!RETRY_STATUS.has(res.status) || attempt === graphqlRing.attempts - 1) return res;
      graphqlRing.cool(idx, res.status);
    } catch (e) {
      lastError = e;
      if (attempt === graphqlRing.attempts - 1) throw e;
      graphqlRing.cool(idx, 'connect');
    }
    await new Promise((r) => setTimeout(r, 150 * (attempt + 1) + Math.floor(Math.random() * 100)));
  }
  throw lastError ?? new Error('graphql request failed');
}

// grpc-web only ever calls these as a function; `preconnect` is carried over purely to satisfy `typeof fetch`.
const asFetch = (fn: typeof fetchWithFailover): typeof fetch => Object.assign(fn, { preconnect: globalThis.fetch.preconnect });

// The transport is built here rather than letting SuiGrpcClient do it: its constructor forwards only
// `baseUrl` and `fetchInit`, so a `fetch` passed to the client is silently dropped and the retry layer
// above would never run. Verified against @mysten/sui 2.18.0, re-check it on an SDK bump.
const transport = new GrpcWebFetchTransport({ baseUrl: FULLNODE_ENDPOINTS[0], fetch: asFetch(fetchWithFailover) });

export const suiClient = new SuiGrpcClient({ network: NETWORK, transport });

// Historical-query client (events + tx history); only market-sync oracle discovery and predict redeem-reconcile use it, everything else stays on gRPC.
export const graphqlClient = new SuiGraphQLClient({
  url: GRAPHQL_ENDPOINTS[0],
  network: NETWORK,
  fetch: asFetch(graphqlFetchWithFailover),
});

if (FULLNODE_ENDPOINTS.length > 1 || GRAPHQL_ENDPOINTS.length > 1) {
  const summary = `${FULLNODE_ENDPOINTS.length} fullnode + ${GRAPHQL_ENDPOINTS.length} graphql`;
  console.log(`[sui] ${NETWORK}: ${summary} endpoints, primary ${redactEndpoint(FULLNODE_ENDPOINTS[0])}`);
}

// Suiscan explorer links; network comes from config (testnet now, mainnet later), Suiscan natively indexes both.
const EXPLORER_BASE = `https://suiscan.xyz/${NETWORK}`;

export const explorerTxUrl = (digest: string): string => `${EXPLORER_BASE}/tx/${digest}`;
export const explorerObjectUrl = (id: string): string => `${EXPLORER_BASE}/object/${id}`;
export const explorerAddressUrl = (address: string): string => `${EXPLORER_BASE}/account/${address}`;

// Normalizes a Sui error to lowercased, percent-decoded text: gRPC-web trailers arrive percent-encoded
// per spec (e.g. "Object%20..%20not%20found") and the transport doesn't decode them, so "not found" matchers would miss it otherwise.
export function grpcErrorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // malformed % sequence, keep the raw string
  }
  return decoded.toLowerCase();
}

// The fullnode is rate limited per IP (~100 requests / 30s on the public one) and says so in three shapes:
// the 429 itself, a gRPC RESOURCE_EXHAUSTED, and the plain JSON error body grpc-web can't parse
// ("unexpected response content type"). Callers use this to log backpressure as backpressure, not as a bug.
export function isRateLimitedError(e: unknown): boolean {
  const m = grpcErrorText(e);
  if (!m) return false;
  return m.includes('too many requests') || m.includes('resource_exhausted') || m.includes('unexpected response content type');
}

// True when the deployed Predict package/vault/treasury-cap/manager is gone: Sui Devnet wipes roughly
// weekly, deleting every published object, so config ids go stale until the next bootstrap. Sign-in maps this to CHAIN_UNAVAILABLE (points the user at demo mode); scoped to missing-resource signals only, not gas/transient errors.
export function isChainUnavailableError(e: unknown): boolean {
  const m = grpcErrorText(e);
  if (!m) return false;
  return (
    m.includes('package object does not exist') ||
    m.includes('does not exist or was deleted') ||
    m.includes('objectnotfound') ||
    m.includes('no module found') ||
    m.includes('module not found') ||
    m.includes('vmverificationordeserialization') ||
    m.includes('could not find the referenced object') ||
    m.includes('is not a valid package') ||
    // gRPC surfaces a missing object/package as a bare NOT_FOUND "<id> not found" message, so match that shape too.
    m.includes('not_found') ||
    /\b(object|package)\b[^]*?not found/.test(m) ||
    /\bpackage\b[^]*?(does not exist|was not found|not found|cannot find|deleted)/.test(m) ||
    /\bobject\b[^]*?(does not exist|was not found|not found)/.test(m)
  );
}
