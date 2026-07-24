// Token metadata + best-effort price + held-coin listing, all behind the TokenInfo cache so the send picker
// and the activity feed never hand-add a logo. Metadata comes from on-chain getCoinMetadata + a curated
// override map (SUI's on-chain iconUrl is empty on testnet, so it needs one); price is best-effort (stables
// pinned to 1, SUI from the shared Pyth cache, everything else null on testnet). Never throws on a miss.

import { normalizeStructTag, SUI_TYPE_ARG } from '@mysten/sui/utils';

import { prismaQuery } from '../prisma.ts';
import { getSpot } from '../price-cache.ts';
import { SUI_NETWORK } from '../../config/main-config.ts';
import { suiClient } from './client.ts';
import { DUSDC_TYPE } from './config.ts';

const NETWORK = SUI_NETWORK;

// The one metadata shape the rest of the backend reads. `priceUsd` is best-effort (null = unknown).
export interface TokenInfoLite {
  coinType: string;
  symbol: string;
  name: string | null;
  decimals: number;
  iconUrl: string | null;
  priceUsd: number | null;
  verified: boolean;
  source: string | null;
}

// One held coin at an address, resolved + priced, ready for the send picker / balance list.
export interface HeldCoin {
  coinType: string;
  symbol: string;
  name: string | null;
  decimals: number;
  iconUrl: string | null;
  amountRaw: bigint; // total base units
  amount: string; // display units, decimals-aware
  priceUsd: number | null;
  usdValue: number | null; // amount * priceUsd, or null when the price is unknown
  isChip: boolean; // true for DUSDC (the balance headline)
}

// Normalize a coin type to its canonical full form for keys + comparison; null if it isn't a valid struct tag.
export function normType(coinType: string): string | null {
  try {
    return normalizeStructTag(coinType);
  } catch {
    return null;
  }
}

const SUI_CANON = normalizeStructTag(SUI_TYPE_ARG);
const DUSDC_CANON = DUSDC_TYPE ? normType(DUSDC_TYPE) : null;

// True for the chip asset (DUSDC), the balance headline. Compared on the canonical type.
export function isChipType(canon: string): boolean {
  return DUSDC_CANON != null && canon === DUSDC_CANON;
}

// Canonical DUSDC / SUI types, for the wallet service's send routing + gas-reserve logic.
export const CHIP_CANON = DUSDC_CANON;
export const isSuiType = (canon: string): boolean => canon === SUI_CANON;

// Stable symbols pinned to $1 (from pivy's token worker). A stable's usdValue is its amount, no oracle needed.
const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'DUSDC', 'suiUSDC', 'suiUSDT', 'wUSDC', 'BUCK', 'AUSD', 'USDY', 'FDUSD']);

// Frontend-served bundled logos: robust against external-CDN rot (the whole reason this cache exists), and
// they resolve against the web app origin where CoinLogo renders them. Curated because on-chain iconUrl is empty.
const LOGO = {
  sui: '/assets/images/coins/sui-logo.png',
  dusdc: '/assets/icons/dusdc-logo.webp',
};

// Curated overrides applied on top of on-chain metadata (or standing in when it's missing). Keyed by canonical
// type. DUSDC/SUI are known; mainnet USDC gets its logo when we re-point. Keep this the ONE place we hand-add art.
function curatedOverride(canon: string): Partial<TokenInfoLite> | null {
  if (canon === SUI_CANON) return { symbol: 'SUI', name: 'Sui', decimals: 9, iconUrl: LOGO.sui, verified: true, source: 'curated' };
  if (DUSDC_CANON && canon === DUSDC_CANON) return { symbol: 'DUSDC', name: 'DeepBook USDC', decimals: 6, iconUrl: LOGO.dusdc, priceUsd: 1, verified: true, source: 'curated' };
  return null;
}

// Fallback metadata when both the cache and the chain give us nothing: the last type segment as a symbol, so
// the UI shows a readable monogram instead of a blank. 9dp is the Sui default; never trusted for money math on a
// coin we couldn't resolve (send validates against the real held balance, not this).
function fallbackInfo(canon: string): TokenInfoLite {
  const seg = canon.split('::').pop() ?? 'TOKEN';
  return { coinType: canon, symbol: seg.slice(0, 8).toUpperCase(), name: null, decimals: 9, iconUrl: null, priceUsd: null, verified: false, source: null };
}

// Read on-chain coin metadata (gRPC). Null on any failure (a stray/scam coin often has none).
type ChainMeta = { symbol?: string; name?: string | null; decimals?: number; iconUrl?: string | null };
async function fetchChainMetadata(canon: string): Promise<ChainMeta | null> {
  try {
    const res = await suiClient.core.getCoinMetadata({ coinType: canon });
    const m = res.coinMetadata;
    return m ? { symbol: m.symbol, name: m.name, decimals: m.decimals, iconUrl: m.iconUrl } : null;
  } catch {
    return null;
  }
}

