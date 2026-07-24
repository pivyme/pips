// The WalletTx ledger: the chain scan + idempotent upsert (shared by the indexer worker and on-demand
// /wallet/sync), the inline writer for movements we sign (faucet/grant/send), and the DTO mappers. Kept
// dependency-light (no service imports) so auth.ts + wallet.ts + the workers can all use it without a cycle.
//
// Invariants (§12a): the ledger is DISPLAY-ONLY (I1 balance stays a live chain read, never ledger-derived);
// rows come only from validator balanceChanges + our own signed digests, never client input (I2); the
// [userId, digest, coinType] upsert is idempotent so over-scanning always converges (I3); zero-net changes
// are skipped (I4); and Play-internal churn is excluded by the Play-digest skip-set (I5).

import { normalizeSuiAddress } from '@mysten/sui/utils';

import type { WalletTx, Deposit } from '../../../prisma/generated/client.js';
import { prismaQuery } from '../prisma.ts';
import { SUI_NETWORK, WALLET_INDEX_MAX_PAGES } from '../../config/main-config.ts';
import { explorerTxUrl } from './client.ts';
import { normType, resolveTokenInfo, formatUnits, type TokenInfoLite } from './tokens.ts';
import { scanAddressTxs } from './wallet-history.ts';
import type { WalletTxDTO } from '../../types/api.ts';

type Kind = WalletTxDTO['kind'];

// GraphQL tx-history is the public Mysten schema, served only on testnet/mainnet. Localnet/devnet have no
// compatible endpoint, so the whole ledger scan is a no-op there (the balance still live-reads the chain).
export const WALLET_REAL_NETWORK = SUI_NETWORK === 'testnet' || SUI_NETWORK === 'mainnet';

// A user shape the scan needs; keep it minimal so callers can pass a partial select.
export type SyncUser = { id: string; address: string; walletSyncCheckpoint: bigint | null };

export interface SyncOutcome {
  received: WalletTxDTO[]; // celebration-eligible incoming rows (verified coins) seen this scan
  scanned: boolean; // the scan actually ran (real network, reached the chain)
}

// Digests of a user's Play rows among a candidate set: a play's mint/redeem/settle move DUSDC between the
// wallet and the AccountWrapper, which read as sends/receives on chain, so they must never leak into the feed.
async function playDigestSkipSet(userId: string, digests: string[]): Promise<Set<string>> {
  if (digests.length === 0) return new Set();
  const plays = await prismaQuery.play.findMany({
    where: { userId, OR: [{ txMint: { in: digests } }, { txRedeem: { in: digests } }, { txSettle: { in: digests } }] },
    select: { txMint: true, txRedeem: true, txSettle: true },
  });
  const skip = new Set<string>();
  for (const p of plays) for (const d of [p.txMint, p.txRedeem, p.txSettle]) if (d) skip.add(d);
  return skip;
}

// Per-user in-flight coalescer so the cron worker and an on-demand sync collapse to one scan (§12c). Only
// coalesces the normal (from-hwm) scan; a reconcile passes an explicit fromCheckpoint and runs on its own.
const inflight = new Map<string, Promise<SyncOutcome>>();

// Scan an address forward from its high-water mark, skip Play churn, upsert the survivors, advance the
// checkpoint. Returns the verified incoming rows seen this scan (for the deposit celebration). Idempotent.
export function syncUserWallet(user: SyncUser, opts: { maxPages?: number; fromCheckpoint?: bigint } = {}): Promise<SyncOutcome> {
  if (opts.fromCheckpoint != null) return runSync(user, opts); // reconcile: not coalesced (different range)
  const existing = inflight.get(user.id);
  if (existing) return existing;
  const p = runSync(user, opts).finally(() => {
    if (inflight.get(user.id) === p) inflight.delete(user.id);
  });
  inflight.set(user.id, p);
  return p;
}