// Merge an on-chain metadata read + the curated override into a TokenInfoLite. Curated wins on the fields it sets.
function mergeInfo(canon: string, chain: ChainMeta | null, curated: Partial<TokenInfoLite> | null): TokenInfoLite {
  const base = fallbackInfo(canon);
  const symbol = curated?.symbol ?? chain?.symbol ?? base.symbol;
  const name = curated?.name ?? chain?.name ?? base.name;
  const decimals = curated?.decimals ?? chain?.decimals ?? base.decimals;
  const iconUrl = curated?.iconUrl ?? (chain?.iconUrl && chain.iconUrl.length > 0 ? chain.iconUrl : null);
  return {
    coinType: canon,
    symbol,
    name,
    decimals,
    iconUrl,
    priceUsd: curated?.priceUsd ?? null,
    verified: curated?.verified ?? false,
    source: curated?.source ?? (chain ? 'onchain' : null),
  };
}

const dbToLite = (row: { coinType: string; symbol: string; name: string | null; decimals: number; iconUrl: string | null; priceUsd: number | null; verified: boolean; source: string | null }): TokenInfoLite => ({
  coinType: row.coinType,
  symbol: row.symbol,
  name: row.name,
  decimals: row.decimals,
  iconUrl: row.iconUrl,
  priceUsd: row.priceUsd,
  verified: row.verified,
  source: row.source,
});

// Short-lived in-memory metadata cache + in-flight coalescer, so an indexing batch that touches the same coin
// N times hits memory once instead of the DB/chain N times. The DB stays the durable cache; this just cuts churn.
const memCache = new Map<string, { info: TokenInfoLite; at: number }>();
const MEM_TTL_MS = 5 * 60_000;
const inflight = new Map<string, Promise<TokenInfoLite>>();

// Read an address's coin metadata off-chain-first: canonical, cache-first from TokenInfo, and on a miss pull
// getCoinMetadata (gRPC) + the curated override, upsert, and return. Never throws; a total failure returns a
// monogram-friendly fallback so callers always get something renderable.
export async function resolveTokenInfo(coinType: string): Promise<TokenInfoLite> {
  const canon = normType(coinType);
  if (!canon) return fallbackInfo(coinType);

  const now = Date.now();
  const mem = memCache.get(canon);
  if (mem && now - mem.at < MEM_TTL_MS) return mem.info;

  const existing = inflight.get(canon);
  if (existing) return existing;

  const p = (async (): Promise<TokenInfoLite> => {
    // Durable cache first.
    try {
      const row = await prismaQuery.tokenInfo.findUnique({ where: { network_coinType: { network: NETWORK, coinType: canon } } });
      if (row) return dbToLite(row);
    } catch {
      // DB read hiccup: fall through to a chain read so we still return something useful.
    }

    // Miss: pull on-chain metadata + curated override, then persist.
    const curated = curatedOverride(canon);
    const chain = await fetchChainMetadata(canon);
    const info = mergeInfo(canon, chain, curated);
    const priceUsd = await priceUsdFor(info).catch(() => info.priceUsd);
    const withPrice = { ...info, priceUsd };
    // Persist (idempotent on [network, coinType]); a concurrent insert just re-confirms the row.
    try {
      await prismaQuery.tokenInfo.upsert({
        where: { network_coinType: { network: NETWORK, coinType: canon } },
        update: { symbol: withPrice.symbol, name: withPrice.name, decimals: withPrice.decimals, iconUrl: withPrice.iconUrl, priceUsd: withPrice.priceUsd, verified: withPrice.verified, source: withPrice.source },
        create: { network: NETWORK, coinType: canon, symbol: withPrice.symbol, name: withPrice.name, decimals: withPrice.decimals, iconUrl: withPrice.iconUrl, priceUsd: withPrice.priceUsd, verified: withPrice.verified, source: withPrice.source },
      });
    } catch {
      // upsert lost a create race or the DB is down: return the resolved info anyway (never block a read)
    }
    return withPrice;
  })()
    .then((info) => {
      memCache.set(canon, { info, at: Date.now() });
      if (memCache.size > 512) for (const [k, v] of memCache) if (Date.now() - v.at >= MEM_TTL_MS) memCache.delete(k);
      return info;
    })
    .finally(() => inflight.delete(canon));

  inflight.set(canon, p);
  return p;
}

// Best-effort USD price for a token: stables -> 1, SUI -> the shared Pyth cache, everything else null on testnet
// (Cetus is the mainnet seam below). Falls back to any stored price. Never throws.
export async function priceUsdFor(info: TokenInfoLite): Promise<number | null> {
  if (STABLE_SYMBOLS.has(info.symbol)) return 1;
  if (info.coinType === SUI_CANON || info.symbol === 'SUI') {
    const spot = await getSpot('SUI').catch(() => null);
    return spot?.price ?? info.priceUsd ?? null;
  }
  const cetus = await cetusPriceUsd(info).catch(() => null);
  return cetus ?? info.priceUsd ?? null;
}

// Mainnet AMM price seam. Testnet has no meaningful Cetus liquidity, so this is null there (expected per the
// decision: metadata + prices, prices best-effort). Wire the real Cetus pool read here on the mainnet re-point.
async function cetusPriceUsd(_info: TokenInfoLite): Promise<number | null> {
  return null;
}

// base-unit bigint -> display string at `decimals`, trailing zeros trimmed. Kept string-exact (no float) so a
// large 9dp balance never loses precision.
export function formatUnits(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  const s = frac ? `${whole}.${frac}` : whole.toString();
  return neg ? `-${s}` : s;
}

// display string at `decimals` -> base-unit bigint, exact (no float). Throws on a malformed amount.
export function parseUnits(display: string | number, decimals: number): bigint {
  const s = String(display).replace(/,/g, '').trim();
  if (!s || !/^\d*\.?\d*$/.test(s) || s === '.') throw new Error('invalid amount');
  const [whole = '0', frac = ''] = s.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
}

// display number of a base-unit balance (for usdValue math only; the display string above stays exact).
const toDisplayNumber = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;

// Every non-zero coin an address holds, resolved + priced, for the send picker and the balance list. Sorted:
// chip (DUSDC) first, then by usdValue desc, then symbol. Never throws; a resolve failure degrades to a monogram.
export async function listHeldCoins(address: string): Promise<HeldCoin[]> {
  let balances: Array<{ coinType: string; balance: string }> = [];
  try {
    // One page is plenty for a real wallet's coin count; paginate defensively in case of dust spam.
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const res = await suiClient.core.listBalances({ owner: address, cursor });
      balances.push(...res.balances.map((b) => ({ coinType: b.coinType, balance: b.balance })));
      if (!res.hasNextPage || !res.cursor) break;
      cursor = res.cursor;
    }
  } catch (e) {
    console.warn('[tokens] listBalances failed:', e instanceof Error ? e.message : e);
    return [];
  }

  const nonZero = balances.filter((b) => {
    try {
      return BigInt(b.balance) > 0n;
    } catch {
      return false;
    }
  });

  const coins = await Promise.all(
    nonZero.map(async (b): Promise<HeldCoin | null> => {
      const canon = normType(b.coinType);
      if (!canon) return null;
      const info = await resolveTokenInfo(canon);
      const amountRaw = BigInt(b.balance);
      const price = await priceUsdFor(info).catch(() => info.priceUsd);
      const usdValue = price != null ? toDisplayNumber(amountRaw, info.decimals) * price : null;
      return {
        coinType: canon,
        symbol: info.symbol,
        name: info.name,
        decimals: info.decimals,
        iconUrl: info.iconUrl,
        amountRaw,
        amount: formatUnits(amountRaw, info.decimals),
        priceUsd: price,
        usdValue,
        isChip: isChipType(canon),
      };
    }),
  );

  return coins
    .filter((c): c is HeldCoin => c != null)
    .sort((a, b) => {
      if (a.isChip !== b.isChip) return a.isChip ? -1 : 1;
      const av = a.usdValue ?? -1;
      const bv = b.usdValue ?? -1;
      if (av !== bv) return bv - av;
      return a.symbol.localeCompare(b.symbol);
    });
}

// The canonical types the token-worker always keeps current (SUI + the chip), since the send picker + feed
// lean on them and SUI's on-chain iconUrl is empty.
export const CURATED_CANON_TYPES: string[] = [SUI_CANON, ...(DUSDC_CANON ? [DUSDC_CANON] : [])];

// One token-worker tick: ensure the curated rows exist/are current, then refresh a bounded batch of known
// tokens (recompute price, backfill metadata that was stored as a bare fallback). Chill + best-effort, off
// the request path; a per-token failure is skipped, never thrown.
export async function syncTokens(limit: number): Promise<{ refreshed: number }> {
  for (const t of CURATED_CANON_TYPES) await resolveTokenInfo(t).catch(() => {});

  const rows = await prismaQuery.tokenInfo
    .findMany({ where: { network: NETWORK }, orderBy: { updatedAt: 'asc' }, take: limit })
    .catch(() => [] as Awaited<ReturnType<typeof prismaQuery.tokenInfo.findMany>>);

  let refreshed = 0;
  for (const row of rows) {
    try {
      let info = dbToLite(row);
      // Backfill metadata for a bare fallback (unverified, never got chain metadata): re-pull now.
      if (!row.verified && row.source == null) {
        const chain = await fetchChainMetadata(row.coinType);
        if (chain) info = mergeInfo(row.coinType, chain, curatedOverride(row.coinType));
      }
      const priceUsd = await priceUsdFor(info).catch(() => row.priceUsd);
      await prismaQuery.tokenInfo.update({
        where: { id: row.id },
        data: { symbol: info.symbol, name: info.name, decimals: info.decimals, iconUrl: info.iconUrl, priceUsd, verified: info.verified, source: info.source },
      });
      memCache.delete(row.coinType); // serve the fresh price/logo on the next read
      refreshed++;
    } catch {
      // one token failed to refresh; the next tick retries it
    }
  }
  return { refreshed };
}