async function runSync(user: SyncUser, opts: { maxPages?: number; fromCheckpoint?: bigint }): Promise<SyncOutcome> {
  if (!WALLET_REAL_NETWORK) return { received: [], scanned: false };
  const from = opts.fromCheckpoint ?? user.walletSyncCheckpoint ?? 0n;
  const scan = await scanAddressTxs(user.address, from, opts.maxPages ?? WALLET_INDEX_MAX_PAGES);
  const received: WalletTxDTO[] = [];

  if (scan.rows.length > 0) {
    const digests = [...new Set(scan.rows.map((r) => r.digest))];
    const skip = await playDigestSkipSet(user.id, digests);
    const addr = normalizeSuiAddress(user.address);
    for (const row of scan.rows) {
      if (skip.has(row.digest)) continue; // internal play churn (I5)
      const info = await resolveTokenInfo(row.coinType);
      const direction: 'in' | 'out' = row.amount > 0n ? 'in' : 'out';
      const isSend = row.sender != null && normalizeSuiAddress(row.sender) === addr;
      const kind: Kind = direction === 'out' || isSend ? 'send' : 'receive';
      const magnitude = row.amount < 0n ? -row.amount : row.amount;
      const saved = await prismaQuery.walletTx
        .upsert({
          where: { userId_digest_coinType: { userId: user.id, digest: row.digest, coinType: row.coinType } },
          create: {
            userId: user.id,
            address: user.address,
            direction,
            kind,
            coinType: row.coinType,
            symbol: info.symbol,
            decimals: info.decimals,
            amount: magnitude,
            counterparty: row.sender ?? null,
            digest: row.digest,
            chain: 'sui',
            status: 'confirmed',
            timestampMs: row.timestampMs,
          },
          // Fill/refresh metadata only. Never touch direction/kind/amount: chain truth (or an inline label
          // from the writer that signed it) already set them, and the inline writer is authoritative on kind.
          update: { symbol: info.symbol, decimals: info.decimals },
        })
        .catch(() => null);
      // Celebration-eligible = an incoming, verified coin (§12d): a scam airdrop of an unknown token still
      // lands in the feed but never pops a "deposited" popup.
      if (saved && direction === 'in' && info.verified) received.push(toWalletTxDTO(saved, info));
    }
  }

  // Advance only when the scan reached the chain (§8: on failure advance nothing so the next tick retries).
  if (scan.ok) {
    await prismaQuery.user
      .update({ where: { id: user.id }, data: { walletSyncCheckpoint: scan.maxCheckpoint, walletSyncedAt: new Date() } })
      .catch(() => {});
  }
  return { received, scanned: true };
}

// Inline ledger write for a movement we signed (faucet/grant/send): an instant feed row, before the indexer
// gets there. Idempotent on [userId, digest, coinType]; the inline writer KNOWS the true kind, so it sets
// direction+kind on update too, correcting a plain 'receive'/'send' the indexer may have created first.
export async function recordWalletTx(params: {
  userId: string;
  address: string;
  direction: 'in' | 'out';
  kind: Kind;
  coinType: string;
  amountRaw: bigint;
  digest: string;
  counterparty?: string | null;
  chain?: string;
  status?: 'confirmed' | 'pending';
  timestampMs?: bigint;
}): Promise<void> {
  const canon = normType(params.coinType) ?? params.coinType;
  const info = await resolveTokenInfo(canon).catch(() => null);
  const magnitude = params.amountRaw < 0n ? -params.amountRaw : params.amountRaw;
  try {
    await prismaQuery.walletTx.upsert({
      where: { userId_digest_coinType: { userId: params.userId, digest: params.digest, coinType: canon } },
      create: {
        userId: params.userId,
        address: params.address,
        direction: params.direction,
        kind: params.kind,
        coinType: canon,
        symbol: info?.symbol ?? null,
        decimals: info?.decimals ?? 9,
        amount: magnitude,
        counterparty: params.counterparty ?? null,
        digest: params.digest,
        chain: params.chain ?? 'sui',
        status: params.status ?? 'confirmed',
        timestampMs: params.timestampMs ?? BigInt(Date.now()),
      },
      update: { direction: params.direction, kind: params.kind, ...(info ? { symbol: info.symbol, decimals: info.decimals } : {}) },
    });
  } catch (e) {
    // A ledger write is display-only (I1); never fail the money movement that triggered it.
    console.warn('[wallet-ledger] recordWalletTx failed:', e instanceof Error ? e.message : e);
  }
}

// Map a WalletTx row to the wire DTO. `info` (a fresh TokenInfo resolve) supplies the current logo/symbol so
// a token that only later learns its real art renders correctly with no backfill write (§12b); falls back to
// the row's snapshot.
export function toWalletTxDTO(row: WalletTx, info?: TokenInfoLite | null): WalletTxDTO {
  return {
    id: row.id,
    direction: row.direction === 'out' ? 'out' : 'in',
    kind: row.kind as Kind,
    coinType: row.coinType,
    symbol: info?.symbol ?? row.symbol,
    logo: info?.iconUrl ?? null,
    amount: formatUnits(row.amount, row.decimals),
    decimals: row.decimals,
    counterparty: row.counterparty,
    digest: row.digest,
    chain: row.chain,
    status: row.status === 'pending' ? 'pending' : 'confirmed',
    timestampMs: row.timestampMs.toString(),
    explorerUrl: explorerTxUrl(row.digest),
  };
}

// Map an in-flight (non-DONE) bridge Deposit to a feed row: it shows the origin chain ("Base -> Sui" on the
// client) and stays 'pending' until the Sui-side receive is indexed and the Deposit flips DONE (dedup by
// status, §5). The source txHash isn't a Sui digest, so no explorer link.
export function depositToWalletTxDTO(d: Deposit): WalletTxDTO {
  return {
    id: `deposit-${d.id}`,
    direction: 'in',
    kind: 'bridge',
    coinType: '',
    symbol: 'USDC',
    logo: null,
    amount: d.toAmount ?? d.fromAmount,
    decimals: 6,
    counterparty: null,
    digest: d.txHash ?? '',
    chain: d.fromChain,
    status: 'pending',
    timestampMs: BigInt(d.createdAt.getTime()).toString(),
    explorerUrl: '',
  };
}
